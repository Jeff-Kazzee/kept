// SP4.1 to SP4.3 and SP4.10 at the domain level: notes, tags, archive and
// undo on appointment records, and agent proposals that wait for the user.
import { describe, expect, it } from "vitest";
import { CaseService } from "../src/case/service.ts";
import { InvalidRequestError, NotFoundError } from "../src/intake/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { USER, type Actor } from "../src/records/events.ts";
import { RecordsService } from "../src/records/service.ts";
import { EventStore, StaleEditError } from "../src/store/event-log.ts";
import { acceptMessages, intake } from "./helpers.ts";

const THU = "2026-11-12T10:30";
const MON = "2026-11-16T13:00";
const AGENT: Actor = { kind: "agent", grant_id: "g-1", grant_name: "Laptop assistant" };
const GRANT = { id: "g-1", name: "Laptop assistant" };

// After every fixture message, as a real proposal would be.
const CLOCK = () => "2026-11-06T17:00:00.000Z";

async function setup(ids: string[]) {
  const store = new EventStore(":memory:", CLOCK);
  const service = intake(store);
  await acceptMessages(service, ids);
  const kase = new CaseService(store, service, RecordedModelClient.fromDirectory());
  let n = 0;
  const records = new RecordsService(store, service, kase, { newId: () => `p-${++n}` });
  return { store, intake: service, kase, records };
}

const stale = (fn: () => unknown): StaleEditError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof StaleEditError) return err;
    throw err;
  }
  throw new Error("expected a stale edit");
};

const labels = (kase: CaseService) => Object.fromEntries(kase.view().slots.map((s) => [s.key, s.stateLabel]));

describe("SP4.1 record events", () => {
  it("adds notes and sets tags with expected versions, by the user or an agent", async () => {
    const { records } = await setup(["m2"]);
    expect(records.record(THU)).toMatchObject({ version: 0, notes: [], tags: [], archived: false });
    records.addNote(THU, "Bring the new card.", 0, USER);
    records.setTags(THU, ["insurance", "Insurance", "follow-up"], 1, AGENT);
    const r = records.addNote(THU, "  Ask about parking.  ", 2, AGENT);
    expect(r.version).toBe(3);
    expect(r.notes.map((n) => [n.id, n.text, n.by.kind])).toEqual([
      ["n1", "Bring the new card.", "user"],
      ["n3", "Ask about parking.", "agent"],
    ]);
    // Tags repeat without regard to case only once.
    expect(r.tags).toEqual(["insurance", "follow-up"]);
    expect(r.history.map((h) => h.type)).toEqual(["note_added", "tags_set", "note_added"]);
  });

  it("refuses notes and tags outside the input rules", async () => {
    const { records, store } = await setup(["m2"]);
    expect(() => records.addNote(THU, "x".repeat(2001), 0, AGENT)).toThrow(InvalidRequestError);
    expect(() => records.addNote(THU, "   ", 0, AGENT)).toThrow(InvalidRequestError);
    expect(() => records.addNote(THU, "hidden ‮ text", 0, AGENT)).toThrow(/control characters/);
    expect(() => records.setTags(THU, Array.from({ length: 21 }, (_, i) => `t${i}`), 0, AGENT)).toThrow(InvalidRequestError);
    expect(() => records.setTags(THU, ["x".repeat(41)], 0, AGENT)).toThrow(InvalidRequestError);
    expect(() => records.setTags(THU, ["<b>"], 0, AGENT)).toThrow(/letters, digits/);
    expect(() => records.addNote("2026-11-30T10:00", "note", 0, AGENT)).toThrow(NotFoundError);
    expect(() => records.addNote("Thursday", "note", 0, AGENT)).toThrow(/appointment id/);
    expect(records.addNote(THU, "x".repeat(2000), 0, AGENT).version).toBe(1);
    expect(store.readStream(`record:${THU}`)).toHaveLength(1);
  });

  it("undo appends a reversing event: tags go back, a note leaves, history keeps both", async () => {
    const { records } = await setup(["m2"]);
    records.setTags(THU, ["a"], 0, USER);
    records.setTags(THU, ["b"], 1, AGENT);
    records.addNote(THU, "agent note", 2, AGENT);
    let r = records.undo(THU, 2, 3);
    expect(r.tags).toEqual(["a"]);
    r = records.undo(THU, 3, 4);
    expect(r.notes).toEqual([]);
    expect(r.history.map((h) => [h.version, h.type, h.undone, h.reverses])).toEqual([
      [1, "tags_set", false, null],
      [2, "tags_set", true, null],
      [3, "note_added", true, null],
      [4, "event_undone", false, 2],
      [5, "event_undone", false, 3],
    ]);
    expect(() => records.undo(THU, 2, 5)).toThrow(/already undone/);
    expect(() => records.undo(THU, 4, 5)).toThrow(/cannot be undone/);
    expect(() => records.undo(THU, 9, 5)).toThrow(NotFoundError);
    expect(stale(() => records.undo(THU, 1, 4)).currentVersion).toBe(5);
  });
});

describe("SP4.2 S14 stale edit", () => {
  it("the app saves a note at version 3, then an agent writes with expected version 2", async () => {
    const { records, store } = await setup(["m2"]);
    records.addNote(THU, "first", 0, USER);
    records.addNote(THU, "second", 1, USER);
    const agentSaw = records.record(THU).version;
    expect(agentSaw).toBe(2);
    records.addNote(THU, "third, from the app", 2, USER);

    const before = store.readAll().length;
    const err = stale(() => records.addNote(THU, "agent note", agentSaw, AGENT));
    expect(err).toMatchObject({ expectedVersion: 2, currentVersion: 3 });
    // The error carries the current record.
    expect(err.current).toMatchObject({ id: THU, version: 3, notes: [{ text: "first" }, { text: "second" }, { text: "third, from the app" }] });
    expect(store.readAll()).toHaveLength(before);
    expect(stale(() => records.setTags(THU, ["x"], agentSaw, AGENT)).currentVersion).toBe(3);
    expect(records.record(THU).tags).toEqual([]);
  });
});

describe("SP4.3 S17 archive and undo", () => {
  it("archive removes the record from the default list, keeps it in history, and undo brings it back", async () => {
    const { records } = await setup(["m1"]);
    const TUE = "2026-11-10T14:00";
    expect(records.appointments().map((a) => a.id)).toEqual([TUE, THU]);
    const archived = records.archive(TUE, 0);
    expect(archived).toMatchObject({ archived: true, version: 1 });
    expect(records.appointments().map((a) => a.id)).toEqual([THU]);
    expect(records.appointments({ includeArchived: true }).map((a) => [a.id, a.record.archived])).toEqual([
      [TUE, true],
      [THU, false],
    ]);
    // The record is still readable with its history.
    expect(records.appointment(TUE).record.history.map((h) => h.type)).toEqual(["record_archived"]);
    expect(() => records.archive(TUE, 1)).toThrow(/already archived/);

    const restored = records.undo(TUE, 1, 1);
    expect(restored).toMatchObject({ archived: false, version: 2 });
    expect(records.appointments().map((a) => a.id)).toEqual([TUE, THU]);
    expect(restored.history.map((h) => [h.type, h.undone])).toEqual([
      ["record_archived", true],
      ["event_undone", false],
    ]);
  });
});

describe("SP4.10 proposals wait for the user (rule 8)", () => {
  it("S16: a reported phone confirmation changes nothing until the user confirms it", async () => {
    const { records, kase, intake: service, store } = await setup(["m2", "m3"]);
    const before = labels(kase);
    expect(before[MON]).toBe("Offered · office message");
    const evidenceBefore = service.evidence().length;

    const p = records.propose(
      { kind: "user_report", claim_type: "confirm", date: "2026-11-16", time: "13:00", statement: "The office called. Monday at 1 PM is confirmed." },
      GRANT,
    );
    expect(p).toMatchObject({ id: "p-1", status: "pending", grantName: "Laptop assistant", version: 1 });
    expect(records.reviewQueue().proposals.map((x) => x.id)).toEqual(["p-1"]);
    expect(labels(kase)).toEqual(before);
    expect(service.evidence()).toHaveLength(evidenceBefore);

    const confirmed = records.confirmProposal("p-1", 1);
    expect(confirmed).toMatchObject({ status: "confirmed", evidenceIds: ["p-1-1"] });
    expect(records.reviewQueue().proposals).toEqual([]);
    const ev = service.evidenceItem("p-1-1");
    expect(ev).toMatchObject({
      origin: "agent",
      status: "accepted",
      claim: { source_type: "reported_by_user_via_agent", agent_name: "Laptop assistant", claim_type: "confirm", quote: "The office called. Monday at 1 PM is confirmed." },
    });
    expect(labels(kase)[MON]).toBe("Confirmed · reported by you through Laptop assistant");
    expect(() => records.confirmProposal("p-1", 2)).toThrow(/already confirmed/);
    expect(stale(() => records.confirmProposal("p-1", 1)).currentVersion).toBe(2);
    expect(store.readStream("proposal:p-1").map((e) => e.type)).toEqual(["change_proposed", "proposal_confirmed"]);
  });

  it("takes the agent name from the grant, not from the input", async () => {
    const { records } = await setup(["m2"]);
    expect(() =>
      records.propose({ kind: "user_report", claim_type: "confirm", date: "2026-11-16", time: "13:00", statement: "x", agent_name: "Someone else" }, GRANT),
    ).toThrow(InvalidRequestError);
  });

  it("a rejected proposal changes nothing", async () => {
    const { records, kase } = await setup(["m2", "m3"]);
    const before = labels(kase);
    records.propose({ kind: "user_report", claim_type: "cancel", date: "2026-11-12", time: "10:30", statement: "Cancel Thursday." }, GRANT);
    expect(records.rejectProposal("p-1", 1)).toMatchObject({ status: "rejected" });
    expect(labels(kase)).toEqual(before);
    expect(() => records.confirmProposal("p-1", 2)).toThrow(/already rejected/);
  });

  it("a new appointment and a corrected place apply only on confirm", async () => {
    const { records, kase } = await setup(["m2"]);
    expect(() =>
      records.propose({ kind: "new_appointment", date: "2026-11-12", time: "10:30", status: "confirmed", statement: "x" }, GRANT),
    ).toThrow(/already exists/);
    records.propose({ kind: "new_appointment", date: "2026-11-20", time: "08:00", location: "Elm Street office", status: "offered", statement: "They offered Friday the 20th." }, GRANT);
    records.propose({ kind: "detail_edit", appointment_id: THU, expected_version: 0, location: "Lantern Hill Clinic, 400 Elm Street, Suite 3", statement: "Suite 3, not 2." }, GRANT);
    expect(kase.view().slots.map((s) => s.key)).toEqual([THU]);
    records.confirmProposal("p-1", 1);
    records.confirmProposal("p-2", 1);
    const slots = kase.view().slots;
    expect(slots.map((s) => [s.key, s.stateLabel])).toEqual([
      [THU, "Confirmed · office message"],
      ["2026-11-20T08:00", "Offered · reported by you through Laptop assistant"],
    ]);
    expect(slots[0]!.location).toBe("Lantern Hill Clinic, 400 Elm Street, Suite 3");
  });

  it("checks proposals with the app's rules", async () => {
    const { records } = await setup(["m2"]);
    const bad = [
      { kind: "user_report", claim_type: "confirm", date: "2026-11-31", time: "13:00", statement: "x" },
      { kind: "user_report", claim_type: "confirm", date: "2026-11-16", time: "1 PM", statement: "x" },
      { kind: "user_report", claim_type: "office_request", date: null, statement: "x" },
      { kind: "user_report", claim_type: "confirm", date: null, statement: "x" },
      { kind: "user_report", claim_type: "clarify", date: "2026-11-16", statement: "x" },
      { kind: "user_report", claim_type: "confirm", date: "2026-11-16", statement: "x".repeat(501) },
      { kind: "set_state", appointment_id: THU, state: "canceled", statement: "x" },
      { kind: "archive", appointment_id: THU, statement: "x" },
    ];
    for (const input of bad) expect(() => records.propose(input, GRANT), JSON.stringify(input)).toThrow(InvalidRequestError);
    expect(records.proposals()).toEqual([]);
  });

  it("refuses an archive or edit proposal made on a stale record", async () => {
    const { records } = await setup(["m2"]);
    records.addNote(THU, "app note", 0, USER);
    expect(stale(() => records.propose({ kind: "archive", appointment_id: THU, expected_version: 0, statement: "Old." }, GRANT)).currentVersion).toBe(1);
    const p = records.propose({ kind: "archive", appointment_id: THU, expected_version: 1, statement: "Old." }, GRANT);
    expect(() => records.confirmProposal(p.id, 1)).toThrow(/record version/);
    records.addNote(THU, "another app note", 1, USER);
    expect(stale(() => records.confirmProposal(p.id, 1, { recordVersion: 1 })).currentVersion).toBe(2);
    expect(records.confirmProposal(p.id, 1, { recordVersion: 2 })).toMatchObject({ status: "confirmed", evidenceIds: [] });
    expect(records.record(THU)).toMatchObject({ archived: true, version: 3 });
    expect(records.record(THU).history.at(-1)).toMatchObject({ type: "record_archived", by: { kind: "user" } });
  });
});

describe("access log stream", () => {
  it("appends system events without an expected version", async () => {
    const { records, store } = await setup(["m2"]);
    records.logAccess({ grant_id: "g-1", grant_name: "Laptop assistant", tool: "list_appointments", result: "ok", appointment_id: null });
    records.logAccess({ grant_id: null, grant_name: null, tool: "add_note", result: "permission_denied", appointment_id: THU });
    expect(store.readStream("access_log").map((e) => e.version)).toEqual([1, 2]);
    expect(records.accessLog().map((e) => [e.grant_name, e.tool, e.result])).toEqual([
      ["Laptop assistant", "list_appointments", "ok"],
      [null, "add_note", "permission_denied"],
    ]);
  });
});
