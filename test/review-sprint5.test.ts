// Sprint 5 review round 1. Each test is built from the failing case the
// review describes.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../mcp/rate-limit.ts";
import { createMcpServer, type McpDeps } from "../mcp/server.ts";
import { createApi } from "../server/api.ts";
import { buildChecklist } from "../src/case/checklist.ts";
import { caseHistory } from "../src/case/history.ts";
import { CaseService } from "../src/case/service.ts";
import { OutOfScopeError } from "../src/domain/scope.ts";
import { readFixtureText } from "../src/fixtures/load.ts";
import { GrantStore } from "../src/grants/grants.ts";
import type { ModelCall, ModelClient } from "../src/model/client.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { USER, proposalStream } from "../src/records/events.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { CaseDeletedError, EventStore, type StoreOptions, type StoredEvent } from "../src/store/event-log.ts";
import { acceptMessages, ev, fixtureMessage, intake } from "./helpers.ts";
import { IntakeService } from "../src/intake/service.ts";

const CLOCK = () => "2026-11-06T17:00:00.000Z";
const THU = "2026-11-12T10:30";
const MARKER = "Rv1-erase-marker-9052";

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "sp5-review-"));
  dirs.push(dir);
  return { dir, file: path.join(dir, "app.sqlite") };
}

// A model client that holds every call until the test releases it.
function gated() {
  const base = RecordedModelClient.fromDirectory();
  let release!: () => void;
  let called!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (called = r));
  const client: ModelClient = {
    label: "gated",
    call: async (request: ModelCall) => {
      called();
      await gate;
      return base.call(request);
    },
  };
  return { client, release, reached };
}

function services(store: EventStore, client: ModelClient = RecordedModelClient.fromDirectory()) {
  const svc = intake(store);
  const kase = new CaseService(store, svc, client, { userName: "Dana Reyes" });
  return {
    store,
    intake: svc,
    kase,
    reply: new ReplyService(store, kase, client),
    records: new RecordsService(store, svc, kase),
    grants: new GrantStore(store),
  };
}

async function connect(deps: McpDeps) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(deps), { transport: serverSide });
  const client = new Client({ name: "test-agent", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
  });
  return client;
}

type Result = Awaited<ReturnType<Client["callTool"]>>;
const errorOf = (r: Result) => {
  expect(r.isError).toBe(true);
  expect(r.structuredContent).toBeUndefined();
  return JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { error: string; message: string };
};

// An MCP-side store whose Nth write transaction first lets the app delete
// the case, as another process would between the tool's reads and its write.
class DeleteBeforeWrite extends EventStore {
  count = 0;
  at = 0;
  deleteNow: () => void = () => {};
  override transaction<T>(fn: () => T): T {
    if (++this.count === this.at) this.deleteNow();
    return super.transaction(fn);
  }
}

async function crossProcess(options: StoreOptions = {}) {
  const { dir, file } = tempFile();
  const app = services(new EventStore(file, CLOCK));
  cleanups.push(() => app.store.close());
  await acceptMessages(app.intake, ["m1", "m2", "m3"]);
  const { token } = app.grants.create("Laptop assistant", "propose");
  const mcpStore = new DeleteBeforeWrite(file, CLOCK, options);
  cleanups.push(() => mcpStore.close());
  const mcp = services(mcpStore);
  mcpStore.deleteNow = () => app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
  const client = await connect({ records: mcp.records, grants: mcp.grants, token, limiter: new RateLimiter(mcpStore) });
  return { dir, app, mcp, mcpStore, client };
}

const caseEvents = (store: EventStore) => store.readAll().filter((e) => !e.streamId.startsWith("grant:"));

describe("finding 1: a write that started before Delete case never lands in the empty case", () => {
  it("explain, askNext and suggest waiting on the model fail with CaseDeletedError and write nothing", async () => {
    for (const command of ["explain", "askNext", "suggest"] as const) {
      const { client, release, reached } = gated();
      const app = services(new EventStore(":memory:", CLOCK), client);
      await acceptMessages(app.intake, ["m2", "m3"]);
      const view = app.kase.view();
      const conflict = view.conflicts[0]!;
      // Each command's stream is empty, so its expected version is 0, the
      // same as after a delete.
      expect([conflict.version, view.questionsVersion, view.reply.version]).toEqual([0, 0, 0]);
      const pending =
        command === "explain"
          ? app.kase.explain(conflict.id, 0)
          : command === "askNext"
            ? app.kase.askNext(0)
            : app.reply.suggest("I want Monday.", 0);
      await reached;
      app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
      release();
      await expect(pending, command).rejects.toBeInstanceOf(CaseDeletedError);
      expect(caseEvents(app.store), command).toEqual([]);
      expect(app.kase.view()).toMatchObject({ slots: [], conflicts: [], question: null, reply: { draft: null, version: 0, suggestion: null } });
      app.store.close();
    }
  });

  it("an MCP add_note at expected_version 0 fails when the delete commits between its read and its write", async () => {
    const { client, app, mcpStore } = await crossProcess();
    // Step 1 is transaction 1. The note's append is transaction 2.
    mcpStore.at = 2;
    const err = errorOf(await client.callTool({ name: "add_note", arguments: { appointment_id: THU, text: `Parking ${MARKER}`, expected_version: 0 } }));
    expect(err).toMatchObject({ error: "not_found", message: expect.stringMatching(/deleted the case during this call\. Nothing was saved/) });
    expect(caseEvents(app.store)).toEqual([]);
    expect(app.records.record(THU)).toMatchObject({ version: 0, notes: [] });
  });

  it("an MCP propose_change of kind user_report or new_appointment fails the same way", async () => {
    const changes = [
      { kind: "user_report", claim_type: "confirm", date: "2026-11-16", time: "13:00", statement: `Dana confirmed Monday ${MARKER}` },
      { kind: "new_appointment", date: "2026-11-20", time: "09:00", status: "offered", statement: `A new time ${MARKER}` },
    ];
    for (const change of changes) {
      const { client, app, mcpStore } = await crossProcess();
      mcpStore.at = 2;
      const err = errorOf(await client.callTool({ name: "propose_change", arguments: { change } }));
      expect(err.error, change.kind).toBe("not_found");
      expect(caseEvents(app.store), change.kind).toEqual([]);
      expect(app.records.proposals()).toEqual([]);
    }
  });

  it("a page opened before Delete case cannot write into the empty case through the API", async () => {
    const store = new EventStore(":memory:", CLOCK);
    const app = services(store);
    const api = createApi(app.intake, app.kase, { mode: "recorded" }, app.reply, app);
    const before = (await api({ method: "GET", path: "/api/state", body: undefined })).body as { generation: number; caseVersion: number };
    expect(before.generation).toBe(0);
    await api({ method: "POST", path: "/api/case/delete", body: { expectedVersion: before.caseVersion, confirmation: "DELETE" }, generation: 0 });
    // The calendar stream is empty in both cases, so its version 0 matches.
    const stale = await api({
      method: "POST",
      path: "/api/calendar",
      body: { name: "dana.ics", text: readFixtureText("calendar/dana.ics"), expectedVersion: 0 },
      generation: before.generation,
    });
    expect(stale).toMatchObject({ status: 409, body: { error: "case_deleted" } });
    expect(caseEvents(store)).toEqual([]);
    const now = (await api({ method: "GET", path: "/api/state", body: undefined })).body as { generation: number };
    expect(now.generation).toBe(1);
    const fresh = await api({
      method: "POST",
      path: "/api/calendar",
      body: { name: "dana.ics", text: readFixtureText("calendar/dana.ics"), expectedVersion: 0 },
      generation: now.generation,
    });
    expect(fresh.status).toBe(200);
  });
});

describe("finding 2: no access log entry from before Delete case reaches the empty case", () => {
  it("a read that passed step 1 before the delete returns no data and logs nothing", async () => {
    const { client, app, mcpStore } = await crossProcess();
    // A read tool writes only in step 1 and step 3.
    mcpStore.at = 2;
    const err = errorOf(await client.callTool({ name: "list_appointments", arguments: {} }));
    expect(err.error).toBe("not_found");
    expect(JSON.stringify(err)).not.toContain(THU);
    expect(app.records.accessLog()).toEqual([]);
    expect(caseEvents(app.store)).toEqual([]);
  });

  it("a busy call's waiting entry is dropped, not written, once the case is deleted", async () => {
    const { client, app } = await crossProcess({ busyTimeoutMs: 20, lockRetryMs: [] });
    app.store.unsafeExecForTest("BEGIN IMMEDIATE");
    expect(errorOf(await client.callTool({ name: "list_appointments", arguments: {} })).error).toBe("busy");
    app.store.unsafeExecForTest("COMMIT");
    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    const after = await client.callTool({ name: "list_appointments", arguments: {} });
    expect(after.structuredContent).toEqual({ appointments: [] });
    expect(app.records.accessLog().map((e) => [e.tool, e.result])).toEqual([["list_appointments", "ok"]]);
  });
});

describe("finding 3: a Delete case that stops before compaction is finished at the next start", () => {
  class CrashAfterCommit extends EventStore {
    override finishPendingErase(): boolean {
      throw new Error("The process stopped here.");
    }
  }
  const filesWith = (dir: string, text: string) => readdirSync(dir).filter((f) => readFileSync(path.join(dir, f)).includes(Buffer.from(text, "utf8")));

  async function crashed() {
    const { dir, file } = tempFile();
    const store = new CrashAfterCommit(file, CLOCK);
    cleanups.push(() => store.close());
    const app = services(store);
    await acceptMessages(app.intake, ["m2"]);
    app.records.addNote(THU, `Parking ${MARKER}`, 0, USER);
    expect(() => app.kase.deleteCase(app.kase.caseVersion(), "DELETE")).toThrow("The process stopped here.");
    // The delete committed: the case looks empty, but the text is still on disk.
    expect(caseEvents(store)).toEqual([]);
    expect(store.erasePending()).toBe(true);
    expect(filesWith(dir, MARKER).length).toBeGreaterThan(0);
    return { dir, file };
  }

  it("the store finishes it before anything else, and clears the mark only after", async () => {
    const { dir, file } = await crashed();
    const reopened = new EventStore(file);
    cleanups.push(() => reopened.close());
    expect(reopened.erasePending()).toBe(true);
    expect(reopened.finishPendingErase()).toBe(true);
    expect(reopened.erasePending()).toBe(false);
    expect(filesWith(dir, MARKER)).toEqual([]);
    expect(reopened.finishPendingErase()).toBe(false);
  });

  it("the MCP server finishes it at start, before it serves", async () => {
    const { dir, file } = await crashed();
    const seed = new EventStore(file);
    const { token } = new GrantStore(seed).create("Laptop assistant", "read");
    seed.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(PACKAGE_ROOT, "mcp/main.ts")],
      cwd: PACKAGE_ROOT,
      env: { ...getDefaultEnvironment(), APP_DB: file, APPT_GRANT_TOKEN: token },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: "test-agent", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(transport);
    cleanups.push(() => client.close());
    expect((await client.callTool({ name: "list_appointments", arguments: {} })).structuredContent).toEqual({ appointments: [] });
    expect(filesWith(dir, MARKER)).toEqual([]);
    const check = new EventStore(file);
    cleanups.push(() => check.close());
    expect(check.erasePending()).toBe(false);
    expect(stderr).toBe("");
  }, 20_000);
});

describe("finding 4: history labels carry no free text", () => {
  it("leaves out the calendar file name, tag text and choice labels", () => {
    const at = "2026-11-06T17:00:00.000Z";
    const events: StoredEvent[] = [
      { seq: 1, streamId: "calendar", version: 1, type: "calendar_loaded", data: { name: `dana-${MARKER}.ics`, text: "" }, recordedAt: at },
      { seq: 2, streamId: `record:${THU}`, version: 1, type: "tags_set", data: { tags: [`${MARKER}`, "moved"], by: USER }, recordedAt: at },
      {
        seq: 3,
        streamId: "questions",
        version: 2,
        type: "question_answered",
        // A place choice label is built from message text.
        data: { question_id: "q1", choice_id: "place:1", label: `${MARKER} Street is right`, evidence_ids: [], settled_evidence_ids: [] },
        recordedAt: at,
      },
    ];
    expect(caseHistory(events).map((h) => h.label)).toEqual([
      "Calendar loaded",
      `Tags on ${THU} set by you (2 tags)`,
      "Question q1 answered (choice place:1)",
    ]);
  });
});

describe("finding 5: a stored proposal is checked again when the user confirms it", () => {
  it("refuses a clinical proposal stored before the check existed, and writes nothing", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    await acceptMessages(app.intake, ["m2"]);
    const { grant } = app.grants.create("Laptop assistant", "propose");
    // Written straight to the store, as a sprint 4 build would have.
    app.store.append(proposalStream("p-old"), 0, [
      {
        type: "change_proposed",
        data: {
          grant_id: grant.id,
          grant_name: grant.name,
          change: { kind: "user_report", claim_type: "office_request", date: null, time: null, location: null, request_item: "Stop the medication", statement: "The office called." },
          record_version: null,
        },
      },
    ]);
    const count = app.store.readAll().length;
    expect(() => app.records.confirmProposal("p-old", 1)).toThrow(OutOfScopeError);
    expect(app.store.readAll()).toHaveLength(count);
    expect(app.records.proposal("p-old").status).toBe("pending");
    expect(app.kase.view().checklist.map((i) => i.text)).toEqual(["Bring new insurance card", "Arrive 15 minutes early"]);
  });
});

describe("finding 6: the checklist merges requests that differ only in punctuation", () => {
  it("strips marks, quotes and brackets at either end", () => {
    const AT = "2026-11-01T10:00:00.000Z";
    const req = (id: string, item: string) => ev(id, "office_request", null, null, AT, { request_item: item, quote: item });
    const items = buildChecklist([
      req("a", "Bring new insurance card"),
      req("b", "Bring new insurance card?"),
      req("c", "“Bring new insurance card.”"),
      req("d", "(Bring new insurance card!)"),
      req("e", "Bring new insurance card…"),
      req("f", "Bring the new insurance card"),
    ]);
    expect(items.map((i) => [i.text, i.sources.map((s) => s.evidenceId)])).toEqual([
      ["Bring new insurance card", ["a", "b", "c", "d", "e"]],
      ["Bring the new insurance card", ["f"]],
    ]);
  });
});

describe("review round 2, B1: every write states its case generation", () => {
  it("refuses a write with no generation or a malformed one, and writes nothing", async () => {
    const store = new EventStore(":memory:", CLOCK);
    const app = services(store);
    const api = createApi(app.intake, app.kase, { mode: "recorded" }, app.reply, app);
    const calendar = { name: "dana.ics", text: readFixtureText("calendar/dana.ics"), expectedVersion: 0 };
    for (const generation of [undefined, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await api({ method: "POST", path: "/api/calendar", body: calendar, generation }), String(generation)).toMatchObject({
        status: 400,
        body: { error: "generation_required" },
      });
    }
    expect(caseEvents(store)).toEqual([]);
    // The failing case from the review: after Delete case, the stale page's
    // request without the header no longer lands in the empty case.
    expect((await api({ method: "POST", path: "/api/calendar", body: calendar, generation: 0 })).status).toBe(200);
    const state = (await api({ method: "GET", path: "/api/state", body: undefined })).body as { caseVersion: number };
    expect((await api({ method: "POST", path: "/api/case/delete", body: { expectedVersion: state.caseVersion, confirmation: "DELETE" }, generation: 0 })).status).toBe(200);
    expect((await api({ method: "POST", path: "/api/calendar", body: calendar })).status).toBe(400);
    expect((await api({ method: "POST", path: "/api/calendar", body: calendar, generation: 0 })).body).toMatchObject({ error: "case_deleted" });
    expect(caseEvents(store)).toEqual([]);
    // Reads need no generation.
    expect((await api({ method: "GET", path: "/api/state", body: undefined })).status).toBe(200);
  });
});

describe("review round 2, B2: finishing one erase never clears the mark of a later one", () => {
  const filesWith = (dir: string, text: string) => readdirSync(dir).filter((f) => readFileSync(path.join(dir, f)).includes(Buffer.from(text, "utf8")));
  const SECOND = "Rv2-second-case-marker-3318";

  // Process A pauses after its compaction and before it clears the mark.
  class PausingStore extends EventStore {
    onPause: (() => void) | null = null;
    protected override beforeClearPending(): void {
      const pause = this.onPause;
      this.onPause = null;
      pause?.();
    }
  }
  // Process B stops right after its delete commits.
  class StopsAfterCommit extends EventStore {
    override finishPendingErase(): boolean {
      throw new Error("B stopped here.");
    }
  }

  it("A's late clear leaves B's mark, and the next start clears B's text", async () => {
    const { dir, file } = tempFile();
    const a = services(new PausingStore(file, CLOCK));
    cleanups.push(() => a.store.close());
    await acceptMessages(a.intake, ["m2"]);
    const bStore = new StopsAfterCommit(file, CLOCK);
    cleanups.push(() => bStore.close());
    const b = services(bStore);

    (a.store as PausingStore).onPause = () => {
      // While A is paused, B writes a new case and deletes it.
      b.intake.importMessage({ id: "later-1", channel: "email", from: "Front Desk", received_at: "2026-11-07T09:00:00-07:00", text: `Bring the form ${SECOND}.` });
      expect(() => b.kase.deleteCase(b.kase.caseVersion(), "DELETE")).toThrow("B stopped here.");
      expect(a.store.caseGeneration()).toBe(2);
    };
    a.kase.deleteCase(a.kase.caseVersion(), "DELETE");

    // A finished generation 1 and left the mark for generation 2.
    expect(a.store.erasePending()).toBe(true);
    expect(filesWith(dir, SECOND).length).toBeGreaterThan(0);
    // The next start finishes B's erase.
    const next = new EventStore(file);
    cleanups.push(() => next.close());
    expect(next.finishPendingErase()).toBe(true);
    expect(next.erasePending()).toBe(false);
    expect(filesWith(dir, SECOND)).toEqual([]);
  });
});

describe("review round 2, B3: every public write of the case services runs as one case command", () => {
  // Fails any write transaction that does not run inside inCase.
  class ScopedOnly extends EventStore {
    strict = false;
    override transaction<T>(fn: () => T): T {
      if (this.strict && !this.inCaseScope()) throw new Error("A case write ran outside inCase.");
      return super.transaction(fn);
    }
  }

  // Reads, and the scope and transaction primitives the MCP server uses.
  const NOT_WRITES: Record<string, string[]> = {
    IntakeService: ["modelLabel", "message", "evidenceItem", "messages", "evidence", "reviewQueue", "acceptedEvidence"],
    CaseService: ["view", "history", "caseVersion", "replyState", "generation", "inCase", "erasePending", "archivedKeys", "liveVersion"],
    ReplyService: [],
    RecordsService: ["transaction", "withWriteGuard", "caseGeneration", "inCase", "record", "appointments", "appointment", "openQuestions", "proposals", "proposal", "reviewQueue", "accessLog"],
  };
  const classes = { IntakeService, CaseService, ReplyService, RecordsService };
  const publicMethods = (cls: { prototype: object }) => Object.getOwnPropertyNames(cls.prototype).filter((n) => n !== "constructor");

  it("exercises each one under a store that refuses unscoped writes", async () => {
    const store = new ScopedOnly(":memory:", CLOCK);
    const app = services(store);
    const { grant } = app.grants.create("Laptop assistant", "propose");
    const agent = { kind: "agent" as const, grant_id: grant.id, grant_name: grant.name };
    store.strict = true;

    const called = new Map<string, Set<string>>(Object.keys(classes).map((k) => [k, new Set<string>()]));
    const step = async (cls: keyof typeof classes, name: string, run: () => unknown) => {
      called.get(cls)!.add(name);
      await run();
    };
    const acceptAll = async () => {
      for (const e of app.intake.reviewQueue()) await step("IntakeService", "accept", () => app.intake.accept(e.id, e.version));
    };
    for (const id of ["m2", "m3"]) {
      const m = await (async () => {
        let view!: ReturnType<IntakeService["importMessage"]>;
        await step("IntakeService", "importMessage", () => (view = app.intake.importMessage(fixtureMessage(id))));
        return view;
      })();
      await step("IntakeService", "extract", () => app.intake.extract(id, { effort: "minimal", expectedVersion: m.version }));
      await acceptAll();
    }
    await step("IntakeService", "importMessage", () =>
      app.intake.importMessage({ id: "pasted-1", channel: "email", from: "Front Desk", received_at: "2026-11-05T09:00:00-07:00", text: "Please bring the form." }),
    );
    await step("IntakeService", "enterManually", () =>
      app.intake.enterManually("pasted-1", 1, { claim_type: "office_request", date: null, time: null, location: null, quote: null, request_item: "the form" }),
    );
    const manual = app.intake.reviewQueue()[0]!;
    await step("IntakeService", "reject", () => app.intake.reject(manual.id, manual.version));

    await step("CaseService", "loadCalendar", () => app.kase.loadCalendar("dana.ics", readFixtureText("calendar/dana.ics"), 0));
    const conflict = app.kase.view().conflicts[0]!;
    await step("CaseService", "explain", () => app.kase.explain(conflict.id, conflict.version));
    await step("CaseService", "askNext", () => app.kase.askNext(app.kase.view().questionsVersion));
    let view = app.kase.view();
    const monday = view.question!.choices.find((c) => c.label.includes("Monday"))!;
    await step("CaseService", "answer", () => app.kase.answer(view.question!.id, monday.id, view.questionsVersion, view.reply.version));
    view = app.kase.view();
    await step("ReplyService", "edit", () => app.reply.edit(view.reply.draft!.id, "Monday works for me.", view.reply.version));
    view = app.kase.view();
    await step("ReplyService", "discard", () => app.reply.discard(view.reply.draft!.id, view.reply.version));
    await step("ReplyService", "suggest", () => app.reply.suggest("I want Monday.", app.kase.view().reply.version));
    await step("ReplyService", "start", () => app.reply.start("accept_offer", "2026-11-16T13:00", app.kase.view().reply.version));
    view = app.kase.view();
    await step("ReplyService", "approve", () => app.reply.approve(view.reply.draft!.id, view.reply.draft!.fields.map((f) => f.name), view.reply.version));

    await step("RecordsService", "addNote", () => app.records.addNote(THU, "Parking is on Elm Street.", 0, USER));
    await step("RecordsService", "setTags", () => app.records.setTags(THU, ["moved"], 1, agent));
    await step("RecordsService", "archive", () => app.records.archive(THU, 2));
    await step("RecordsService", "undo", () => app.records.undo(THU, 3, 3));
    const report = { kind: "user_report", claim_type: "confirm", date: "2026-11-16", time: "13:00", statement: "Dana confirmed Monday by phone." };
    let p = app.records.proposals()[0];
    await step("RecordsService", "propose", () => (p = app.records.propose(report, grant)));
    await step("RecordsService", "confirmProposal", () => app.records.confirmProposal(p!.id, p!.version));
    await step("RecordsService", "propose", () => (p = app.records.propose({ ...report, statement: "Dana said it again." }, grant)));
    await step("RecordsService", "rejectProposal", () => app.records.rejectProposal(p!.id, p!.version));
    await step("RecordsService", "logAccess", () =>
      app.records.logAccess({ grant_id: grant.id, grant_name: grant.name, tool: "list_appointments", result: "ok", appointment_id: null }),
    );
    await step("CaseService", "deleteCase", () => app.kase.deleteCase(app.kase.caseVersion(), "DELETE"));
    expect(caseEvents(store)).toEqual([]);

    // Every public method is a read or a write this test exercised, so a
    // new write fails here until it is added and shown to run in scope.
    for (const [name, cls] of Object.entries(classes)) {
      const writes = publicMethods(cls).filter((m) => !NOT_WRITES[name]!.includes(m));
      expect([...called.get(name)!].sort(), name).toEqual(writes.sort());
    }
  });

  it("the strict store does catch an unscoped write", () => {
    const store = new ScopedOnly(":memory:", CLOCK);
    store.strict = true;
    expect(() => store.append("calendar", 0, [{ type: "calendar_loaded", data: { name: "x", text: "" } }])).toThrow("A case write ran outside inCase.");
    expect(store.inCase(() => store.append("calendar", 0, [{ type: "calendar_loaded", data: { name: "x", text: "" } }]))).toHaveLength(1);
  });

  it("the failing case from the review: archive on a never-written record after another process deleted the case", async () => {
    const { file } = tempFile();
    const app = services(new EventStore(file, CLOCK));
    cleanups.push(() => app.store.close());
    await acceptMessages(app.intake, ["m2"]);
    const other = new DeleteBeforeWrite(file, CLOCK);
    cleanups.push(() => other.close());
    const direct = services(other);
    other.deleteNow = () => app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    // archive reads the slot, then writes in its first transaction.
    other.at = 1;
    expect(() => direct.records.archive(THU, 0)).toThrow(CaseDeletedError);
    expect(caseEvents(app.store)).toEqual([]);
  });
});
