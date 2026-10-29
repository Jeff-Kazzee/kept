// The activity log and undo (0009, design 3). Every action is an entry with
// a code-written summary, its actor and its target, written in the same
// transaction as the action. Undo appends a reversing event, and is
// refused with a plain sentence when the entry cannot be undone, was undone
// already, or a later action depends on it.
import { describe, expect, it } from "vitest";
import { CaseActions, PersonOnlyError, UndoBlockedError, YOU, factWords, type By } from "../src/actions/service.ts";
import { CaseService } from "../src/case/service.ts";
import { readFixtureText } from "../src/fixtures/load.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore, StaleEditError } from "../src/store/event-log.ts";
import { fixtureMessage, intake, useZone } from "./helpers.ts";

const CLOCK = () => "2026-11-06T17:00:00.000Z";
const THU = "2026-11-12T10:30";
const MON = "2026-11-16T13:00";
const AGENT: By = { actor: "agent" };

function app() {
  const store = new EventStore(":memory:", CLOCK);
  useZone(store);
  const client = RecordedModelClient.fromDirectory();
  const svc = intake(store);
  const kase = new CaseService(store, svc, client, { userName: "Dana Reyes" });
  const reply = new ReplyService(store, kase, client);
  const records = new RecordsService(store, svc, kase);
  const actions = new CaseActions(store, { intake: svc, kase, reply, records });
  return { store, intake: svc, kase, reply, records, actions };
}
type App = ReturnType<typeof app>;

// Imports and reads a fixture message as the agent does, and accepts its
// claims.
async function addAndAccept(a: App, id: string, by: By = AGENT) {
  const m = a.actions.importMessage(by, fixtureMessage(id));
  const { evidence } = await a.actions.extract(by, id, { effort: "low", expectedVersion: m.version });
  for (const e of evidence) a.actions.acceptClaim(by, e.id, e.version);
}

const latest = (a: App) => a.actions.activity();
const undoLatest = (a: App, kind: string, by: By = YOU) => {
  const log = latest(a);
  return a.actions.undo(by, log.entries.find((e) => e.kind === kind && !e.undone)!.id, log.activityVersion);
};
const blocked = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof UndoBlockedError) return err.message;
    throw err;
  }
  throw new Error("expected undo_blocked");
};
const labels = (a: App) => Object.fromEntries(a.kase.view().slots.map((s) => [s.key, s.stateLabel]));

describe("activity entries", () => {
  it("records each action with its actor, a code-written summary, its target and the case zone's time, newest first", async () => {
    const a = app();
    const seen: string[] = [];
    await addAndAccept(a, "m2", { actor: "mcp", onEntry: (e) => seen.push(e.kind) });
    a.actions.addNote(AGENT, THU, "Bring the parking pass.", 0);
    const log = latest(a);
    expect(log.activityVersion).toBe(6);
    expect(log.entries.map((e) => [e.id, e.actor, e.kind, e.target])).toEqual([
      ["a6", "agent", "note_added", { type: "note", id: `${THU}#n1` }],
      ["a5", "mcp", "claim_accepted", { type: "claim", id: "m2-e3" }],
      ["a4", "mcp", "claim_accepted", { type: "claim", id: "m2-e2" }],
      ["a3", "mcp", "claim_accepted", { type: "claim", id: "m2-e1" }],
      ["a2", "mcp", "message_read", { type: "message", id: "m2" }],
      ["a1", "mcp", "message_imported", { type: "message", id: "m2" }],
    ]);
    expect(seen).toEqual(["message_imported", "message_read", "claim_accepted", "claim_accepted", "claim_accepted"]);
    expect(log.entries.map((e) => e.summary)).toEqual([
      "Added a note to Thursday 11/12 10:30 AM.",
      "Accepted an office request from message m2.",
      "Accepted an office request from message m2.",
      "Accepted the confirmation for Thursday 11/12 10:30 AM from message m2.",
      "Read message m2. 3 facts were found.",
      "Added message m2 (email).",
    ]);
    // No message text, note text or request item in any summary.
    expect(JSON.stringify(log.entries.map((e) => e.summary))).not.toMatch(/parking|insurance|Lantern/i);
    // 0016, M3 and M4: the words the person sees name the message by its
    // sender and time, never by id, and say a fact was recorded. Still no
    // message text or request item.
    expect(log.entries.map((e) => e.label ?? e.summary)).toEqual([
      "Added a note to Thursday 11/12 10:30 AM.",
      "Recorded the office's request (fact 3 of 3) for your checklist, from the email from Front Desk, Lantern Hill Clinic, Oct 31, 9:12 AM.",
      "Recorded the office's request (fact 2 of 3) for your checklist, from the email from Front Desk, Lantern Hill Clinic, Oct 31, 9:12 AM.",
      "Recorded the office's confirmation of Thursday 11/12 10:30 AM, from the email from Front Desk, Lantern Hill Clinic, Oct 31, 9:12 AM.",
      "Read the email from Front Desk, Lantern Hill Clinic, Oct 31, 9:12 AM. 3 facts were found.",
      "Added the email from Front Desk, Lantern Hill Clinic, Oct 31, 9:12 AM.",
    ]);
    expect(JSON.stringify(log)).not.toMatch(/parking|insurance/i);
    expect(log.entries.map((e) => e.label ?? "").join(" ")).not.toMatch(/\bm2\b/);
    expect(log.entries[0]!.at).toBe("2026-11-06T10:00:00.000-07:00");
    expect(log.entries.find((e) => e.kind === "message_read")).toMatchObject({ undoable: false, undone: false });
  });

  it("writes an entry only when the action commits", async () => {
    const a = app();
    await addAndAccept(a, "m2");
    const before = latest(a).activityVersion;
    expect(() => a.actions.addNote(AGENT, THU, "x", 5)).toThrow(StaleEditError);
    expect(() => a.actions.acceptClaim(AGENT, "m2-e1", 2)).toThrow(/already accepted/);
    expect(latest(a).activityVersion).toBe(before);
  });

  it("keeps the person-only actions out of the agent's reach", async () => {
    const a = app();
    await addAndAccept(a, "m2");
    await addAndAccept(a, "m3");
    a.actions.startReply(AGENT, "accept_offer", MON, a.kase.view().reply.version);
    const draft = a.kase.view().reply.draft!;
    for (const by of [AGENT, { actor: "mcp" as const }]) {
      expect(() => a.actions.approveDraft(by, draft.id, draft.fields.map((f) => f.name), a.kase.view().reply.version)).toThrow(PersonOnlyError);
      expect(() => a.actions.editDraft(by, draft.id, "Changed.", a.kase.view().reply.version)).toThrow(PersonOnlyError);
      expect(() => a.actions.enterManually(by, "m2", a.intake.message("m2").version, { claim_type: "confirm", date: "2026-11-16", time: "13:00", location: null, quote: null, request_item: null })).toThrow(
        PersonOnlyError,
      );
    }
    expect(a.kase.view().reply.sent).toEqual([]);
    expect("deleteCase" in a.actions).toBe(false);
  });
});

describe("undo of each action", () => {
  it("returns a review decision to pending, and refuses once the fact was reviewed again", async () => {
    const a = app();
    await addAndAccept(a, "m2");
    expect(labels(a)[THU]).toBe("Confirmed · office message");
    undoLatest(a, "claim_accepted");
    expect(a.intake.evidenceItem("m2-e3")).toMatchObject({ status: "pending", decidedAt: null });
    const rejected = a.actions.rejectClaim(YOU, "m2-e3", a.intake.evidenceItem("m2-e3").version);
    expect(rejected.status).toBe("rejected");
    undoLatest(a, "claim_rejected", AGENT);
    expect(a.intake.evidenceItem("m2-e3").status).toBe("pending");
    // The first accept of m2-e1 still holds, and its undo empties Thursday.
    const log = latest(a);
    const first = log.entries.find((e) => e.target?.id === "m2-e1")!;
    a.actions.undo(YOU, first.id, log.activityVersion);
    expect(labels(a)).toEqual({});
  });

  it("withdraws an imported message and its facts, but not after one of them was reviewed", async () => {
    const a = app();
    const m = a.actions.importMessage(AGENT, fixtureMessage("m1"));
    await a.actions.extract(AGENT, "m1", { effort: "low", expectedVersion: m.version });
    a.actions.acceptClaim(AGENT, "m1-e1", 1);
    const log = latest(a);
    const imported = log.entries.find((e) => e.kind === "message_imported")!;
    expect(blocked(() => a.actions.undo(YOU, imported.id, log.activityVersion))).toBe("A fact from message m1 was reviewed. Undo those reviews first.");
    undoLatest(a, "claim_accepted");
    const again = latest(a);
    a.actions.undo(YOU, imported.id, again.activityVersion);
    expect(a.intake.messages()).toEqual([]);
    expect(a.intake.evidence()).toEqual([]);
    // Pasting it again adds it anew, with new claim ids.
    const back = a.actions.importMessage(AGENT, fixtureMessage("m1"));
    const { evidence } = await a.actions.extract(AGENT, "m1", { effort: "low", expectedVersion: back.version });
    expect(evidence.map((e) => e.id)).toEqual(["m1-r2-e1", "m1-r2-e2"]);
  });

  it("an answer reopens its question and discards its open draft, and is refused after a reply depending on it was approved", async () => {
    const a = app();
    await addAndAccept(a, "m2");
    await addAndAccept(a, "m3");
    let view = await a.actions.askNext(AGENT, a.kase.view().questionsVersion);
    const q = view.question!;
    view = a.actions.answerQuestion(AGENT, q.id, `request:${MON}`, view.questionsVersion, view.reply.version);
    expect(view.reply.draft).toMatchObject({ slotKey: MON, origin: "choice" });
    undoLatest(a, "question_answered");
    view = a.kase.view();
    expect(view.question?.id).toBe(q.id);
    expect(view.reply.draft).toBeNull();
    // Answered again, and the reply approved by the person.
    view = a.actions.answerQuestion(YOU, q.id, `request:${MON}`, view.questionsVersion, view.reply.version);
    const draft = view.reply.draft!;
    a.actions.approveDraft(YOU, draft.id, draft.fields.map((f) => f.name), view.reply.version);
    expect(labels(a)[MON]).toBe("Requested · reported by you");
    const log = latest(a);
    const answer = log.entries.find((e) => e.kind === "question_answered" && !e.undone)!;
    expect(blocked(() => a.actions.undo(YOU, answer.id, log.activityVersion))).toBe(
      "A reply for Monday 11/16 1:00 PM was approved after this and depends on it. A sent reply cannot be unsent, so this cannot be undone.",
    );
    expect(blocked(() => a.actions.undo(YOU, log.entries[0]!.id, log.activityVersion))).toBe("The reply was approved and its send simulated. A sent reply cannot be unsent.");
  });

  it("an ask is withdrawn so its conflict waits again, but not once it was answered", async () => {
    const a = app();
    await addAndAccept(a, "m2");
    await addAndAccept(a, "m3");
    let view = await a.actions.askNext(AGENT, a.kase.view().questionsVersion);
    undoLatest(a, "question_asked");
    expect(a.kase.view()).toMatchObject({ question: null, waiting: 1 });
    view = await a.actions.askNext(AGENT, a.kase.view().questionsVersion);
    a.actions.answerQuestion(YOU, view.question!.id, "unsure", view.questionsVersion, view.reply.version);
    expect(blocked(() => undoLatest(a, "question_asked"))).toBe(`Question ${view.question!.id} was answered. Undo the answer first.`);
  });

  it("a fact's undo is refused while a later answer about the same appointments stands", async () => {
    const a = app();
    await addAndAccept(a, "m2");
    await addAndAccept(a, "m3");
    const view = await a.actions.askNext(AGENT, a.kase.view().questionsVersion);
    a.actions.answerQuestion(YOU, view.question!.id, "unsure", view.questionsVersion, view.reply.version);
    const log = latest(a);
    const offer = log.entries.find((e) => e.target?.id === "m3-e3")!;
    expect(blocked(() => a.actions.undo(YOU, offer.id, log.activityVersion))).toBe(`Question ${view.question!.id} was answered after this, about the same appointments. Undo that answer first.`);
  });

  it("archive, unarchive, notes and tags undo through the record's own undo event", async () => {
    const a = app();
    await addAndAccept(a, "m2");
    a.actions.archive(AGENT, THU, 0);
    expect(a.kase.archivedKeys().has(THU)).toBe(true);
    undoLatest(a, "appointment_archived");
    expect(a.kase.archivedKeys().has(THU)).toBe(false);
    a.actions.archive(AGENT, THU, 2);
    a.actions.unarchive(AGENT, THU, 3);
    undoLatest(a, "appointment_unarchived");
    expect(a.kase.archivedKeys().has(THU)).toBe(true);
    a.actions.unarchive(YOU, THU, 5);
    a.actions.setTags(AGENT, THU, ["a"], 6);
    a.actions.setTags(AGENT, THU, ["b"], 7);
    a.actions.addNote(AGENT, THU, "A note.", 8);
    undoLatest(a, "note_added");
    expect(a.records.record(THU).notes).toEqual([]);
    const log = latest(a);
    const firstTags = log.entries.filter((e) => e.kind === "tags_set").at(-1)!;
    expect(blocked(() => a.actions.undo(YOU, firstTags.id, log.activityVersion))).toBe("Only the latest tag change can be undone. That is the one at version 8.");
    undoLatest(a, "tags_set");
    expect(a.records.record(THU).tags).toEqual(["a"]);
  });

  it("a draft's start is undone by discarding it, and a discard by opening it again, but not while another draft is open", async () => {
    const a = app();
    await addAndAccept(a, "m1");
    a.actions.startReply(AGENT, "accept_offer", "2026-11-10T14:00", 0);
    undoLatest(a, "draft_started");
    expect(a.kase.view().reply.draft).toBeNull();
    a.actions.startReply(AGENT, "accept_offer", THU, a.kase.view().reply.version);
    const d2 = a.kase.view().reply.draft!;
    a.actions.discardDraft(AGENT, d2.id, a.kase.view().reply.version);
    a.actions.startReply(YOU, "accept_offer", "2026-11-10T14:00", a.kase.view().reply.version);
    expect(blocked(() => undoLatest(a, "draft_discarded"))).toBe("Draft d3 is open now. Finish or discard it first.");
    a.actions.discardDraft(YOU, "d3", a.kase.view().reply.version);
    const log = latest(a);
    const discardOfD2 = log.entries.find((e) => e.kind === "draft_discarded" && e.target?.id === d2.id)!;
    a.actions.undo(YOU, discardOfD2.id, log.activityVersion);
    expect(a.kase.view().reply.draft).toMatchObject({ id: d2.id, slotKey: THU });
  });

  it("a time zone change is undone by putting the zone before it back, and only the latest", () => {
    const a = app();
    a.actions.setTimezone(YOU, "Europe/London", 1);
    a.actions.setTimezone(AGENT, "Asia/Tokyo", 2);
    expect(a.kase.timeZone()).toBe("Asia/Tokyo");
    const log = latest(a);
    const london = log.entries.find((e) => e.summary.startsWith("Set the time zone to Europe/London"))!;
    expect(blocked(() => a.actions.undo(YOU, london.id, log.activityVersion))).toBe("The time zone was changed again after this. Undo that change first.");
    a.actions.undo(YOU, log.entries[0]!.id, log.activityVersion);
    expect(a.kase.timeZone()).toBe("Europe/London");
  });

  it("an undo states the activity version, cannot itself be undone, and says why for an entry with no undo", async () => {
    const a = app();
    a.actions.setTimezone(YOU, "Europe/London", 1);
    a.actions.loadCalendar(YOU, "dana.ics", readFixtureText("calendar/dana.ics"), 0);
    const log = latest(a);
    expect(blocked(() => a.actions.undo(YOU, log.entries[0]!.id, log.activityVersion))).toBe("Loading a calendar cannot be undone. Load the calendar again to replace it.");
    expect(() => a.actions.undo(YOU, log.entries[1]!.id, log.activityVersion - 1)).toThrow(StaleEditError);
    const undo = a.actions.undo(YOU, log.entries[1]!.id, log.activityVersion);
    expect(undo).toMatchObject({ kind: "undo", undoable: false, summary: "Undid: Set the time zone to Europe/London (it was America/Denver)." });
    const after = latest(a);
    expect(blocked(() => a.actions.undo(YOU, undo.id, after.activityVersion))).toBe("An undo cannot be undone. Make the change again instead.");
    expect(blocked(() => a.actions.undo(YOU, log.entries[1]!.id, after.activityVersion))).toBe("This was already undone.");
    expect(() => a.actions.undo(YOU, "a99", after.activityVersion)).toThrow(/No activity entry a99/);
    expect(a.kase.timeZone()).toBe("America/Denver");
  });
});

describe("sprint 13C, M3 and M4: what the person reads", () => {
  // Live run 4: a move fact names the time being moved, so it must not
  // read as a move to that time.
  it("a move fact reads as the office's request to move the old time", async () => {
    const a = app();
    const m = a.actions.importMessage(AGENT, fixtureMessage("m3"), { suggested: [], note: "" });
    const { evidence } = await a.actions.extract(AGENT, m.id, { effort: "low", expectedVersion: m.version });
    const move = evidence.find((e) => e.claim.claim_type === "move")!;
    a.actions.acceptClaim(YOU, move.id, move.version);
    expect(latest(a).entries[0]!.label).toMatch(/^Recorded the office's request to move Thursday 11\/12 10:30 AM, from /);
    expect(latest(a).entries.map((e) => e.label).join(" ")).not.toMatch(/move to/);
  });

  it("a move fact with and without a date names what moves", () => {
    const base = { claim_type: "move", source_type: "office_message", slot: { date: "2026-11-12", time: "10:30" } } as unknown as Parameters<typeof factWords>[0];
    expect(factWords(base)).toBe("the office's request to move Thursday 11/12 10:30 AM");
    expect(factWords({ ...base, slot: { ...base.slot, date: null, time: null } } as typeof base)).toBe("the office's request to move an appointment");
  });

  it("an imported Gmail message, a fact left out and an undo are named without ids, and an offer reads as recorded, not taken", async () => {
    const a = app();
    // The recorded extraction of m2, as if read from Gmail.
    const m = a.actions.importMessage(AGENT, { ...fixtureMessage("m2"), from: "lantern hill <front@lanternhill.example>", received_at: "2026-10-29T00:43:00.000Z" }, { suggested: [], note: "", importedFrom: "gmail" });
    // 0017, E6: not read yet, the office's name may still change, so the
    // label names no one rather than the account's name for a moment.
    expect(latest(a).entries[0]!.label).toBe("Added from Gmail: the email, Oct 28, 6:43 PM.");
    expect(latest(a).entries[0]!.summary).toBe("Added message m2 from Gmail (email).");
    const { evidence } = await a.actions.extract(AGENT, m.id, { effort: "low", expectedVersion: m.version });
    // Fix round 2, N3: a fact still waiting for review names nothing. While
    // its place waits, the account's name is not shown either (0017, E6).
    expect(latest(a).entries.map((e) => e.label)).toContain("Added from Gmail: the email, Oct 28, 6:43 PM.");
    // 0016, C2: once the office's place is accepted, every label names the
    // sender as the case holds it, the earlier ones too.
    const confirm = evidence.find((e) => e.claim.claim_type === "confirm")!;
    a.actions.acceptClaim(YOU, confirm.id, confirm.version);
    expect(latest(a).entries.map((e) => e.label)).toContain("Added from Gmail: the email from Lantern Hill Clinic, Oct 28, 6:43 PM.");
    expect(latest(a).entries[0]!.label).toBe("Recorded the office's confirmation of Thursday 11/12 10:30 AM, from the email from Lantern Hill Clinic, Oct 28, 6:43 PM.");
    const other = evidence.find((e) => e.claim.claim_type === "office_request")!;
    a.actions.rejectClaim(AGENT, other.id, other.version);
    expect(latest(a).entries[0]!.label).toMatch(/^Left out the office's request \(fact \d of \d\) for your checklist, from the email from Lantern Hill Clinic, Oct 28, 6:43 PM\.$/);
    undoLatest(a, "claim_rejected");
    expect(latest(a).entries[0]!.label).toMatch(/^Undid: Left out the office's request/);
    // Undoing the accepted place puts the fact back to wait for review, so
    // the office is not named until it is decided again.
    undoLatest(a, "claim_accepted");
    expect(latest(a).entries.map((e) => e.label)).toContain("Added from Gmail: the email, Oct 28, 6:43 PM.");
    // Left out, the place names nothing: the office reads by its email name.
    const back = a.intake.evidence().find((e) => e.id === confirm.id)!;
    a.actions.rejectClaim(YOU, back.id, back.version);
    expect(latest(a).entries.map((e) => e.label)).toContain("Added from Gmail: the email from lantern hill, Oct 28, 6:43 PM.");
    for (const e of latest(a).entries) expect(e.label ?? e.summary).not.toMatch(/\bm2\b|front@|\bAccepted\b/);
  });

  it("C3: replies, questions and drafts are named without their ids", async () => {
    const a = app();
    await addAndAccept(a, "m1");
    await addAndAccept(a, "m2");
    await addAndAccept(a, "m3");
    const offered = a.kase.view().slots.find((s) => s.state === "offered")!;
    expect(offered).toBeDefined();
    {
      a.actions.startReply(AGENT, "accept_offer", offered.key, a.kase.view().reply.version);
      expect(latest(a).entries[0]!.label).toBe(`Started a reply accepting ${offered.label}. Nothing is sent until you approve it.`);
      expect(latest(a).entries[0]!.summary).toMatch(/^Started reply draft d1 /);
      const d = a.kase.view().reply.draft!;
      a.actions.discardDraft(YOU, d.id, a.kase.view().reply.version);
      expect(latest(a).entries[0]!.label).toBe(`Discarded the reply for ${offered.label}.`);
    }
    expect(a.kase.view().conflicts.length).toBeGreaterThan(0);
    {
      await a.actions.askNext(AGENT, a.kase.view().questionsVersion);
      expect(latest(a).entries[0]!.label).toMatch(/^Asked you the question about /);
    }
    // No internal id in any line the person reads.
    for (const e of latest(a).entries) expect(e.label ?? e.summary).not.toMatch(/\b(d\d+|q\d+|m\d+(-e\d+)?|\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\b/);
  });
});
