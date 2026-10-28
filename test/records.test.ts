// SP4.1 to SP4.3 at the domain level: notes, tags, archive and undo on
// appointment records, by the person or an agent (0009). Old cases with
// grants and agent proposals still project.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaseService } from "../src/case/service.ts";
import { InvalidRequestError, NotFoundError } from "../src/intake/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { USER, actorFor, actorName, type Actor } from "../src/records/events.ts";
import { RecordsService } from "../src/records/service.ts";
import { EventStore, StaleEditError, type Describe } from "../src/store/event-log.ts";
import { acceptMessages, intake } from "./helpers.ts";

const THU = "2026-11-12T10:30";
const MON = "2026-11-16T13:00";
const AGENT: Actor = actorFor("mcp");

// After every fixture message.
const CLOCK = () => "2026-11-06T17:00:00.000Z";

async function setup(ids: string[]) {
  const store = new EventStore(":memory:", CLOCK);
  const service = intake(store);
  await acceptMessages(service, ids);
  const kase = new CaseService(store, service, RecordedModelClient.fromDirectory());
  const records = new RecordsService(store, service, kase);
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

describe("access log stream", () => {
  it("appends system events without an expected version, and reads entries from before sprint 8", async () => {
    const { records, store } = await setup(["m2"]);
    store.appendSystem("access_log", [
      { type: "tool_called", data: { grant_id: "g-1", grant_name: "Laptop assistant", tool: "list_appointments", result: "permission_denied", appointment_id: null } },
    ]);
    records.logAccess({ actor: "mcp", tool: "get_schedule", result: "ok", appointment_id: null });
    records.logAccess({ actor: "mcp", tool: "add_note", result: "refused", appointment_id: THU });
    expect(store.readStream("access_log").map((e) => e.version)).toEqual([1, 2, 3]);
    expect(records.accessLog().map((e) => [e.actor ?? e.grant_name, e.tool, e.result])).toEqual([
      ["Laptop assistant", "list_appointments", "permission_denied"],
      ["mcp", "get_schedule", "ok"],
      ["mcp", "add_note", "refused"],
    ]);
  });
});

describe("agents in records", () => {
  it("names the assistant and an external agent by code, and an old grant by its name", async () => {
    const { records } = await setup(["m2"]);
    records.addNote(THU, "from the chat", 0, actorFor("agent"));
    records.addNote(THU, "over MCP", 1, actorFor("mcp"));
    const old: Actor = { kind: "agent", grant_id: "g-1", grant_name: "Laptop assistant" };
    records.addNote(THU, "from a grant", 2, old);
    expect(records.record(THU).notes.map((n) => actorName(n.by))).toEqual(["the assistant", "an external agent", "Laptop assistant"]);
    expect(actorName(USER)).toBe("you");
  });

  it("an agent archives and unarchives, and unarchive is the undo of the archive in effect", async () => {
    const { records } = await setup(["m2"]);
    records.archive(THU, 0, actorFor("agent"));
    expect(() => records.unarchive(THU, 0, actorFor("agent"))).toThrow(StaleEditError);
    const back = records.unarchive(THU, 1, actorFor("agent"));
    expect(back).toMatchObject({ archived: false, version: 2 });
    expect(back.history.map((h) => [h.type, h.undone, h.reverses])).toEqual([
      ["record_archived", true, null],
      ["event_undone", false, 1],
    ]);
    expect(() => records.unarchive(THU, 2, actorFor("agent"))).toThrow(/not archived/);
  });

  it("old cases with grants, proposals and confirmed agent reports still project", async () => {
    const { store, kase, intake: svc } = await setup(["m2"]);
    store.append("grant:g-1", 0, [{ type: "grant_created", data: { name: "Phone helper", tier: "propose", token_sha256: "00" } }]);
    store.append("proposal:p-1", 0, [
      { type: "change_proposed", data: { grant_id: "g-1", grant_name: "Phone helper", change: { kind: "archive", appointment_id: THU, statement: "Old." }, record_version: 0 } },
    ]);
    store.append("evidence:p-2-1", 0, [
      {
        type: "agent_report_confirmed",
        data: {
          proposal_id: "p-2",
          grant_id: "g-1",
          claim: {
            claim_type: "offer",
            slot: { date: "2026-11-20", time: "09:00", location: null },
            quote: "They also offered Friday the 20th.",
            source_type: "reported_by_user_via_agent",
            sender_kind: "person",
            evidence_time: "2026-11-06T17:00:00.000Z",
            event_time: null,
            request_item: null,
            agent_name: "Phone helper",
          },
        },
      },
    ]);
    expect(labels(kase)).toMatchObject({ [THU]: "Confirmed · office message", "2026-11-20T09:00": "Offered · reported by you through Phone helper" });
    expect(svc.evidenceItem("p-2-1").origin).toBe("agent");
    expect(kase.history().some((h) => h.streamId.startsWith("grant:") || h.streamId.startsWith("proposal:"))).toBe(false);
  });
});

describe("review round 1", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("finding 2: no write from another process lands between the version check and an agent's archive", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "records-race-"));
    dirs.push(dir);
    const file = path.join(dir, "app.sqlite");
    // The app's connection fails at once on a held lock instead of waiting.
    const app = new EventStore(file, CLOCK);
    app.unsafeExecForTest("PRAGMA busy_timeout = 0");
    const appIntake = intake(app);
    await acceptMessages(appIntake, ["m2"]);
    const appRecords = new RecordsService(app, appIntake, new CaseService(app, appIntake, RecordedModelClient.fromDirectory()));

    // The agent's connection. Right after its version check passes, the app
    // tries to add a note to the same record.
    let gapWrite: unknown = "not tried";
    class GapStore extends EventStore {
      override assertVersion(streamId: string, expectedVersion: number, describe?: Describe): void {
        super.assertVersion(streamId, expectedVersion, describe);
        if (streamId === `record:${THU}` && gapWrite === "not tried") {
          try {
            appRecords.addNote(THU, "written in the gap", 0, USER);
            gapWrite = "written";
          } catch (err) {
            gapWrite = err;
          }
        }
      }
    }
    const agent = new GapStore(file, CLOCK);
    const agentIntake = intake(agent);
    const agentRecords = new RecordsService(agent, agentIntake, new CaseService(agent, agentIntake, RecordedModelClient.fromDirectory()));
    try {
      const r = agentRecords.archive(THU, 0, AGENT);
      expect(String(gapWrite)).toMatch(/locked|busy/i);
      expect(r).toMatchObject({ archived: true, version: 1 });
      expect(appRecords.record(THU).notes).toEqual([]);
    } finally {
      agent.close();
      app.close();
    }
  });

  it("finding 7: only the latest tag change still in effect can be undone", async () => {
    const { records, store } = await setup(["m2"]);
    records.setTags(THU, ["a"], 0, USER);
    records.setTags(THU, ["b"], 1, USER);
    const before = store.readStream(`record:${THU}`).length;
    expect(() => records.undo(THU, 1, 2)).toThrow(/Only the latest tag change can be undone\. That is the one at version 2\./);
    expect(store.readStream(`record:${THU}`)).toHaveLength(before);
    expect(records.undo(THU, 2, 2).tags).toEqual(["a"]);
    // Now version 1 is the latest tag change in effect.
    expect(records.undo(THU, 1, 3).tags).toEqual([]);
  });
});
