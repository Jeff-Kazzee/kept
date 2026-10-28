// SP6.4 and G-g: the connect test setup, run here without ssh. The grant
// command writes a token file, scripts/mcp-stdio.sh starts the server over
// stdio with it, and the SDK client lists the tools and reads one
// appointment, as an MCP client on another machine does through ssh. Every
// token is made at test time in a temporary folder and never printed.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { TokenSourceError, takeGrantToken } from "../mcp/token.ts";
import { CaseService } from "../src/case/service.ts";
import { TOKEN_PATTERN, newGrantToken } from "../src/grants/grants.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { RecordsService } from "../src/records/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, intake } from "./helpers.ts";

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

// The app's database with m1 to m3 accepted.
async function seededDb(dir: string) {
  const file = path.join(dir, "app.sqlite");
  const store = new EventStore(file);
  await acceptMessages(intake(store), ["m1", "m2", "m3"]);
  store.close();
  return file;
}

// The real grant command, as `pnpm grant create ... --token-file` runs it.
function grantCreate(db: string, tokenFile: string, tier: string) {
  return spawnSync(process.execPath, [path.join(PACKAGE_ROOT, "src/grants/cli.ts"), "create", "--name", "Laptop assistant", "--tier", tier, "--token-file", tokenFile], {
    cwd: PACKAGE_ROOT,
    env: { PATH: process.env.PATH ?? "", APP_DB: db },
    encoding: "utf8",
  });
}

describe("G-g: token file for the stdio server", () => {
  it("reads the token once from a file only its owner can read, and removes both variables", () => {
    const dir = tempDir();
    const file = path.join(dir, "grant-token");
    const token = newGrantToken();
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { APPT_GRANT_TOKEN_FILE: file };
    expect(takeGrantToken(env)).toBe(token);
    expect(env).toEqual({});
    const direct: NodeJS.ProcessEnv = { APPT_GRANT_TOKEN: token };
    expect(takeGrantToken(direct)).toBe(token);
    expect(direct).toEqual({});
  });

  it("refuses a file other users can read, an empty file, a folder, and both variables at once, without naming the token", () => {
    const dir = tempDir();
    const file = path.join(dir, "grant-token");
    const token = newGrantToken();
    writeFileSync(file, token, { mode: 0o600 });
    for (const mode of [0o640, 0o604, 0o644]) {
      chmodSync(file, mode);
      expect(() => takeGrantToken({ APPT_GRANT_TOKEN_FILE: file })).toThrow(/can be read by other users\. Run chmod 600/);
    }
    chmodSync(file, 0o600);
    expect(() => takeGrantToken({ APPT_GRANT_TOKEN_FILE: file, APPT_GRANT_TOKEN: token })).toThrow("not both");
    const empty = path.join(dir, "empty");
    writeFileSync(empty, "\n", { mode: 0o600 });
    expect(() => takeGrantToken({ APPT_GRANT_TOKEN_FILE: empty })).toThrow("is empty");
    expect(() => takeGrantToken({ APPT_GRANT_TOKEN_FILE: dir })).toThrow("not a regular file");
    expect(() => takeGrantToken({ APPT_GRANT_TOKEN_FILE: path.join(dir, "missing") })).toThrow("ENOENT");
    expect(() => takeGrantToken({})).toThrow(TokenSourceError);
    for (const env of [{ APPT_GRANT_TOKEN_FILE: file, APPT_GRANT_TOKEN: token }, {}]) {
      try {
        takeGrantToken(env);
      } catch (err) {
        expect((err as Error).message).not.toContain(token);
      }
    }
  });
});

describe("SP6.4 stand-in: the connect test without ssh", () => {
  it("creates the grant with --token-file, starts scripts/mcp-stdio.sh with the default token path, lists tools and reads one appointment", async () => {
    const dir = tempDir();
    const db = await seededDb(dir);
    // The launcher's default token path is under HOME.
    const home = path.join(dir, "home");
    mkdirSync(home);
    const tokenFile = path.join(home, ".config/appointments/grant-token");
    const created = grantCreate(db, tokenFile, "annotate");
    expect(created.status, created.stderr).toBe(0);
    const token = readFileSync(tokenFile, "utf8").trim();
    expect(token).toMatch(TOKEN_PATTERN);
    expect(created.stdout).toContain(`Token written to ${tokenFile}`);
    expect(created.stdout + created.stderr).not.toContain(token);

    // As an MCP client launches it: one command, no token on it, and
    // APPT_GRANT_TOKEN_FILE left to the launcher's default.
    const env = { ...getDefaultEnvironment(), HOME: home, APP_DB: db };
    const transport = new StdioClientTransport({ command: LAUNCHER, args: [], cwd: dir, env, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    // The client's default handshake, as OpenCode and Claude Code use.
    const client = new Client({ name: "connect-test", version: "1.0.0" });
    await client.connect(transport);
    cleanups.push(() => client.close());

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(["list_appointments", "get_appointment", "list_open_questions", "add_note", "set_tags"]);
    const got = await client.callTool({ name: "get_appointment", arguments: { appointment_id: MON } });
    expect(got.isError ?? false).toBe(false);
    expect(got.structuredContent).toMatchObject({
      appointment: { appointment_id: MON, state: "offered", state_meaning: "The office offered this time. You have not accepted it." },
    });
    await client.close();
    expect(stderr).not.toContain(token);

    // The call is in the case history with the grant's name.
    const store = new EventStore(db);
    cleanups.push(() => store.close());
    const svc = intake(store);
    const records = new RecordsService(store, svc, new CaseService(store, svc, RecordedModelClient.fromDirectory()));
    expect(records.accessLog().map((e) => [e.grant_name, e.tool, e.result, e.appointment_id])).toEqual([["Laptop assistant", "get_appointment", "ok", MON]]);
  }, 30_000);

  it("the launcher refuses a token file other users can read, and prints nothing on stdout", async () => {
    const dir = tempDir();
    const db = await seededDb(dir);
    const tokenFile = path.join(dir, "grant-token");
    expect(grantCreate(db, tokenFile, "read").status).toBe(0);
    chmodSync(tokenFile, 0o644);
    const run = spawnSync(LAUNCHER, [], { env: { PATH: process.env.PATH ?? "", HOME: dir, APP_DB: db, APPT_GRANT_TOKEN_FILE: tokenFile }, input: "", encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`The token file ${tokenFile} can be read by other users.`);
    expect(run.stderr).not.toContain(readFileSync(tokenFile, "utf8").trim());
  });
});
