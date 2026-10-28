// The connect test (0009, design 9), run here without ssh:
// scripts/mcp-stdio.sh starts the server over stdio with APP_DB and no
// token, and the SDK client lists the tools, reads one appointment and acts
// on it, as an MCP client does through ssh. The action is in the activity
// log as "mcp", with Undo, and the call is in the access log.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { CaseActions } from "../src/actions/service.ts";
import { AGENT_TOOL_NAMES } from "../src/agent/tools.ts";
import { CaseService } from "../src/case/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, intake, useZone } from "./helpers.ts";

const LAUNCHER = path.join(PACKAGE_ROOT, "scripts/mcp-stdio.sh");
const MON = "2026-11-16T13:00";

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "connect-"));
  dirs.push(dir);
  return dir;
}

// The app's database with m1 to m3 accepted, in the demo's zone.
async function seededDb(dir: string) {
  const file = path.join(dir, "app.sqlite");
  const store = new EventStore(file);
  useZone(store);
  await acceptMessages(intake(store), ["m1", "m2", "m3"]);
  store.close();
  return file;
}

function open(db: string) {
  const store = new EventStore(db);
  cleanups.push(() => store.close());
  const client = RecordedModelClient.fromDirectory();
  const svc = intake(store);
  const kase = new CaseService(store, svc, client);
  const records = new RecordsService(store, svc, kase);
  return { store, records, actions: new CaseActions(store, { intake: svc, kase, reply: new ReplyService(store, kase, client), records }) };
}

describe("the connect test without ssh", () => {
  it("starts scripts/mcp-stdio.sh with APP_DB and no token, lists the full toolset, reads and acts, and the action can be undone", async () => {
    const dir = tempDir();
    const db = await seededDb(dir);
    // As an MCP client launches it: one command, APP_DB, nothing else.
    const env = { ...getDefaultEnvironment(), APP_DB: db };
    const transport = new StdioClientTransport({ command: LAUNCHER, args: [], cwd: dir, env, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    // The client's default handshake, as OpenCode and Claude Code use.
    const client = new Client({ name: "connect-test", version: "1.0.0" });
    await client.connect(transport);
    cleanups.push(() => client.close());

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(AGENT_TOOL_NAMES);
    const got = await client.callTool({ name: "get_appointment", arguments: { slot_key: MON } });
    expect(got.isError ?? false).toBe(false);
    expect(got.structuredContent).toMatchObject({
      appointment: { slot_key: MON, state: "offered", state_meaning: "The office offered this time. You have not accepted it.", record_version: 0 },
    });
    const noted = await client.callTool({ name: "add_note", arguments: { slot_key: MON, text: "Ask about parking.", expected_version: 0 } });
    expect(noted.isError ?? false).toBe(false);
    expect(noted.structuredContent).toMatchObject({ record_version: 1, activity: { activity_id: "a1", undoable: true } });
    await client.close();
    expect(stderr).toBe("");

    // The note is in the app, by an external agent, with Undo, and both
    // calls are in the access log as "mcp".
    const app = open(db);
    expect(app.records.record(MON).notes.map((n) => [n.text, n.by])).toEqual([["Ask about parking.", { kind: "agent", name: "an external agent" }]]);
    const activity = app.actions.activity();
    expect(activity.entries).toMatchObject([{ id: "a1", actor: "mcp", kind: "note_added", summary: "Added a note to Monday 11/16 1:00 PM.", undoable: true }]);
    expect(app.records.accessLog().map((e) => [e.actor, e.tool, e.result, e.appointment_id])).toEqual([
      ["mcp", "get_appointment", "ok", MON],
      ["mcp", "add_note", "ok", MON],
    ]);
    app.actions.undo({ actor: "you" }, "a1", activity.activityVersion);
    expect(app.records.record(MON).notes).toEqual([]);
  }, 30_000);

  it("the launcher prints nothing on stdout and exits when its input closes", () => {
    const dir = tempDir();
    const run = spawnSync(LAUNCHER, [], { env: { PATH: process.env.PATH ?? "", HOME: dir, APP_DB: path.join(dir, "app.sqlite") }, input: "", encoding: "utf8", timeout: 15_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });
});
