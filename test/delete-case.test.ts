// SP5.4 Delete case (O-a to O-d): the app erases every event of the case,
// its activity and access logs, and the removed text is gone from the
// database file and its -wal and -shm files. Settings stay (0009). The
// append-only guard stays in force for every other path. An MCP server
// that has the file open keeps working and finds no case.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../mcp/rate-limit.ts";
import { callTool } from "../mcp/server.ts";
import { CaseService, KEPT_ON_DELETE } from "../src/case/service.ts";
import { loadCaseProfile, readFixtureText } from "../src/fixtures/load.ts";
import { CaseActions } from "../src/actions/service.ts";
import { timezoneSettings } from "../src/settings/events.ts";
import { InvalidRequestError } from "../src/intake/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { USER } from "../src/records/events.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore, StaleEditError } from "../src/store/event-log.ts";
import { acceptMessages, intake, useZone } from "./helpers.ts";

const CLOCK = () => "2026-11-06T17:00:00.000Z";
const THU = "2026-11-12T10:30";
const MON = "2026-11-16T13:00";
// Written into every kind of case text, then searched for in the files.
const MARKER = "Qv7-erase-marker-4417";

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "delete-case-"));
  dirs.push(dir);
  return dir;
}

function services(store: EventStore) {
  const client = RecordedModelClient.fromDirectory();
  const svc = intake(store);
  const kase = new CaseService(store, svc, client, { userName: loadCaseProfile().user_name });
  const reply = new ReplyService(store, kase, client);
  const records = new RecordsService(store, svc, kase);
  return { store, intake: svc, kase, reply, records, actions: new CaseActions(store, { intake: svc, kase, reply, records }) };
}

const mcp = (app: App) => ({ store: app.store, services: app, limiter: new RateLimiter() });

type App = ReturnType<typeof services>;

// Every kind of case event: messages, evidence and reviews, a rejected
// claim, the calendar, an explanation, a question and its answer, a reply
// draft with an edit, notes, tags, an archive and its undo, an agent's
// action in the activity log, an agent call in the access log, and the
// time zone setting. The marker goes into a pasted message, the calendar
// name, notes and a reply edit.
async function seedEverything(app: App) {
  useZone(app.store);
  await acceptMessages(app.intake, ["m1", "m2", "m3"]);
  const pasted = app.intake.importMessage({
    id: "pasted-1",
    channel: "email",
    from: "Front Desk",
    received_at: "2026-11-05T09:00:00-07:00",
    text: `Please bring the form ${MARKER}.`,
  });
  app.intake.enterManually(pasted.id, pasted.version, {
    claim_type: "office_request",
    date: null,
    time: null,
    location: null,
    quote: `Please bring the form ${MARKER}.`,
    request_item: `form ${MARKER}`,
  });
  const manual = app.intake.reviewQueue()[0]!;
  app.intake.reject(manual.id, manual.version);
  app.kase.loadCalendar(`dana-${MARKER}.ics`, readFixtureText("calendar/dana.ics"), 0);
  const conflict = app.kase.view().conflicts[0]!;
  await app.kase.explain(conflict.id, conflict.version);
  const asked = await app.kase.askNext(app.kase.view().questionsVersion);
  const monday = asked.question!.choices.find((c) => c.label.includes("Monday"))!;
  const answered = app.kase.answer(asked.question!.id, monday.id, asked.questionsVersion, asked.reply.version);
  app.reply.edit(answered.reply.draft!.id, `I accept Monday. ${MARKER}`, answered.reply.version);
  app.records.addNote(THU, `Parking note ${MARKER}`, 0, USER);
  app.records.setTags(THU, ["moved"], 1, USER);
  app.records.archive(THU, 2);
  app.records.undo(THU, 3, 3);
  app.actions.addNote({ actor: "agent" }, MON, `Agent note ${MARKER}`, 0);
  const listed = await callTool(mcp(app), "get_schedule", {});
  expect(listed).toHaveProperty("structuredContent");
}

const filesWith = (dir: string, text: string) => readdirSync(dir).filter((f) => readFileSync(path.join(dir, f)).includes(Buffer.from(text, "utf8")));

describe("SP5.4 Delete case", () => {
  it("O-a: erases every event of the case, its activity and access logs, and keeps the settings", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    await seedEverything(app);
    // Streams from before sprint 8 are case data too.
    app.store.append("grant:g-1", 0, [{ type: "grant_created", data: { name: "Old", tier: "read", token_sha256: "00" } }]);
    const kinds = new Set(app.store.readAll().map((e) => e.streamId.replace(/:.*$/, "")));
    expect([...kinds].sort()).toEqual(["access_log", "activity", "calendar", "conflict", "evidence", "grant", "message", "questions", "record", "reply", "settings"]);

    const result = app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    expect(result.erased).toBeGreaterThan(20);
    expect(app.store.readAll().every((e) => e.streamId === "settings")).toBe(true);
    expect(timezoneSettings(app.store)).toMatchObject({ timezone: "America/Denver", timezoneSource: "agent" });
    expect(app.records.accessLog()).toEqual([]);
    expect(app.actions.activity()).toEqual({ activityVersion: 0, entries: [] });
    expect(app.intake.messages()).toEqual([]);
    expect(app.kase.caseVersion()).toBe(0);
    const view = app.kase.view();
    expect(view).toMatchObject({ slots: [], conflicts: [], question: null, calendar: null, reply: { draft: null, sent: [], version: 0 } });
    expect(KEPT_ON_DELETE).toEqual(["settings"]);
  });

  it("needs the typed confirmation and the case version, and a mismatch erases nothing", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    await acceptMessages(app.intake, ["m2"]);
    const version = app.kase.caseVersion();
    const count = app.store.readAll().length;
    expect(() => app.kase.deleteCase(version, "delete")).toThrow(InvalidRequestError);
    expect(() => app.kase.deleteCase(version, "")).toThrow("Type DELETE to confirm.");
    expect(() => app.kase.deleteCase(version - 1, "DELETE")).toThrow(StaleEditError);
    expect(app.store.readAll()).toHaveLength(count);
    // The guard came back when the stale delete rolled back.
    expect(() => app.store.unsafeExecForTest("DELETE FROM events")).toThrow(/append-only/);
  });

  it("an agent reading the case does not make the user's confirmation stale", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    await acceptMessages(app.intake, ["m2"]);
    const version = app.kase.caseVersion();
    await callTool(mcp(app), "get_schedule", {});
    expect(app.records.accessLog()).toHaveLength(1);
    expect(app.kase.caseVersion()).toBe(version);
    // A setting is not case data, so a time zone change does not move the
    // version either.
    useZone(app.store, "Asia/Tokyo");
    expect(app.kase.caseVersion()).toBe(version);
    expect(app.kase.deleteCase(version, "DELETE").erased).toBeGreaterThan(0);
  });

  it("O-b: no deleted text remains in the database file or its -wal and -shm files", async () => {
    const dir = tempDir();
    const file = path.join(dir, "app.sqlite");
    const app = services(new EventStore(file, CLOCK));
    await seedEverything(app);
    expect(filesWith(dir, MARKER).length).toBeGreaterThan(0);

    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    // While the store is still open, with its -wal and -shm files on disk.
    expect(readdirSync(dir).sort()).toEqual(["app.sqlite", "app.sqlite-shm", "app.sqlite-wal"]);
    expect(filesWith(dir, MARKER)).toEqual([]);
    for (const text of ["Lantern Hill", "insurance card", "Dana Reyes", "I accept Monday", "Added a note to"]) expect(filesWith(dir, text), text).toEqual([]);
    app.store.close();
    expect(filesWith(dir, MARKER)).toEqual([]);

    // The file is sound and the time zone is still set.
    const reopened = new EventStore(file);
    cleanups.push(() => reopened.close());
    expect(timezoneSettings(reopened).timezone).toBe("America/Denver");
    expect(services(reopened).kase.view().slots).toEqual([]);
  });

  it("O-c: only eraseCase can delete an event row, and only Delete case calls it", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    await acceptMessages(app.intake, ["m2"]);
    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    // The guard is back in force after a delete.
    await acceptMessages(app.intake, ["m2"]);
    expect(() => app.store.unsafeExecForTest("DELETE FROM events")).toThrow(/append-only/);
    expect(() => app.store.unsafeExecForTest("UPDATE events SET data = '{}'")).toThrow(/append-only/);
    // A failing check inside eraseCase rolls back the lifted guard too.
    expect(() => app.store.eraseCase(KEPT_ON_DELETE, () => {
      throw new Error("refused");
    })).toThrow("refused");
    expect(() => app.store.unsafeExecForTest("DELETE FROM events")).toThrow(/append-only/);
    expect(app.intake.messages().map((m) => m.id)).toEqual(["m2"]);

    // No source file outside the store deletes or updates events or drops
    // the guard, and only CaseService.deleteCase calls eraseCase. The MCP
    // server never does.
    const sources = ["src", "server", "mcp", "ui", "scripts"].flatMap((d) => listTs(path.join(PACKAGE_ROOT, d)));
    const hits = (re: RegExp) => sources.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => path.relative(PACKAGE_ROOT, f));
    expect(hits(/DELETE\s+FROM\s+events|UPDATE\s+events|DROP\s+TRIGGER/i)).toEqual(["src/store/event-log.ts"]);
    expect(hits(/\.eraseCase\(/)).toEqual(["src/case/service.ts"]);
    expect(hits(/deleteCase|eraseCase/).filter((f) => f.startsWith("mcp/"))).toEqual([]);
    const store = readFileSync(path.join(PACKAGE_ROOT, "src/store/event-log.ts"), "utf8");
    expect(store.match(/DELETE FROM events|DROP TRIGGER/g)).toEqual(["DROP TRIGGER", "DELETE FROM events"]);
  });

  it("O-d: an MCP server with the file open keeps working, finds no case, and the file stays sound", async () => {
    const dir = tempDir();
    const file = path.join(dir, "app.sqlite");
    const app = services(new EventStore(file));
    cleanups.push(() => app.store.close());
    await acceptMessages(app.intake, ["m1", "m2", "m3"]);
    app.records.addNote(THU, `Parking note ${MARKER}`, 0, USER);

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
    const list = async () => (await client.callTool({ name: "get_schedule", arguments: {} })).structuredContent as { appointments: unknown[] };
    expect((await list()).appointments).toHaveLength(4);

    // The user deletes the case in the app while the server process runs.
    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    expect(filesWith(dir, MARKER)).toEqual([]);

    expect((await list()).appointments).toEqual([]);
    const one = await client.callTool({ name: "get_appointment", arguments: { slot_key: MON } });
    expect(one.isError).toBe(true);
    expect(JSON.parse((one.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ error: "not_found" });
    // Only the calls after the delete are in the new access log.
    expect(app.records.accessLog().map((e) => [e.tool, e.result])).toEqual([
      ["get_schedule", "ok"],
      ["get_appointment", "not_found"],
    ]);
    await client.close();
    expect(stderr).toBe("");

    const check = spawnSync(process.execPath, ["-e", `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);console.log(db.prepare("PRAGMA integrity_check").get().integrity_check)`, file], {
      encoding: "utf8",
    });
    expect(check.stdout.trim()).toBe("ok");
  }, 20_000);
});

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return listTs(p);
    return /\.(ts|tsx|mjs)$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [p] : [];
  });
}
