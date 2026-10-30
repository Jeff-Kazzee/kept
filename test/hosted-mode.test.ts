// The two modes in the real server process (0014, design item 1): local
// mode by default, as before, and hosted mode with APP_MODE=hosted. A bad
// mode setting stops the app at start, and the MCP server stays local.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fromPackage } from "../src/paths.ts";

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function get(port: number, p: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: p, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.end();
  });
}

const AUTH = { BETTER_AUTH_SECRET: "mode-test-secret-made-up-for-tests-0123456789" };

function start(env: Record<string, string>, script = "server/main.ts") {
  const dir = mkdtempSync(path.join(tmpdir(), "mode-"));
  dirs.push(dir);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [fromPackage(script)], {
    env: { ...process.env, APP_PORT: String(port), APP_DB: path.join(dir, "app.sqlite"), MODEL_API_KEY: "", APP_MODE: "", BETTER_AUTH_URL: `http://localhost:${port}`, BETTER_AUTH_API_KEY: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  const ready = new Promise<{ code: number | null }>((resolve, reject) => {
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      if (/Serving the (production build|UI through Vite)/.test(out)) resolve({ code: null });
    });
    child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    child.on("exit", (code) => resolve({ code }));
    setTimeout(() => reject(new Error(`did not start: ${out}`)), 20_000);
  });
  return { dir, port, ready, out: () => out };
}

describe("app modes", () => {
  it("local mode by default answers /api/session as local and has no accounts", async () => {
    const s = start({});
    expect((await s.ready).code).toBeNull();
    expect(await get(s.port, "/api/session")).toEqual({ status: 200, body: { mode: "local" } });
    expect((await get(s.port, "/api/state")).status).toBe(200);
    expect(existsSync(path.join(s.dir, "hosted"))).toBe(false);
  }, 30_000);

  it("hosted mode signs nobody in by default, refuses the case routes, and makes its database with mode 600", async () => {
    const s = start({ APP_MODE: "hosted", MODEL_API_KEY: "server-key-for-mode-test", ...AUTH });
    expect((await s.ready).code).toBeNull();
    expect(s.out()).toContain("hosted mode");
    expect(s.out()).toContain("Accounts sign in with an email and password, a passkey or a judge code");
    // B7: off without its key, and the start log says so.
    expect(s.out()).toContain("The Better Auth dashboard plugin is off.");
    expect(s.out()).not.toContain(AUTH.BETTER_AUTH_SECRET);
    // J19: neither cap has a default, so the start log names both and the
    // server key is off.
    expect(s.out()).toContain("APP_DAILY_COST_CAP_USD is not set, so the server key is off.");
    expect(s.out()).toContain("APP_JUDGE_TOTAL_CAP_USD is not set, so the server key is off.");
    expect(s.out()).not.toContain("server-key-for-mode-test");
    expect(await get(s.port, "/api/session")).toEqual({ status: 200, body: { mode: "hosted", signedIn: false, passwordMin: 10, dashboard: false } });
    expect((await get(s.port, "/api/state")).status).toBe(401);
    const db = path.join(s.dir, "hosted", "accounts.sqlite");
    expect(statSync(db).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(s.dir, "hosted", "auth.sqlite")).mode & 0o777).toBe(0o600);
  }, 30_000);

  it("0020, B8: hosted mode does not start without BETTER_AUTH_SECRET of 32 bytes, or a public origin, and never prints them", async () => {
    for (const env of [{}, { BETTER_AUTH_SECRET: "too-short-secret" }, { ...AUTH, BETTER_AUTH_URL: "" }, { ...AUTH, BETTER_AUTH_URL: "http://example.com" }] as Array<Record<string, string>>) {
      const s = start({ APP_MODE: "hosted", ...env });
      expect((await s.ready).code).toBe(2);
      expect(s.out()).toMatch(/BETTER_AUTH_(SECRET|URL)/);
      expect(s.out()).not.toContain("too-short-secret");
      expect(s.out()).not.toContain(AUTH.BETTER_AUTH_SECRET);
      expect(existsSync(path.join(s.dir, "hosted", "auth.sqlite"))).toBe(false);
    }
  }, 60_000);

  it("review round 1, finding 7: local mode ignores hosted-only settings, as before sprint 13", async () => {
    const s = start({ APP_MARKUP: "0.5", APP_SERVER_KEY: "maybe", APP_DAILY_COST_CAP_USD: "lots", APP_TRUSTED_PROXY: "x" });
    expect((await s.ready).code).toBeNull();
    expect(await get(s.port, "/api/session")).toEqual({ status: 200, body: { mode: "local" } });
  }, 30_000);

  it("a bad mode setting stops the app at start", async () => {
    for (const env of [{ APP_MODE: "cloud" }, { APP_MODE: "hosted", APP_MARKUP: "0.5", ...AUTH }] as Array<Record<string, string>>) {
      const s = start(env);
      expect((await s.ready).code).toBe(2);
    }
  }, 30_000);

  it("the MCP server refuses to start in hosted mode", async () => {
    const s = start({ APP_MODE: "hosted" }, "mcp/main.ts");
    expect((await s.ready).code).toBe(2);
    expect(s.out()).toContain("local mode only");
  }, 30_000);
});

describe("0020, B10: the hosted instance's start script", () => {
  const script = fromPackage("scripts/hosted/start.sh");
  const run = (env: Record<string, string>) => spawnSync("bash", [script], { env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...env }, encoding: "utf8" });

  it("will not start without the secret, the public origin, both caps and the server key, and prints no value", () => {
    const r = run({ BETTER_AUTH_URL: "https://name.example:10000", APP_DAILY_COST_CAP_USD: "5" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("BETTER_AUTH_SECRET APP_JUDGE_TOTAL_CAP_USD MODEL_API_KEY not set");
    const short = run({ ...AUTH, BETTER_AUTH_SECRET: "short-value-not-printed", BETTER_AUTH_URL: "https://name.example:10000", APP_DAILY_COST_CAP_USD: "5", APP_JUDGE_TOTAL_CAP_USD: "5", MODEL_API_KEY: "key-value-not-printed" });
    expect(short.status).toBe(2);
    expect(short.stderr).toContain("shorter than 32 bytes");
    expect(`${short.stdout}${short.stderr}`).not.toMatch(/not-printed/);
  });
});
