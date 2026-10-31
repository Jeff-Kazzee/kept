// Sprint 20 (0022): "Put the Monday appointment on my Google Calendar."
// fell back to the fixed sentence in 3 of 4 recorded takes, after the event
// was added. The live repro on 52ab27c: every first answer said the event
// was added "as tentative", the status calendar_sync_slot returns, and the
// state check refused "tentative" as a status word it could not map. The
// retry then failed the same way, or dropped the calendar from the answer.
// These tests hold the live answers, the strict cases around them, the
// copied history note and the neighbouring Undo and put-back steps.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_INSTRUCTIONS, answerText, retryMessage } from "../src/agent/agent.ts";
import { checkAnswer, type Fact, type Grounds } from "../src/agent/grounding.ts";
import { UNGROUNDED_TEXT } from "../src/agent/types.ts";
import { CaseService } from "../src/case/service.ts";
import { calendarCaseMark } from "../src/google/case-mark.ts";
import { GoogleCalendar } from "../src/google/calendar.ts";
import { GoogleConnection } from "../src/google/connection.ts";
import { GoogleCalendarEvents } from "../src/google/events.ts";
import { Gmail } from "../src/google/gmail.ts";
import type { GoogleServices } from "../src/google/tools.ts";
import { IntakeService } from "../src/intake/service.ts";
import { SecretsStore } from "../src/model/providers/secrets.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { CLOCK, RuleModel, agentFor, fnCall, message, reply, say, sequence, turnOutputs } from "./agent-helpers.ts";
import { FAKE_CLIENT, FakeGoogle } from "./google-fake.ts";
import { DEMO_ZONE, acceptMessages, useZone } from "./helpers.ts";

const MON = "2026-11-16T13:00";

// The turn's facts after the reply for Monday was approved: get_schedule's
// slots, then calendar_sync_slot's fact with the event it left.
const SCHEDULE: Fact[] = [
  { date: "2026-11-05", time: null },
  { date: "2026-11-10", time: "14:00", state: "offered" },
  { date: "2026-11-12", time: "10:30", state: "change_proposed" },
  { date: "2026-11-13", time: "09:15", state: "offered" },
  { date: "2026-11-16", time: "13:00", state: "requested" },
];
const synced = (event: Fact["event"]): Fact => ({ date: "2026-11-16", time: "13:00", state: "requested", event });
const grounds = (facts: Fact[], done: string[] = ["calendar_event_added"]): Grounds => ({
  facts,
  statuses: new Set(["claim:accepted"]),
  today: "2026-11-05",
  scheduleRead: true,
  done: new Set(done),
});
const ADDED = grounds([...SCHEDULE, synced("tentative")]);

// The first answers of the live repro on 52ab27c, each refused with
// state_mismatch, and the retries refused after them.
const LIVE_REFUSED = [
  "Put Monday 11/16 1:00 PM on your Google Calendar as tentative. You can undo it in the activity list.",
  "I added Monday 11/16 1:00 PM to your calendar as tentative.",
  "I put Monday 11/16 1:00 PM on your Google Calendar as tentative.",
  "I put Monday 11/16 1:00 PM on your calendar as tentative.",
  "Put Monday 11/16 1:00 PM on your calendar as tentative. You can undo it in the activity list.",
  "Monday 11/16 1:00 PM is requested. Its calendar event is tentative.",
  "Monday 11/16 1:00 PM is requested. Friday 11/13 9:15 AM is offered. The Google Calendar event for Monday 11/16 1:00 PM is tentative.",
];

describe("sprint 20: the calendar-add answer", () => {
  it("passes the true answers the live model gave after calendar_sync_slot", () => {
    for (const text of [
      ...LIVE_REFUSED,
      "I added Monday 11/16 1:00 PM to your Google Calendar as tentative. It stays requested until the office confirms.",
      "I added a tentative event for Monday 11/16 1:00 PM.",
      "Monday 11/16 1:00 PM is now on the calendar, marked tentative until the office confirms.",
      "Monday 11/16 1:00 PM is tentatively on your calendar.",
    ]) {
      expect(checkAnswer(text, ADDED), text).toEqual([]);
    }
  });

  it("still refuses a wrong time, a wrong state or a calendar claim the turn does not hold", () => {
    const cases: Array<[string, Grounds, string[]]> = [
      // A time the case does not hold.
      ["I added Monday 11/16 2:00 PM to your Google Calendar as tentative.", ADDED, ["ungrounded", "state_mismatch"]],
      // Monday is requested, so neither it nor its event is confirmed.
      ["Monday 11/16 1:00 PM is confirmed on your Google Calendar.", ADDED, ["state_mismatch"]],
      ["Monday 11/16 1:00 PM is not tentative.", ADDED, ["state_mismatch"]],
      // An offered slot gets no event, so it is not tentative.
      ["Friday 11/13 9:15 AM is tentative.", ADDED, ["state_mismatch"]],
      // A confirmed slot's event is confirmed, not tentative.
      ["Monday 11/16 1:00 PM is tentative.", grounds([{ date: "2026-11-16", time: "13:00", state: "confirmed", event: "confirmed" }]), ["state_mismatch"]],
      // "On the calendar" with no event from this turn.
      ["Monday 11/16 1:00 PM is on the calendar.", grounds(SCHEDULE, []), ["state_mismatch"]],
      // The turn's last write removed the event.
      ["Monday 11/16 1:00 PM is still on the calendar.", grounds([...SCHEDULE, synced("tentative"), synced(null)]), ["state_mismatch"]],
      // A status word code cannot map still fails closed.
      ["Monday 11/16 1:00 PM is penciled in.", ADDED, ["state_mismatch"]],
      // Saying it added the event when no calendar write happened, with or
      // without a subject, as the live model often writes.
      ["I added Monday 11/16 1:00 PM to your Google Calendar as tentative.", grounds(SCHEDULE, []), ["claims_action"]],
      ["Added Monday 11/16 1:00 PM to your calendar as tentative.", grounds(SCHEDULE, []), ["claims_action"]],
      ["Done. Put Monday 11/16 1:00 PM back on your calendar.", grounds(SCHEDULE, []), ["claims_action"]],
      ["Undid adding Monday 11/16 1:00 PM to your calendar.", grounds(SCHEDULE, ["calendar_event_added"]), ["claims_action"]],
    ];
    for (const [text, g, problems] of cases) expect(checkAnswer(text, g), text).toEqual(problems);
  });

  it("reads a sentence that opens with an action verb as the assistant's report, and leaves state words alone", () => {
    const done = (...kinds: string[]) => grounds(SCHEDULE, kinds);
    expect(checkAnswer("Added Monday 11/16 1:00 PM to your calendar as tentative.", done("calendar_event_added"))).toEqual([]);
    expect(checkAnswer("Undid adding Monday 11/16 1:00 PM to your calendar.", done("undo"))).toEqual([]);
    // The first step's live answer.
    expect(
      checkAnswer(
        "Imported the office's two emails.\nAccepted claims changed Thursday 11/12 10:30 AM and offered Friday 11/13 9:15 AM and Monday 11/16 1:00 PM.",
        done("gmail_message_imported", "claim_accepted"),
      ),
    ).toEqual([]);
    // No tool confirms, so a sentence that opens with "Confirmed" names a
    // state, checked as one.
    expect(checkAnswer("Confirmed: nothing yet. Monday 11/16 1:00 PM is requested.", done())).toEqual([]);
    expect(checkAnswer("Monday 11/16 1:00 PM was added by the office.", done())).toEqual([]);
  });

  it("passes a true statement that the event is gone, or there", () => {
    const removed = grounds([...SCHEDULE, synced("tentative"), synced(null)], ["calendar_event_added", "calendar_event_removed"]);
    expect(checkAnswer("Monday 11/16 1:00 PM is no longer on the calendar.", removed)).toEqual([]);
    expect(checkAnswer("Monday 11/16 1:00 PM is on the calendar.", ADDED)).toEqual([]);
  });

  it("the retry hint names the event's states as the tools give them", () => {
    expect(JSON.stringify(retryMessage(["state_mismatch"]))).toContain("its Google Calendar event as tentative or confirmed");
  });

  it("removes a history note the model copied, and keeps every other word", () => {
    const out = (text: string) => answerText([message(text)]);
    expect(out("Put Monday 11/16 1:00 PM back on your calendar as tentative. You can undo this in the activity list. (Actions taken, by activity id: a10. get_activity shows them.)")).toBe(
      "Put Monday 11/16 1:00 PM back on your calendar as tentative. You can undo this in the activity list.",
    );
    expect(out("I added Monday 11/16 1:00 PM to your calendar as tentative.\n(Action taken, by activity id: a7. get_activity shows it.)")).toBe(
      "I added Monday 11/16 1:00 PM to your calendar as tentative.",
    );
    expect(out("(Cards shown: reply draft d1 for readback.) Monday 11/16 1:00 PM is requested.")).toBe("Monday 11/16 1:00 PM is requested.");
    // Other parentheses stay.
    expect(out("Monday 11/16 1:00 PM (the office's offer) is requested.")).toBe("Monday 11/16 1:00 PM (the office's offer) is requested.");
  });

  it("asks the model to name a clashing event by its summary", () => {
    expect(AGENT_INSTRUCTIONS).toContain("When a time clashes with a calendar event, name the event by its summary and give its start as the tools label it.");
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The demo case after m1 to m3 with Google connected, and the reply
// accepting Monday approved, so Monday is requested.
async function requestedMonday() {
  const dir = mkdtempSync(path.join(tmpdir(), "sp20-"));
  dirs.push(dir);
  const fake = new FakeGoogle();
  const connection = new GoogleConnection({ client: FAKE_CLIENT, store: new SecretsStore(path.join(dir, "app-secrets.sqlite")), fetch: fake.fetch, now: () => fake.now });
  const flow = connection.startConnect({ expectedVersion: 0, features: { gmail: true, calendar: true }, calendarId: "primary", redirectUri: "http://127.0.0.1:5192/auth/google/callback" });
  const back = fake.consent(flow.authorizeUrl);
  await connection.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null, cookie: flow.cookie });
  const store = new EventStore(":memory:", CLOCK);
  useZone(store, DEMO_ZONE);
  const client = RecordedModelClient.fromDirectory();
  const intake = new IntakeService(store, client, { now: CLOCK });
  let events: GoogleCalendarEvents | null = null;
  const kase = new CaseService(store, intake, client, { now: CLOCK, externalCalendar: () => events?.snapshot() ?? null });
  const calendar = new GoogleCalendar(connection, { timeZone: () => kase.timeZone(), caseMark: (o) => calendarCaseMark(store, o) });
  events = new GoogleCalendarEvents(calendar, { now: () => fake.now });
  const google: GoogleServices = { connection, gmail: new Gmail(connection), calendar, events };
  const app = { store, intake, kase, reply: new ReplyService(store, kase, client, { now: CLOCK }), records: new RecordsService(store, intake, kase), google };
  await acceptMessages(app.intake, ["m1", "m2", "m3"]);
  const started = app.reply.start("accept_offer", MON, app.kase.view().reply.version);
  const draft = started.reply.draft!;
  app.reply.approve(draft.id, draft.fields.map((f) => f.name), started.reply.version);
  expect(app.kase.view().slots.find((s) => s.key === MON)!.state).toBe("requested");
  return { fake, app };
}

describe("sprint 20: the calendar steps through the agent loop", () => {
  it("adds the event and shows the live answer, with the slot's label and state in the tool result and no copied note", async () => {
    const { fake, app } = await requestedMonday();
    const model = sequence(
      reply(fnCall("calendar_sync_slot", { slot_key: MON, restore_removed: null })),
      reply(message("I added Monday 11/16 1:00 PM to your calendar as tentative.\n(Actions taken, by activity id: a7. get_activity shows them.)")),
    );
    const r = await say(agentFor(app, model), app, "Put the Monday appointment on my Google Calendar.");
    expect([r.report.outcome, r.report.problems, r.report.rejected]).toEqual(["answered", [[]], []]);
    expect(r.text).toBe("I added Monday 11/16 1:00 PM to your calendar as tentative.");
    const out = turnOutputs(model.calls[1]!.body.input).find((o) => o.name === "calendar_sync_slot")!.output;
    expect(out).toMatchObject({ slot_key: MON, slot_label: "Monday 11/16 1:00 PM", slot_state: "requested", action: "created", event_status: "tentative" });
    expect([...fake.calendars.get("primary")!.values()].map((e) => e.status)).toEqual(["tentative"]);
  });

  it("still falls back when the answer gives the requested slot a state it does not hold", async () => {
    const { app } = await requestedMonday();
    const wrong = "Monday 11/16 1:00 PM is confirmed on your Google Calendar.";
    const model = sequence(reply(fnCall("calendar_sync_slot", { slot_key: MON, restore_removed: null })), reply(message(wrong)), reply(message(wrong)));
    const r = await say(agentFor(app, model), app, "Put the Monday appointment on my Google Calendar.");
    expect([r.report.outcome, r.text]).toEqual(["ungrounded", UNGROUNDED_TEXT]);
    expect(r.report.problems).toEqual([["state_mismatch"], ["state_mismatch"]]);
  });

  it("Undo of the event and putting it back answer as the live model did", async () => {
    const { fake, app } = await requestedMonday();
    // The live answers of the neighbouring steps.
    const model = new RuleModel([
      (input) => {
        const last = turnOutputs(input).at(-1);
        const text = [...input].reverse().find((i) => (i as { role?: string }).role === "user") as { content: string };
        // The person asked to put the event back, so restore_removed is set.
        if (!last) return /Undo/.test(text.content) ? [fnCall("get_activity", { limit: null })] : [fnCall("calendar_sync_slot", { slot_key: MON, restore_removed: /back/.test(text.content) })];
        if (last.name === "get_activity") {
          const added = last.output.entries.find((e: { kind: string; undone: boolean }) => e.kind === "calendar_event_added" && !e.undone);
          return [fnCall("undo", { activity_id: added.activity_id, expected_version: last.output.activity_version })];
        }
        if (last.name === "undo") return [message("Undid adding Monday 11/16 1:00 PM to your calendar. It is no longer on the calendar.")];
        if (/back/.test(text.content)) return [message("Put Monday 11/16 1:00 PM back on your calendar as tentative. You can undo this in the activity list.")];
        return [message("Added Monday 11/16 1:00 PM to your calendar as tentative. You can undo this in the activity list.")];
      },
    ]);
    const agent = agentFor(app, model);
    const added = await say(agent, app, "Put the Monday appointment on my Google Calendar.");
    const undone = await say(agent, app, "Undo adding it to my calendar.");
    expect([undone.report.outcome, undone.report.problems, undone.report.tools.map((t) => t.code)]).toEqual(["answered", [[]], ["ok", "ok"]]);
    expect([...fake.calendars.get("primary")!.values()].map((e) => e.status)).toEqual(["cancelled"]);
    const back = await say(agent, app, "Put it back on my calendar.");
    for (const r of [added, back]) expect([r.report.outcome, r.report.problems]).toEqual(["answered", [[]]]);
    expect(back.text).toBe("Put Monday 11/16 1:00 PM back on your calendar as tentative. You can undo this in the activity list.");
    expect(back.report.tools.map((t) => [t.tool, t.code])).toEqual([["calendar_sync_slot", "ok"]]);
    expect([...fake.calendars.get("primary")!.values()].map((e) => e.status)).toEqual(["tentative"]);
  });

  it("refuses a put-back answer when the event was not put back", async () => {
    const { app } = await requestedMonday();
    const model = sequence(reply(fnCall("calendar_sync_slot", { slot_key: MON, restore_removed: null })), reply(message("Added Monday 11/16 1:00 PM to your calendar as tentative.")));
    expect((await say(agentFor(app, model), app, "Put the Monday appointment on my Google Calendar.")).report.outcome).toBe("answered");
    // Undo removes the app's event, and the next sync without
    // restore_removed adds nothing, yet the answer says it was put back.
    const undo = new RuleModel([
      (input) => {
        const last = turnOutputs(input).at(-1);
        if (!last) return [fnCall("get_activity", { limit: null })];
        if (last.name === "get_activity") {
          const added = last.output.entries.find((e: { kind: string }) => e.kind === "calendar_event_added");
          return [fnCall("undo", { activity_id: added.activity_id, expected_version: last.output.activity_version })];
        }
        return [message("Undid adding Monday 11/16 1:00 PM to your calendar.")];
      },
    ]);
    expect((await say(agentFor(app, undo, { newTurnId: () => "u1" }), app, "Undo adding it to my calendar.")).report.outcome).toBe("answered");
    const claimed = "Put Monday 11/16 1:00 PM back on your calendar as tentative.";
    const back = sequence(reply(fnCall("calendar_sync_slot", { slot_key: MON, restore_removed: null })), reply(message(claimed)), reply(message(claimed)));
    const r = await say(agentFor(app, back, { newTurnId: () => "b1" }), app, "Put it back on my calendar.");
    expect(r.report.tools.map((t) => [t.tool, t.code])).toEqual([["calendar_sync_slot", "google_changed"]]);
    expect([r.report.outcome, r.report.problems]).toEqual(["ungrounded", [["claims_action"], ["claims_action"]]]);
  });
});
