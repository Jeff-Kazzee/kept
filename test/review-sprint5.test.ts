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
import { CaseActions } from "../src/actions/service.ts";
import type { ModelCall, ModelClient } from "../src/model/client.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { USER, actorFor } from "../src/records/events.ts";
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
  const reply = new ReplyService(store, kase, client);
  const records = new RecordsService(store, svc, kase);
  return { store, intake: svc, kase, reply, records, actions: new CaseActions(store, { intake: svc, kase, reply, records }) };
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
  const mcpStore = new DeleteBeforeWrite(file, CLOCK, options);
  cleanups.push(() => mcpStore.close());
  const mcp = services(mcpStore);
  mcpStore.deleteNow = () => app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
  const client = await connect({ store: mcpStore, services: mcp, limiter: new RateLimiter() });
  return { dir, app, mcp, mcpStore, client };
}

// Settings are kept on Delete case. Everything else is case data.
const caseEvents = (store: EventStore) => store.readAll().filter((e) => e.streamId !== "settings");

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
    // The note and its activity entry are transaction 1.
    mcpStore.at = 1;
    const err = errorOf(await client.callTool({ name: "add_note", arguments: { slot_key: THU, text: `Parking ${MARKER}`, expected_version: 0 } }));
    expect(err).toMatchObject({ error: "not_found", message: expect.stringMatching(/deleted the case during this call\. Nothing was saved/) });
    expect(caseEvents(app.store)).toEqual([]);
    expect(app.records.record(THU)).toMatchObject({ version: 0, notes: [] });
  });

  it("an MCP accept_claim or set_timezone fails the same way", async () => {
    const calls = [
      { name: "accept_claim", arguments: { claims: [{ evidence_id: "m3-e3", expected_version: 2 }] } },
      { name: "set_timezone", arguments: { timezone: "Asia/Tokyo", expected_version: 0 } },
    ];
    for (const call of calls) {
      const { client, app, mcpStore } = await crossProcess();
      // The action and its activity entry are transaction 1.
      mcpStore.at = 1;
      const r = await client.callTool(call);
      expect(r.isError, call.name).toBe(true);
      expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text).error, call.name).toBe("not_found");
      expect(caseEvents(app.store), call.name).toEqual([]);
    }
  });

  it("a page opened before Delete case cannot write into the empty case through the API", async () => {
    const store = new EventStore(":memory:", CLOCK);
    const app = services(store);
    const api = createApi(app.intake, app.kase, { mode: "recorded" }, app.reply, { store, records: app.records });
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
  it("a read whose case is deleted before its log entry returns no data and logs nothing", async () => {
    const { client, app, mcpStore } = await crossProcess();
    // A read tool writes only its access log entry.
    mcpStore.at = 1;
    const err = errorOf(await client.callTool({ name: "get_schedule", arguments: {} }));
    expect(err.error).toBe("not_found");
    expect(JSON.stringify(err)).not.toContain(THU);
    expect(app.records.accessLog()).toEqual([]);
    expect(caseEvents(app.store)).toEqual([]);
  });

  it("a busy call's waiting entry is dropped, not written, once the case is deleted", async () => {
    const { client, app } = await crossProcess({ busyTimeoutMs: 20, lockRetryMs: [] });
    app.store.unsafeExecForTest("BEGIN IMMEDIATE");
    // A write waits for the lock and gives up. A read answers, and its log
    // entry waits.
    expect(errorOf(await client.callTool({ name: "add_note", arguments: { slot_key: THU, text: "x", expected_version: 0 } })).error).toBe("busy");
    expect((await client.callTool({ name: "get_schedule", arguments: {} })).isError ?? false).toBe(false);
    app.store.unsafeExecForTest("COMMIT");
    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    const after = await client.callTool({ name: "get_schedule", arguments: {} });
    expect((after.structuredContent as { appointments: unknown[] }).appointments).toEqual([]);
    expect(app.records.accessLog().map((e) => [e.tool, e.result])).toEqual([["get_schedule", "ok"]]);
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
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(PACKAGE_ROOT, "mcp/main.ts")],
      cwd: PACKAGE_ROOT,
      env: { ...getDefaultEnvironment(), APP_DB: file },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: "test-agent", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(transport);
    cleanups.push(() => client.close());
    expect(((await client.callTool({ name: "get_schedule", arguments: {} })).structuredContent as { appointments: unknown[] }).appointments).toEqual([]);
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
    const api = createApi(app.intake, app.kase, { mode: "recorded" }, app.reply, { store, records: app.records });
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
    IntakeService: ["modelLabel", "message", "evidenceItem", "messages", "evidence", "reviewQueue", "acceptedEvidence", "verificationProblem"],
    CaseService: ["view", "history", "caseVersion", "replyState", "generation", "inCase", "erasePending", "archivedKeys", "liveVersion", "timeZone", "zoned", "questions"],
    ReplyService: [],
    RecordsService: ["transaction", "caseGeneration", "inCase", "record", "appointments", "appointment", "openQuestions", "accessLog"],
    CaseActions: ["activity", "activityVersion"],
  };
  const classes = { IntakeService, CaseService, ReplyService, RecordsService, CaseActions };
  const publicMethods = (cls: { prototype: object }) => Object.getOwnPropertyNames(cls.prototype).filter((n) => n !== "constructor");

  it("exercises each one under a store that refuses unscoped writes", async () => {
    const store = new ScopedOnly(":memory:", CLOCK);
    const app = services(store);
    const agent = actorFor("mcp");
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
    await step("IntakeService", "undoDecision", () => app.intake.undoDecision("m3-e3"));
    await acceptAll();
    await step("IntakeService", "importMessage", () =>
      app.intake.importMessage({ id: "pasted-1", channel: "email", from: "Front Desk", received_at: "2026-11-05T09:00:00-07:00", text: "Please bring the form." }),
    );
    await step("IntakeService", "enterManually", () =>
      app.intake.enterManually("pasted-1", 1, { claim_type: "office_request", date: null, time: null, location: null, quote: null, request_item: "the form" }),
    );
    const manual = app.intake.reviewQueue()[0]!;
    await step("IntakeService", "reject", () => app.intake.reject(manual.id, manual.version));
    app.intake.importMessage({ id: "pasted-2", channel: "sms", from: "Clinic", received_at: "2026-11-05T09:00:00-07:00", text: "Hello." });
    await step("IntakeService", "withdrawMessage", () => app.intake.withdrawMessage("pasted-2"));
    app.intake.importMessage(
      { id: "own-1", channel: "unknown", from: "Unknown sender", received_at: "2026-11-05T09:00:00-07:00", text: "I called them." },
      { suggested: [], note: "x", ownReport: true },
    );
    await step("IntakeService", "decideOwnReport", () => app.intake.decideOwnReport("own-1", "yes", 1));
    await step("IntakeService", "undoOwnReport", () => app.intake.undoOwnReport("own-1"));

    await step("CaseService", "loadCalendar", () => app.kase.loadCalendar("dana.ics", readFixtureText("calendar/dana.ics"), 0));
    const conflict = app.kase.view().conflicts[0]!;
    await step("CaseService", "explain", () => app.kase.explain(conflict.id, conflict.version));
    await step("CaseService", "askNext", () => app.kase.askNext(app.kase.view().questionsVersion));
    await step("CaseService", "withdrawQuestion", () => app.kase.withdrawQuestion(app.kase.view().question!.id));
    await step("CaseService", "askNext", () => app.kase.askNext(app.kase.view().questionsVersion));
    let view = app.kase.view();
    const monday = view.question!.choices.find((c) => c.label.includes("Monday"))!;
    await step("CaseService", "answer", () => app.kase.answer(view.question!.id, monday.id, view.questionsVersion, view.reply.version));
    const answered = app.kase.questions().find((q) => q.status === "answered")!;
    await step("CaseService", "undoAnswer", () => app.kase.undoAnswer(answered.id, answered.answer!.evidenceIds, []));
    await step("ReplyService", "undoStart", () => app.reply.undoStart(app.kase.view().reply.draft!.id));
    view = app.kase.view();
    await step("CaseService", "answer", () => app.kase.answer(view.question!.id, monday.id, view.questionsVersion, view.reply.version));
    view = app.kase.view();
    await step("ReplyService", "edit", () => app.reply.edit(view.reply.draft!.id, "Monday works for me.", view.reply.version));
    view = app.kase.view();
    const draftId = view.reply.draft!.id;
    await step("ReplyService", "discard", () => app.reply.discard(draftId, view.reply.version));
    await step("ReplyService", "undoDiscard", () => app.reply.undoDiscard(draftId));
    await step("ReplyService", "discard", () => app.reply.discard(draftId, app.kase.view().reply.version));
    await step("ReplyService", "suggest", () => app.reply.suggest("I want Monday.", app.kase.view().reply.version));
    await step("ReplyService", "start", () => app.reply.start("accept_offer", "2026-11-16T13:00", app.kase.view().reply.version));
    view = app.kase.view();
    await step("ReplyService", "approve", () => app.reply.approve(view.reply.draft!.id, view.reply.draft!.fields.map((f) => f.name), view.reply.version));

    await step("RecordsService", "addNote", () => app.records.addNote(THU, "Parking is on Elm Street.", 0, USER));
    await step("RecordsService", "setTags", () => app.records.setTags(THU, ["moved"], 1, agent));
    await step("RecordsService", "archive", () => app.records.archive(THU, 2));
    await step("RecordsService", "undo", () => app.records.undo(THU, 3, 3));
    await step("RecordsService", "archive", () => app.records.archive(THU, 4, agent));
    await step("RecordsService", "unarchive", () => app.records.unarchive(THU, 5, agent));
    await step("RecordsService", "logAccess", () => app.records.logAccess({ actor: "mcp", tool: "get_schedule", result: "ok", appointment_id: null }));
    await step("CaseService", "deleteCase", () => app.kase.deleteCase(app.kase.caseVersion(), "DELETE"));
    expect(caseEvents(store)).toEqual([]);

    // The case actions, as the API, the chat and the MCP server call them.
    const a = app.actions;
    const you = { actor: "you" as const };
    const bot = { actor: "agent" as const };
    const act = (name: string, run: () => unknown) => step("CaseActions", name, run);
    await act("setTimezone", () => a.setTimezone(bot, "America/Denver", store.streamVersion("settings")));
    for (const id of ["m2", "m3"]) {
      const m = a.importMessage(bot, fixtureMessage(id));
      called.get("CaseActions")!.add("importMessage");
      await act("extract", () => a.extract(bot, id, { effort: "minimal", expectedVersion: m.version }));
      for (const e of app.intake.reviewQueue()) await act("acceptClaim", () => a.acceptClaim(bot, e.id, e.version));
    }
    const pasted = a.importMessage(you, { id: "pasted-3", channel: "email", from: "Front Desk", received_at: "2026-11-05T09:00:00-07:00", text: "Please bring the form." });
    await act("enterManually", () =>
      a.enterManually(you, pasted.id, pasted.version, { claim_type: "office_request", date: null, time: null, location: null, quote: null, request_item: "the form" }),
    );
    const own = a.importMessage(you, { id: "own-2", channel: "unknown", from: "Unknown sender", received_at: "2026-11-05T09:00:00-07:00", text: "I called them." }, { suggested: [], note: "x", ownReport: true });
    await act("recordOwnReport", () => a.recordOwnReport(you, "own-2", "no", own.version));
    const typed = app.intake.reviewQueue()[0]!;
    await act("rejectClaim", () => a.rejectClaim(you, typed.id, typed.version));
    await act("loadCalendar", () => a.loadCalendar(you, "dana.ics", readFixtureText("calendar/dana.ics"), 0));
    const c2 = app.kase.view().conflicts[0]!;
    await act("explain", () => a.explain(bot, c2.id, c2.version));
    await act("askNext", () => a.askNext(bot, app.kase.view().questionsVersion));
    view = app.kase.view();
    const mon2 = view.question!.choices.find((c) => c.label.includes("Monday"))!;
    await act("answerQuestion", () => a.answerQuestion(bot, view.question!.id, mon2.id, view.questionsVersion, view.reply.version));
    view = app.kase.view();
    await act("editDraft", () => a.editDraft(you, view.reply.draft!.id, "Monday works for me.", view.reply.version));
    view = app.kase.view();
    await act("discardDraft", () => a.discardDraft(bot, view.reply.draft!.id, view.reply.version));
    await act("suggestReply", () => a.suggestReply(you, "I want Monday.", app.kase.view().reply.version));
    if (app.kase.view().reply.draft) await a.discardDraft(you, app.kase.view().reply.draft!.id, app.kase.view().reply.version);
    await act("startReply", () => a.startReply(bot, "accept_offer", "2026-11-16T13:00", app.kase.view().reply.version));
    view = app.kase.view();
    await act("approveDraft", () => a.approveDraft(you, view.reply.draft!.id, view.reply.draft!.fields.map((f) => f.name), view.reply.version));
    await act("addNote", () => a.addNote(bot, THU, "Parking is on Elm Street.", 0));
    await act("setTags", () => a.setTags(bot, THU, ["moved"], 1));
    await act("archive", () => a.archive(bot, THU, 2));
    await act("unarchive", () => a.unarchive(bot, THU, 3));
    await act("undoRecordEvent", () => a.undoRecordEvent(you, THU, 1, 4));
    const latest = a.activity();
    await act("undo", () => a.undo(you, latest.entries.find((e) => e.kind === "tags_set")!.id, latest.activityVersion));
    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");

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
