import { describe, expect, it } from "vitest";
import { parseIcs } from "../src/domain/ics.ts";
import { weekdayOnlyCandidates } from "../src/domain/datetime.ts";
import { readFixtureText } from "../src/fixtures/load.ts";
import type { AnswerMeta } from "../src/intake/events.ts";
import { ASSUMED_SLOT_MINUTES, findClashes, wallClockToUtc } from "../src/slots/clash.ts";
import { slotLabel, sourceLabel, stateLabel } from "../src/slots/labels.ts";
import { locationsAgree } from "../src/slots/location.ts";
import { TRANSITIONS, projectSlots } from "../src/slots/project.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, ev, intake } from "./helpers.ts";

const THU = { date: "2026-11-12", time: "10:30" };
const MON = { date: "2026-11-16", time: "13:00" };
const T1 = "2026-10-31T09:00:00-06:00";
const T2 = "2026-11-04T11:00:00-07:00";
const T3 = "2026-11-05T10:00:00-07:00";

const answer = (over: Partial<AnswerMeta> = {}): AnswerMeta => ({
  question_id: "q1",
  conflict_id: "c",
  choice_id: "x",
  clarifies: null,
  after: T3,
  ...over,
});
const user = { source_type: "reported_by_user" as const };

const project = (...evidence: Parameters<typeof projectSlots>[0]["evidence"]) => projectSlots({ evidence });
const slot = (p: ReturnType<typeof projectSlots>, key: string) => p.slots.find((s) => s.key === key);
// Conflicts other than a missing place. Most hand-built claims give no place.
const disagreements = (p: ReturnType<typeof projectSlots>) => p.conflicts.filter((c) => c.kind !== "incomplete_slot");

async function scenario(ids: string[]) {
  const service = intake(new EventStore());
  await acceptMessages(service, ids);
  return projectSlots({ evidence: service.evidence(), calendar: parseIcs(readFixtureText("calendar/dana.ics")) });
}

describe("SP2.1 slot projection from accepted evidence only", () => {
  it("ignores pending and rejected evidence", () => {
    const p = project(
      ev("a", "offer", THU.date, THU.time, T1),
      ev("b", "confirm", THU.date, THU.time, T2, { status: "pending" }),
      ev("c", "cancel", THU.date, THU.time, T3, { status: "rejected" }),
    );
    expect(p.slots.map((s) => [s.key, s.state])).toEqual([["2026-11-12T10:30", "offered"]]);
    expect(project(ev("b", "confirm", THU.date, THU.time, T2, { status: "pending" })).slots).toEqual([]);
  });

  it("reaches all six states", () => {
    const states = (evidence: Parameters<typeof project>) => project(...evidence).slots.map((s) => s.state);
    expect(states([ev("a", "offer", THU.date, THU.time, T1)])).toEqual(["offered"]);
    expect(states([ev("a", "offer", THU.date, THU.time, T1), ev("b", "request", THU.date, THU.time, T2, { ...user, origin: "answer", answer: answer() })])).toEqual(["requested"]);
    expect(states([ev("a", "confirm", THU.date, THU.time, T1)])).toEqual(["confirmed"]);
    expect(states([ev("a", "confirm", THU.date, THU.time, T1), ev("b", "move", THU.date, THU.time, T2)])).toEqual(["change_proposed"]);
    expect(states([ev("a", "confirm", THU.date, THU.time, T1), ev("b", "cancel", THU.date, THU.time, T2)])).toEqual(["canceled"]);
    expect(states([ev("a", "offer", THU.date, THU.time, T1), ev("b", "decline", THU.date, THU.time, T2, { ...user, origin: "answer", answer: answer() })])).toEqual(["declined"]);
  });

  it("ignores office requests and claims with no date", () => {
    const p = project(ev("a", "office_request", null, null, T1, { request_item: "Bring card" }), ev("b", "confirm", null, null, T1));
    expect(p.slots).toEqual([]);
    expect(p.conflicts).toEqual([]);
  });
});

describe("SP2.2 source label beside each state", () => {
  it("names the source of the evidence that set the state", () => {
    expect(sourceLabel("office_message")).toBe("office message");
    expect(sourceLabel("reported_by_user")).toBe("reported by you");
    expect(sourceLabel("reported_by_user_via_agent", "OpenCode")).toBe("reported by you through OpenCode");
    expect(sourceLabel("reported_by_user_via_agent")).toBe("reported by you through an agent");
    expect(stateLabel("confirmed", "office message")).toBe("Confirmed · office message");
    expect(stateLabel("change_proposed", "office message")).toBe("Confirmed · office message, change proposed");
  });

  it("labels a slot confirmed through an agent with the grant name", () => {
    const p = project(ev("a", "confirm", THU.date, THU.time, T1, { source_type: "reported_by_user_via_agent", agent_name: "OpenCode" }));
    expect(p.slots[0]!.stateLabel).toBe("Confirmed · reported by you through OpenCode");
  });

  it("formats slot labels in plain words", () => {
    expect(slotLabel("2026-11-12", "10:30")).toBe("Thursday 11/12 10:30 AM");
    expect(slotLabel("2026-11-16", "13:00")).toBe("Monday 11/16 1:00 PM");
    expect(slotLabel("2026-11-16", "00:05")).toBe("Monday 11/16 12:05 AM");
    expect(slotLabel("2026-11-16", "12:00")).toBe("Monday 11/16 12:00 PM");
    expect(slotLabel("2026-11-16", null)).toBe("Monday 11/16, no time");
  });
});

describe("SP2.3 rule 1: only office evidence or a user report cancels a confirmed slot", () => {
  it("has exactly one transition from confirmed to canceled, the cancel claim", () => {
    const toCanceled = Object.entries(TRANSITIONS.confirmed).filter(([, next]) => next === "canceled");
    expect(toCanceled).toEqual([["canceled", "canceled"]]);
  });

  it("keeps a confirmed slot for every claim that is not a cancel", () => {
    const confirm = ev("a", "confirm", THU.date, THU.time, T1);
    const a = { ...user, origin: "answer" as const, answer: answer() };
    for (const other of [
      ev("b", "offer", THU.date, THU.time, T2),
      ev("b", "request", THU.date, THU.time, T3, a),
      ev("b", "decline", THU.date, THU.time, T3, a),
      ev("b", "reminder", THU.date, THU.time, T2),
      ev("b", "move", THU.date, THU.time, T2),
      ev("b", "confirm", MON.date, MON.time, T2),
      ev("b", "request", MON.date, MON.time, T3, a),
    ]) {
      const s = slot(project(confirm, other), "2026-11-12T10:30")!;
      expect(["confirmed", "change_proposed"], other.claim.claim_type).toContain(s.state);
    }
  });

  it("cancels on an office cancel and on a user report", () => {
    const confirm = ev("a", "confirm", THU.date, THU.time, T1);
    expect(project(confirm, ev("b", "cancel", THU.date, THU.time, T2)).slots[0]!.stateLabel).toBe("Canceled · office message");
    expect(project(confirm, ev("b", "cancel", THU.date, THU.time, T2, user)).slots[0]!.stateLabel).toBe("Canceled · reported by you");
  });
});

describe("SP2.4 rule 2 and S3: choosing a replacement", () => {
  it("records a request on the replacement and leaves the original unchanged", () => {
    const base = [ev("m2", "confirm", THU.date, THU.time, T1), ev("m3a", "move", THU.date, THU.time, T2), ev("m3b", "offer", MON.date, MON.time, T2)];
    const before = project(...base);
    const after = project(...base, ev("ans", "request", MON.date, MON.time, T3, { ...user, origin: "answer", answer: answer({ after: T2 }) }));
    expect(slot(after, "2026-11-16T13:00")!.stateLabel).toBe("Requested · reported by you");
    expect(slot(after, "2026-11-12T10:30")).toEqual(slot(before, "2026-11-12T10:30"));
    expect(slot(after, "2026-11-12T10:30")!.stateLabel).toBe("Confirmed · office message, change proposed");
  });

  it("S3 end to end: after m4 Monday is confirmed and Thursday canceled, both by office message", async () => {
    const p = await scenario(["m2", "m3", "m4"]);
    expect(slot(p, "2026-11-16T13:00")!.stateLabel).toBe("Confirmed · office message");
    expect(slot(p, "2026-11-12T10:30")!.stateLabel).toBe("Canceled · office message");
    // m4's cancel names the date only and joins the one Thursday slot.
    expect(slot(p, "2026-11-12T10:30")!.stateEvidenceId).toBe("m4-e2");
    expect(p.conflicts).toEqual([]);
  });
});

describe("SP2.5 rule 3 and S4: confirmation of the replacement", () => {
  it("S4: keeps both slots held and asks which one stands", async () => {
    const p = await scenario(["m2", "m3", "s4-confirm"]);
    expect(slot(p, "2026-11-12T10:30")!.stateLabel).toBe("Confirmed · office message, change proposed");
    expect(slot(p, "2026-11-16T13:00")!.stateLabel).toBe("Confirmed · office message");
    expect(p.conflicts.map((c) => [c.kind, c.evidenceIds])).toEqual([["both_held", ["m2-e1", "s4-confirm-e1"]]]);
    expect(p.conflicts[0]!.choices.map((c) => [c.label, c.effects.map((e) => [e.claim_type, e.date, e.time])])).toEqual([
      ["Thursday 11/12 10:30 AM stands", [["cancel", "2026-11-16", "13:00"]]],
      ["Monday 11/16 1:00 PM stands", [["cancel", "2026-11-12", "10:30"]]],
      ["Not sure yet", []],
    ]);
  });

  it("releases the original when the evidence says it was canceled", () => {
    const p = project(
      ev("a", "confirm", THU.date, THU.time, T1),
      ev("b", "confirm", MON.date, MON.time, T3),
      ev("c", "cancel", THU.date, null, T3),
    );
    expect(p.slots.map((s) => s.state)).toEqual(["canceled", "confirmed"]);
    expect(disagreements(p)).toEqual([]);
  });
});

describe("SP2.6 rules 4 and 5: event order", () => {
  const confirm = ev("a", "confirm", THU.date, THU.time, T1);

  it("lets the later known event win, whatever the arrival order", () => {
    const early = ev("b", "cancel", THU.date, THU.time, T3, { event_time: "2026-10-30T12:00:00-06:00" });
    expect(project(confirm, early).slots[0]!.state).toBe("confirmed");
    const late = ev("b", "cancel", THU.date, THU.time, "2026-10-29T12:00:00-06:00", { event_time: "2026-11-01T12:00:00-06:00" });
    expect(project(confirm, late).slots[0]!.state).toBe("canceled");
  });

  it("raises a conflict instead of choosing when an unknown time would change the result", () => {
    const unknown = ev("b", "cancel", THU.date, THU.time, T2, { sender_kind: "unknown" });
    const p = project(confirm, unknown);
    expect(p.slots[0]!.stateLabel).toBe("Confirmed · office message");
    expect(disagreements(p).map((c) => [c.kind, c.evidenceIds])).toEqual([["unknown_order", ["a", "b"]]]);
    expect(disagreements(p)[0]!.choices.map((c) => [c.label, c.settles])).toEqual([
      ["Thursday 11/12 10:30 AM is confirmed", ["b"]],
      ["Thursday 11/12 10:30 AM is canceled", ["b"]],
      ["Not sure yet", []],
    ]);
  });

  it("review R1-1: chooses no winner between two claims that both have unknown times", () => {
    const cancel = ev("x", "cancel", THU.date, THU.time, "2026-11-02T09:00:00-07:00", { sender_kind: "unknown" });
    const reconfirm = ev("y", "confirm", THU.date, THU.time, "2026-11-03T09:00:00-07:00", { sender_kind: "unknown" });
    for (const order of [[cancel, reconfirm], [reconfirm, cancel]]) {
      const p = project(...order);
      expect(p.slots).toEqual([]);
      expect(p.conflicts.map((c) => [c.id, c.kind, c.evidenceIds])).toEqual([["unknown-order-20261112-1030", "unknown_order", ["x", "y"]]]);
      expect(p.conflicts[0]!.summary).toBe(
        "Sources disagree about Thursday 11/12 10:30 AM, and none of them has a known time. Code does not choose between them, so the slot has no state until you answer.",
      );
      expect(p.conflicts[0]!.choices.map((c) => [c.label, c.settles])).toEqual([
        ["Thursday 11/12 10:30 AM is confirmed", ["x", "y"]],
        ["Thursday 11/12 10:30 AM is canceled", ["x", "y"]],
        ["Not sure yet", []],
      ]);
    }
    const reported = ev("ans", "confirm", THU.date, THU.time, T3, { ...user, origin: "answer", answer: answer({ after: "2026-11-03T09:00:00-07:00" }) });
    const settled = projectSlots({ evidence: [cancel, reconfirm, reported], settled: new Set(["x", "y"]) });
    expect(settled.slots.map((s) => s.stateLabel)).toEqual(["Confirmed · reported by you"]);
    expect(disagreements(settled)).toEqual([]);
  });

  it("review R1-1: applies unknown-time claims that agree in every order", () => {
    const a = ev("x", "confirm", THU.date, THU.time, T1, { sender_kind: "unknown" });
    const b = ev("y", "reminder", THU.date, THU.time, T2, { sender_kind: "automated" });
    const p = project(a, b);
    expect(p.slots.map((s) => s.state)).toEqual(["confirmed"]);
    expect(disagreements(p)).toEqual([]);
  });

  it("review R1-1: judges several unknown claims together against the known state", () => {
    // Known offer. Unknown confirm and unknown cancel: neither is applied.
    const p = project(
      ev("k", "offer", THU.date, THU.time, T1),
      ev("x", "confirm", THU.date, THU.time, T2, { sender_kind: "unknown" }),
      ev("y", "cancel", THU.date, THU.time, T3, { sender_kind: "unknown" }),
    );
    expect(p.slots.map((s) => s.stateLabel)).toEqual(["Offered · office message"]);
    expect(disagreements(p).map((c) => [c.evidenceIds, c.choices.map((ch) => ch.id)])).toEqual([
      [["k", "x", "y"], ["status:offered", "status:confirmed", "status:canceled", "unsure"]],
    ]);
    // Known confirm. An unknown re-offer cannot change it and is kept. The unknown cancel is left out.
    const q = project(
      ev("k", "confirm", THU.date, THU.time, T1),
      ev("x", "offer", THU.date, THU.time, T2, { sender_kind: "unknown" }),
      ev("y", "cancel", THU.date, THU.time, T3, { sender_kind: "unknown" }),
    );
    expect(q.slots.map((s) => s.state)).toEqual(["confirmed"]);
    expect(disagreements(q).map((c) => c.evidenceIds)).toEqual([["k", "y"]]);
  });

  it("raises no conflict when the unknown time would not change the result", () => {
    const p = project(confirm, ev("b", "offer", THU.date, THU.time, T2, { sender_kind: "unknown" }));
    expect(p.slots[0]!.state).toBe("confirmed");
    expect(disagreements(p)).toEqual([]);
  });

  it("counts a stated date without a clock time as unknown", () => {
    const p = project(confirm, ev("b", "cancel", THU.date, THU.time, T2, { event_time: "2026-11-03" }));
    expect(disagreements(p).map((c) => c.kind)).toEqual(["unknown_order"]);
  });

  it("treats two disagreeing claims at the same instant as unordered", () => {
    const p = project(confirm, ev("b", "cancel", THU.date, THU.time, T1));
    expect(p.slots[0]!.state).toBe("confirmed");
    expect(disagreements(p).map((c) => c.kind)).toEqual(["unknown_order"]);
  });

  it("drops the conflict once an answer settles the unknown claim", () => {
    const unknown = ev("b", "cancel", THU.date, THU.time, T2, { sender_kind: "unknown" });
    const reported = ev("ans", "cancel", THU.date, THU.time, T1, { ...user, origin: "answer", answer: answer({ after: T2 }) });
    const p = projectSlots({ evidence: [confirm, unknown, reported], settled: new Set(["b"]) });
    expect(p.slots[0]!.stateLabel).toBe("Canceled · reported by you");
    expect(disagreements(p)).toEqual([]);
  });

  it("orders an answer after the evidence the user had in view", () => {
    // The answer's own clock is earlier than the office message.
    const office = ev("b", "confirm", THU.date, THU.time, T2);
    const reported = ev("ans", "cancel", THU.date, THU.time, T1, { ...user, origin: "answer", answer: answer({ after: T2 }) });
    expect(project(office, reported).slots[0]!.state).toBe("canceled");
  });
});

describe("SP2.7 rule 6 and S6: possibly stale reminders", () => {
  it("S6: marks the reminder possibly stale, asks once and changes no state", async () => {
    const before = await scenario(["m2", "s5-report"]);
    const after = await scenario(["m2", "s5-report", "s6-reminder"]);
    expect(after.staleEvidenceIds).toEqual(["s6-reminder-e1"]);
    expect(after.slots.map((s) => [s.key, s.stateLabel])).toEqual(before.slots.map((s) => [s.key, s.stateLabel]));
    expect(slot(after, "2026-11-12T10:30")!.staleEvidenceIds).toEqual(["s6-reminder-e1"]);
    const stale = after.conflicts.filter((c) => c.kind === "possibly_stale");
    expect(stale.map((c) => c.evidenceIds)).toEqual([["s6-reminder-e1", "s5-report-e2"]]);
  });

  it("does not mark a reminder that agrees with the slot", () => {
    const p = project(ev("a", "confirm", THU.date, THU.time, T1), ev("b", "reminder", THU.date, THU.time, T3, { sender_kind: "automated" }));
    expect(p.staleEvidenceIds).toEqual([]);
    expect(disagreements(p)).toEqual([]);
  });

  it("lets a reminder with nothing to contradict hold the slot", () => {
    const p = project(ev("b", "reminder", THU.date, THU.time, T3, { sender_kind: "automated", location: "Lantern Hill Clinic" }));
    expect(p.slots[0]!.stateLabel).toBe("Confirmed · office message");
  });

  it("applies the later-event rule to a reminder a person sent", () => {
    const p = project(ev("a", "cancel", THU.date, THU.time, T1, user), ev("b", "reminder", THU.date, THU.time, T3));
    expect(p.slots[0]!.state).toBe("confirmed");
    expect(p.staleEvidenceIds).toEqual([]);
  });
});

describe("SP2.8 S5: a user report of a move", () => {
  it("confirms Monday and cancels Thursday, both reported by you", async () => {
    const p = await scenario(["m2", "s5-report"]);
    expect(p.slots.map((s) => [s.key, s.stateLabel])).toEqual([
      ["2026-11-12T10:30", "Canceled · reported by you"],
      ["2026-11-16T13:00", "Confirmed · reported by you"],
    ]);
  });
});

describe("SP2.9 S7: incomplete slots", () => {
  it("marks a confirmation with a date only as incomplete and asks for the time and place", async () => {
    const p = await scenario(["s7-confirm"]);
    expect(p.slots.map((s) => [s.key, s.label, s.stateLabel, s.missing, s.clashes])).toEqual([
      ["2026-11-16", "Monday 11/16, no time", "Confirmed · office message", ["time", "location"], null],
    ]);
    expect(p.conflicts.map((c) => [c.kind, c.evidenceIds, c.askable])).toEqual([["incomplete_slot", ["s7-confirm-e1"], true]]);
    expect(p.conflicts[0]!.fixedQuestion).toBe("The visit on Monday 11/16 is confirmed without a time and place. Can you add them from a message or a report?");
  });

  it("does not mark offered or requested slots as incomplete", () => {
    const p = project(ev("a", "offer", MON.date, MON.time, T1));
    expect(p.slots[0]!.missing).toEqual([]);
    expect(p.conflicts).toEqual([]);
  });

  it("joins a later date-only claim to the one timed slot on that date", () => {
    const p = project(ev("a", "confirm", MON.date, null, T1), ev("b", "offer", MON.date, MON.time, T2, { location: "400 Elm Street" }));
    expect(p.slots.map((s) => [s.key, s.state, s.missing])).toEqual([["2026-11-16T13:00", "confirmed", []]]);
  });
});

describe("D-f and D-g: ambiguous dates and places", () => {
  it("raises a question for a weekday that fits two dates and leaves the claim out", () => {
    expect(weekdayOnlyCandidates("2026-11-16", "They moved me to Monday at 1:00 PM", "2026-11-05T12:00:00-07:00")).toEqual([
      "2026-11-09",
      "2026-11-16",
    ]);
    expect(weekdayOnlyCandidates("2026-11-16", "Monday 11/16 at 1:00 PM", "2026-11-05T12:00:00-07:00")).toBeNull();
    const claim = ev("a", "confirm", MON.date, MON.time, "2026-11-05T12:00:00-07:00", {
      origin: "model",
      quote: "They moved me to Monday at 1:00 PM",
      ...user,
    });
    const p = project(claim);
    expect(p.slots).toEqual([]);
    expect(p.conflicts.map((c) => [c.kind, c.id, c.choices.map((ch) => ch.label)])).toEqual([
      ["ambiguous_date", "ambiguous-date-a", ["It means Monday 11/9 1:00 PM", "It means Monday 11/16 1:00 PM", "Not sure yet"]],
    ]);
    const resolved = project(
      claim,
      ev("ans", "clarify", "2026-11-09", "13:00", T3, { ...user, origin: "answer", answer: answer({ clarifies: "a" }) }),
    );
    expect(resolved.slots.map((s) => [s.key, s.stateLabel])).toEqual([["2026-11-09T13:00", "Confirmed · reported by you"]]);
    expect(resolved.conflicts.filter((c) => c.kind === "ambiguous_date")).toEqual([]);
  });

  it("raises a question for a date-only claim that fits two timed slots", () => {
    const p = project(
      ev("a", "offer", THU.date, "09:00", T1),
      ev("b", "offer", THU.date, "10:30", T1),
      ev("c", "cancel", THU.date, null, T2),
    );
    expect(p.slots.map((s) => s.state)).toEqual(["offered", "offered"]);
    expect(p.conflicts.map((c) => [c.kind, c.slotKeys])).toEqual([["ambiguous_date", ["2026-11-12T09:00", "2026-11-12T10:30"]]]);
  });

  it("compares places by their distinctive words", () => {
    expect(locationsAgree("Elm Street office", "Lantern Hill Clinic, 400 Elm Street, Suite 2")).toBe(true);
    expect(locationsAgree("our Elm Street office", "Elm Street")).toBe(true);
    expect(locationsAgree("Lantern Hill Clinic", "Lantern Hill Clinic, 400 Elm Street, Suite 2")).toBe(true);
    expect(locationsAgree("Elm Street office", "Oak Avenue office")).toBe(false);
    expect(locationsAgree("400 Elm Street", "Lantern Hill Clinic")).toBe(false);
  });

  it("S1 and the demo show the most detailed agreeing place without a conflict", async () => {
    const p = await scenario(["m1", "m2"]);
    expect(slot(p, "2026-11-12T10:30")!.location).toBe("Lantern Hill Clinic, 400 Elm Street, Suite 2");
    expect(p.conflicts).toEqual([]);
  });

  it("raises a conflict for places that do not agree, and a place answer settles it", () => {
    const a = ev("a", "offer", THU.date, THU.time, T1, { location: "Elm Street office" });
    const b = ev("b", "confirm", THU.date, THU.time, T2, { location: "Oak Avenue office" });
    const p = project(a, b);
    expect(p.slots[0]!).toMatchObject({ location: null, locationDisputed: true, missing: [] });
    expect(p.conflicts.map((c) => [c.kind, c.evidenceIds, c.choices.map((ch) => ch.label)])).toEqual([
      ["location_mismatch", ["a", "b"], ["Elm Street office is right", "Oak Avenue office is right", "Not sure yet"]],
    ]);
    const chosen = ev("ans", "clarify", THU.date, THU.time, T3, { ...user, origin: "answer", answer: answer({ after: T2 }), location: "Oak Avenue office" });
    const q = project(a, b, chosen);
    expect(q.slots[0]!).toMatchObject({ location: "Oak Avenue office", locationDisputed: false, state: "confirmed" });
    expect(q.conflicts).toEqual([]);
  });

  it("raises no place conflict for a canceled slot", () => {
    const p = project(
      ev("a", "confirm", THU.date, THU.time, T1, { location: "Elm Street office" }),
      ev("b", "cancel", THU.date, THU.time, T2, { location: "Oak Avenue office" }),
    );
    expect(p.conflicts).toEqual([]);
  });
});

describe("change proposals", () => {
  it("S2: an office offer after the confirmation proposes a change and offers to keep the original", async () => {
    const p = await scenario(["m2", "s2-offer"]);
    expect(p.slots.map((s) => [s.key, s.stateLabel])).toEqual([
      ["2026-11-11T15:00", "Offered · office message"],
      ["2026-11-12T10:30", "Confirmed · office message, change proposed"],
    ]);
    expect(p.conflicts.map((c) => [c.kind, c.evidenceIds, c.choices.map((ch) => ch.id)])).toEqual([
      ["change_proposed", ["m2-e1", "s2-offer-e1"], ["request:2026-11-11T15:00", "keep", "unsure"]],
    ]);
  });

  it("an offer made before the confirmation proposes nothing", async () => {
    const p = await scenario(["m1", "m2"]);
    expect(slot(p, "2026-11-10T14:00")!.stateLabel).toBe("Offered · office message");
    expect(slot(p, "2026-11-12T10:30")!.state).toBe("confirmed");
  });

  it("declining every alternative ends a change proposal that had no move", () => {
    const a = { ...user, origin: "answer" as const, answer: answer() };
    const p = project(ev("a", "confirm", THU.date, THU.time, T1), ev("b", "offer", MON.date, MON.time, T2), ev("c", "decline", MON.date, MON.time, T3, a));
    expect(p.slots.map((s) => s.state)).toEqual(["confirmed", "declined"]);
    expect(disagreements(p)).toEqual([]);
  });

  it("a move alone still shows the slot as held with a change proposed", () => {
    const p = project(ev("a", "move", THU.date, THU.time, T2));
    expect(p.slots[0]!.stateLabel).toBe("Confirmed · office message, change proposed");
    expect(disagreements(p).map((c) => [c.kind, c.askable])).toEqual([["change_proposed", false]]);
  });

  it("a later confirmation of the same slot withdraws the move", () => {
    const p = project(ev("a", "confirm", THU.date, THU.time, T1), ev("b", "move", THU.date, THU.time, T2), ev("c", "confirm", THU.date, THU.time, T3));
    expect(p.slots[0]!.state).toBe("confirmed");
  });
});

describe("SP2.10 calendar clashes", () => {
  const calendar = parseIcs(readFixtureText("calendar/dana.ics"));

  it("demo: Friday 11/13 9:15 AM clashes with the Team meeting. The other offers do not", async () => {
    const p = await scenario(["m1", "m2", "m3"]);
    expect(p.slots.map((s) => [s.label, s.state, s.clashes?.map((c) => c.summary)])).toEqual([
      ["Tuesday 11/10 2:00 PM", "offered", []],
      ["Thursday 11/12 10:30 AM", "change_proposed", []],
      ["Friday 11/13 9:15 AM", "offered", ["Team meeting"]],
      ["Monday 11/16 1:00 PM", "offered", []],
    ]);
  });

  it("assumes a 60 minute slot and counts touching intervals as no clash", () => {
    expect(ASSUMED_SLOT_MINUTES).toBe(60);
    expect(findClashes("2026-11-13", "08:00", calendar)).toEqual([]);
    expect(findClashes("2026-11-13", "08:01", calendar).map((c) => c.summary)).toEqual(["Team meeting"]);
    expect(findClashes("2026-11-13", "09:59", calendar).map((c) => c.summary)).toEqual(["Team meeting"]);
    expect(findClashes("2026-11-13", "10:00", calendar)).toEqual([]);
    expect(findClashes("2026-11-10", "14:31", calendar).map((c) => c.summary)).toEqual(["Project review"]);
  });

  it("reads UTC, all-day and zero-length events, and Denver daylight time", () => {
    const ics = (body: string) => parseIcs(`BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR`);
    // 16:15Z is 9:15 AM in Denver on 11/13 (MST, UTC-7).
    const utc = ics("BEGIN:VEVENT\nDTSTART:20261113T161500Z\nDTEND:20261113T163000Z\nSUMMARY:Call\nEND:VEVENT");
    expect(findClashes("2026-11-13", "09:00", utc).map((c) => c.summary)).toEqual(["Call"]);
    expect(findClashes("2026-11-13", "08:00", utc)).toEqual([]);
    const allDay = ics("BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261113\nSUMMARY:Trip\nEND:VEVENT");
    expect(findClashes("2026-11-13", "23:30", allDay).map((c) => c.summary)).toEqual(["Trip"]);
    expect(findClashes("2026-11-14", "00:00", allDay)).toEqual([]);
    const point = ics("BEGIN:VEVENT\nDTSTART;TZID=America/Denver:20261113T093000\nSUMMARY:Pickup\nEND:VEVENT");
    expect(findClashes("2026-11-13", "09:15", point).map((c) => c.summary)).toEqual(["Pickup"]);
    expect(findClashes("2026-11-13", "09:30", point).map((c) => c.summary)).toEqual(["Pickup"]);
    expect(findClashes("2026-11-13", "10:30", point)).toEqual([]);
    // October 30 is daylight time in Denver (UTC-6).
    expect(wallClockToUtc("2026-10-30", "09:00")).toBe(Date.UTC(2026, 9, 30, 15, 0));
    expect(wallClockToUtc("2026-11-13", "09:00")).toBe(Date.UTC(2026, 10, 13, 16, 0));
  });

  it("checks offered, requested and held slots, not closed ones, and needs a calendar", () => {
    const fri = { date: "2026-11-13", time: "09:15" };
    const offered = projectSlots({ evidence: [ev("a", "offer", fri.date, fri.time, T1)], calendar });
    expect(offered.slots[0]!.clashes!.map((c) => c.summary)).toEqual(["Team meeting"]);
    const requested = projectSlots({
      evidence: [ev("a", "offer", fri.date, fri.time, T1), ev("b", "request", fri.date, fri.time, T3, { ...user, origin: "answer", answer: answer() })],
      calendar,
    });
    expect(requested.slots[0]!.clashes!.map((c) => c.summary)).toEqual(["Team meeting"]);
    const canceled = projectSlots({ evidence: [ev("a", "offer", fri.date, fri.time, T1), ev("b", "cancel", fri.date, fri.time, T2)], calendar });
    expect(canceled.slots[0]!.clashes).toBeNull();
    expect(projectSlots({ evidence: [ev("a", "offer", fri.date, fri.time, T1)] }).slots[0]!.clashes).toBeNull();
  });
});
