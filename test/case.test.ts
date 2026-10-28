import { describe, expect, it } from "vitest";
import { CaseService } from "../src/case/service.ts";
import { readFixtureText } from "../src/fixtures/load.ts";
import { IntakeService, InvalidRequestError } from "../src/intake/service.ts";
import { RecordedModelClient, readRecording, type Recording } from "../src/model/recorded.ts";
import { fromPackage } from "../src/paths.ts";
import { EventStore, StaleEditError } from "../src/store/event-log.ts";
import { acceptMessages, intake, useZone } from "./helpers.ts";

const NOW = "2026-11-05T09:00:00.000Z";
const fault = (name: string) => readRecording(fromPackage(`fixtures/recordings/faults/${name}.json`));

async function setup(ids: string[], client = RecordedModelClient.withOverrides([], RecordedModelClient.fromDirectory()), base?: IntakeService) {
  const store = new EventStore();
  useZone(store);
  const service = base ?? intake(store);
  await acceptMessages(service, ids);
  const kase = new CaseService(store, service, client, { now: () => NOW });
  return { store, intake: service, kase, client };
}

const states = (kase: CaseService) => kase.view().slots.map((s) => [s.key, s.stateLabel]);

describe("calendar", () => {
  it("stores the calendar with a version and shows clashes", async () => {
    const { kase, store } = await setup(["m1", "m2", "m3"]);
    expect(kase.view().slots.find((s) => s.key === "2026-11-13T09:15")!.clashes).toBeNull();
    const view = kase.loadCalendar("dana.ics", readFixtureText("calendar/dana.ics"), 0);
    expect(view).toMatchObject({ calendarVersion: 1, calendar: { name: "dana.ics", timeZone: "America/Denver", assumedSlotMinutes: 60 } });
    expect(view.calendar!.events).toHaveLength(6);
    expect(view.slots.find((s) => s.key === "2026-11-13T09:15")!.clashes!.map((c) => c.summary)).toEqual(["Team meeting"]);
    expect(() => kase.loadCalendar("dana.ics", readFixtureText("calendar/dana.ics"), 0)).toThrow(StaleEditError);
    expect(() => kase.loadCalendar("bad.ics", "not a calendar", 1)).toThrow(InvalidRequestError);
    expect(store.readStream("calendar")).toHaveLength(1);
  });
});

describe("SP2.11 question queue", () => {
  it("demo: asks one question about the change proposal, through the recorded model", async () => {
    const { kase, store } = await setup(["m1", "m2", "m3"]);
    expect(kase.view()).toMatchObject({ question: null, waiting: 1, questionsVersion: 0 });
    const before = states(kase);
    const view = await kase.askNext(0);
    expect(view.question).toMatchObject({
      id: "q1",
      conflictId: "change-proposed-20261112-1030",
      origin: "model",
      text: "The office needs to move your Thursday 11/12 10:30 AM visit. Which new time do you want to request?",
      citedEvidenceIds: ["m3-e1", "m3-e2", "m3-e3"],
      choices: [
        { id: "request:2026-11-13T09:15", label: "Request Friday 11/13 9:15 AM" },
        { id: "request:2026-11-16T13:00", label: "Request Monday 11/16 1:00 PM" },
        { id: "unsure", label: "Not sure yet" },
      ],
    });
    expect(view.conflicts.map((c) => c.status)).toEqual(["asked"]);
    expect(view.waiting).toBe(0);
    // Model output changes no slot.
    expect(states(kase)).toEqual(before);
    expect(store.readStream("questions").map((e) => e.type)).toEqual(["question_asked"]);
  });

  it("opens only one question at a time", async () => {
    const { kase } = await setup(["m2", "s5-report", "s6-reminder"]);
    await kase.askNext(0);
    await expect(kase.askNext(1)).rejects.toThrow(/still open/);
    await expect(kase.askNext(0)).rejects.toBeInstanceOf(StaleEditError);
  });

  it("checks the version before calling the model", async () => {
    const { kase, client } = await setup(["m1", "m2", "m3"]);
    await expect(kase.askNext(3)).rejects.toBeInstanceOf(StaleEditError);
    expect(client.calls).toHaveLength(0);
  });

  it("S3 (W30): choosing a replacement opens an accept draft and changes no slot", async () => {
    const { kase, intake: service, store } = await setup(["m2", "m3"]);
    await kase.askNext(0);
    const before = kase.view().slots;
    expect(() => kase.answer("q1", "request:2026-11-16T13:00", 1)).toThrow(/expected version of the reply stream/);
    const view = kase.answer("q1", "request:2026-11-16T13:00", 1, 0);
    expect(view.slots).toEqual(before);
    expect(view).toMatchObject({ question: null, waiting: 0, questionsVersion: 2 });
    expect(view.conflicts.map((c) => [c.id, c.status, c.answer?.label])).toEqual([
      ["change-proposed-20261112-1030", "answered", "Request Monday 11/16 1:00 PM"],
    ]);
    expect(view.reply.draft).toMatchObject({ id: "d1", template: "accept_offer", slotKey: "2026-11-16T13:00", origin: "choice", questionId: "q1", valid: true });
    // The tap records no evidence. The request waits for the approval of the reply.
    expect(service.evidence().filter((e) => e.origin === "answer")).toEqual([]);
    expect(store.readStream("questions").map((e) => e.type)).toEqual(["question_asked", "question_answered"]);
    expect(store.readStream("reply").map((e) => e.type)).toEqual(["reply_drafted"]);
    await expect(kase.askNext(2)).rejects.toThrow(/No conflict waits/);

    await acceptMessages(service, ["m4"]);
    expect(states(kase)).toEqual([
      ["2026-11-12T10:30", "Canceled · office message"],
      ["2026-11-13T09:15", "Offered · office message"],
      ["2026-11-16T13:00", "Confirmed · office message"],
    ]);
    expect(kase.view().conflicts).toEqual([]);
  });

  it("S4: answering which one stands cancels the other as reported by you", async () => {
    const { kase } = await setup(["m2", "m3", "s4-confirm"]);
    const asked = await kase.askNext(0);
    expect(asked.question).toMatchObject({ conflictKind: "both_held", text: "The office confirmed both Thursday 11/12 at 10:30 AM and Monday 11/16 at 1:00 PM. Which one stands?" });
    const view = kase.answer("q1", "stands:2026-11-16T13:00", 1);
    expect(view.slots.map((s) => [s.key, s.stateLabel])).toEqual([
      ["2026-11-12T10:30", "Canceled · reported by you"],
      ["2026-11-13T09:15", "Offered · office message"],
      ["2026-11-16T13:00", "Confirmed · office message"],
    ]);
    expect(view.conflicts).toEqual([]);
  });

  it("S6: asks about the possibly stale reminder once and changes no state", async () => {
    const { kase } = await setup(["m2", "s5-report", "s6-reminder"]);
    const before = states(kase);
    const first = await kase.askNext(0);
    expect(first.question).toMatchObject({ conflictKind: "possibly_stale", origin: "model" });
    expect(first.waiting).toBe(1);
    const answered = kase.answer("q1", "ignore", 1);
    expect(states(kase)).toEqual(before);
    expect(answered.staleEvidenceIds).toEqual(["s6-reminder-e1"]);
    expect(answered.conflicts.map((c) => [c.kind, c.status])).toEqual([
      ["possibly_stale", "answered"],
      ["incomplete_slot", "open"],
    ]);
    const second = await kase.askNext(2);
    expect(second.question).toMatchObject({ id: "q2", conflictKind: "incomplete_slot" });
    kase.answer("q2", "unsure", 3);
    expect(kase.view()).toMatchObject({ question: null, waiting: 0 });
    expect(states(kase)).toEqual(before);
  });

  it("S6: 'still stands' is a user report that holds Thursday again, and then both are held", async () => {
    const { kase } = await setup(["m2", "s5-report", "s6-reminder"]);
    await kase.askNext(0);
    const view = kase.answer("q1", "still-stands", 1);
    expect(view.slots.map((s) => [s.key, s.stateLabel])).toEqual([
      ["2026-11-12T10:30", "Confirmed · reported by you"],
      ["2026-11-16T13:00", "Confirmed · reported by you"],
    ]);
    expect(view.conflicts.map((c) => [c.kind, c.status])).toEqual([
      ["both_held", "open"],
      ["incomplete_slot", "open"],
    ]);
  });

  it("D-f: a pasted report that says only 'Monday' asks which Monday", async () => {
    const report = {
      id: "call-1",
      channel: "user_report" as const,
      from: "Dana Reyes",
      received_at: "2026-11-05T12:10:00-07:00",
      text: "I called the clinic. They moved me to Monday at 1:00 PM.",
    };
    const recording: Recording = {
      message_id: "call-1",
      effort: "any",
      attempts: [
        {
          output: {
            claims: [
              { claim_type: "confirm", date: "2026-11-16", time: "13:00", location: null, quote: "They moved me to Monday at 1:00 PM", sender_kind: "person", event_time: null, request_item: null },
            ],
          },
          usage: { input: 1, cached_input: 0, output: 1, reasoning: 0 },
          latency_ms: 1,
        },
      ],
    };
    const store = new EventStore();
    const service = new IntakeService(store, RecordedModelClient.withOverrides([recording]), { now: () => NOW });
    service.importMessage(report);
    const { evidence } = await service.extract("call-1", { effort: "low", expectedVersion: 1 });
    service.accept(evidence[0]!.id, 1);
    const kase = new CaseService(store, service, RecordedModelClient.withOverrides([]), { now: () => NOW });
    expect(kase.view().slots).toEqual([]);
    const asked = await kase.askNext(0);
    expect(asked.question).toMatchObject({
      conflictKind: "ambiguous_date",
      origin: "fixed",
      text: "A message could mean Monday 11/9 1:00 PM or Monday 11/16 1:00 PM. Which one does it mean?",
    });
    const view = kase.answer("q1", "means:2026-11-16T13:00", 1);
    expect(view.slots.map((s) => [s.key, s.stateLabel])).toEqual([["2026-11-16T13:00", "Confirmed · reported by you"]]);
    expect(view.conflicts.map((c) => c.kind)).toEqual(["incomplete_slot"]);
  });

  it("withdraws an open question whose conflict changed, then asks the next one", async () => {
    const { kase, intake: service, store } = await setup(["m2", "m3"]);
    await kase.askNext(0);
    await acceptMessages(service, ["s4-confirm"]);
    const view = kase.view();
    expect(view.question).toBeNull();
    expect(view.conflicts.map((c) => [c.kind, c.status])).toEqual([["both_held", "open"]]);
    expect(() => kase.answer("q1", "unsure", 1)).toThrow(/not open/);
    const next = await kase.askNext(1);
    expect(next.question).toMatchObject({ id: "q2", conflictKind: "both_held" });
    expect(store.readStream("questions").map((e) => e.type)).toEqual(["question_asked", "question_withdrawn", "question_asked"]);
  });

  it("refuses an unknown choice and a stale answer, and writes nothing", async () => {
    const { kase, store } = await setup(["m2", "m3"]);
    await kase.askNext(0);
    const count = store.readAll().length;
    expect(() => kase.answer("q1", "request:2026-11-20T09:00", 1)).toThrow(/no choice/);
    expect(() => kase.answer("q1", "unsure", 0)).toThrow(StaleEditError);
    expect(store.readAll()).toHaveLength(count);
    kase.answer("q1", "unsure", 1);
    expect(() => kase.answer("q1", "unsure", 2)).toThrow(/not open/);
  });

  it("falls back to the fixed wording when the proposed question fails twice", async () => {
    const { kase } = await setup(["m1", "m2", "m3"], RecordedModelClient.withOverrides([fault("question-unknown-conflict")]));
    const view = await kase.askNext(0);
    expect(view.question).toMatchObject({
      origin: "fixed",
      text: "The office proposed to move Thursday 11/12 10:30 AM. Which time do you want instead?",
      attempts: [
        { attempt: 1, outcome: "invalid", problems: ["conflict_not_open", "evidence_not_in_conflict"] },
        { attempt: 2, outcome: "invalid", problems: ["conflict_not_open", "evidence_not_in_conflict"] },
      ],
    });
    expect(view.question!.choices.map((c) => c.id)).toEqual(["request:2026-11-13T09:15", "request:2026-11-16T13:00", "unsure"]);
  });
});

describe("explanations stored per conflict", () => {
  it("demo: stores a valid explanation with its citations and changes no state", async () => {
    const { kase, store } = await setup(["m1", "m2", "m3"]);
    const before = states(kase);
    const conflict = await kase.explain("change-proposed-20261112-1030", 0);
    expect(conflict.explanation).toMatchObject({
      outcome: "valid",
      citedEvidenceIds: ["m2-e1", "m3-e1", "m3-e2", "m3-e3"],
      model: "muse-spark-1.3",
      effort: "low",
      attempts: [{ attempt: 1, outcome: "valid", problems: [] }],
    });
    expect(conflict.version).toBe(2);
    expect(store.readStream("conflict:change-proposed-20261112-1030").map((e) => e.type)).toEqual([
      "explanation_attempted",
      "explanation_finished",
    ]);
    expect(states(kase)).toEqual(before);
    await expect(kase.explain("change-proposed-20261112-1030", 2)).rejects.toThrow(/already has an explanation/);
    await expect(kase.explain("no-such-conflict", 0)).rejects.toThrow(/No open conflict/);
  });

  it("D-b: stores an unavailable explanation after two invalid answers", async () => {
    const { kase } = await setup(["m1", "m2", "m3"], RecordedModelClient.withOverrides([fault("explain-other-conflict-id")]));
    const conflict = await kase.explain("change-proposed-20261112-1030", 0);
    expect(conflict.explanation).toMatchObject({
      outcome: "unavailable",
      text: null,
      citedEvidenceIds: [],
      attempts: [{ problems: ["evidence_not_in_conflict"] }, { problems: ["evidence_not_in_conflict"] }],
    });
    expect(conflict.evidenceIds).toEqual(["m2-e1", "m3-e1", "m3-e2", "m3-e3"]);
  });

  it("checks the version before calling the model", async () => {
    const { kase, client } = await setup(["m1", "m2", "m3"]);
    await expect(kase.explain("change-proposed-20261112-1030", 1)).rejects.toBeInstanceOf(StaleEditError);
    expect(client.calls).toHaveLength(0);
  });
});
