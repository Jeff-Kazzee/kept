// Request checks on the local HTTP API (0009, J3). There is no pairing
// code and no session: the server binds 127.0.0.1, answers only to its own
// host names, and takes a write only from the app's own page (same-origin
// and the app header). The pairing, grant and proposal routes are gone and
// answer 404. Run against the real server process on a temporary database.
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../server/api.ts";
import { requestSourceProblem } from "../server/guard.ts";
import { CaseService } from "../src/case/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { fromPackage } from "../src/paths.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, agentAccess, fixtureMessage, intake } from "./helpers.ts";

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Res = { status: number; body: any; setCookie: string[] };

function call(port: number, method: string, p: string, headers: Record<string, string>, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null, setCookie: res.headers["set-cookie"] ?? [] }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// A case with m2 accepted.
async function seededFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "http-guard-"));
  dirs.push(dir);
  const file = path.join(dir, "app.sqlite");
  const store = new EventStore(file);
  await acceptMessages(intake(store), ["m2"]);
  store.close();
  return { file };
}

// The real app process, started once it says where it listens.
async function startServer(file: string, port = 20000 + Math.floor(Math.random() * 20000)) {
  const env = { ...process.env, APP_PORT: String(port), APP_DB: file, APP_LIVE_MODEL: "", MODEL_API_KEY: "" };
  const child = spawn(process.execPath, [fromPackage("server/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const out = await new Promise<string>((resolve, reject) => {
    let text = "";
    child.stdout!.on("data", (d: Buffer) => {
      text += d.toString();
      if (/Serving the (production build|UI through Vite)/.test(text)) resolve(text);
    });
    child.on("exit", (c) => reject(new Error(`server exited ${c}`)));
    setTimeout(() => reject(new Error("server did not start")), 15_000);
  });
  const page = (extra: Record<string, string> = {}) => ({
    "Content-Type": "application/json",
    "X-Case-Generation": "0",
    Origin: `http://127.0.0.1:${port}`,
    "X-Appointments-App": "1",
    ...extra,
  });
  return { port, out, page };
}

// Every route the API has, with a sample path for each pattern.
function allRoutes() {
  const store = new EventStore();
  const client = RecordedModelClient.fromDirectory();
  const svc = intake(store);
  const kase = new CaseService(store, svc, client);
  const api = createApi(svc, kase, { mode: "recorded" }, new ReplyService(store, kase, client), agentAccess(store, svc, kase));
  store.close();
  return api.routes.map(({ method, pattern }) => ({ method, path: pattern.source.replace(/^\^/, "").replace(/\$$/, "").replaceAll("\\/", "/").replaceAll("([^/]+)", "x") }));
}

const REMOVED = [
  ["POST", "/api/pair"],
  ["GET", "/api/grants"],
  ["POST", "/api/grants"],
  ["POST", "/api/grants/g-1/revoke"],
  ["GET", "/api/proposals"],
  ["POST", "/api/proposals/p-1/confirm"],
  ["POST", "/api/proposals/p-1/reject"],
] as const;

describe("J3: no pairing, and the page check on every write", () => {
  it("answers reads with no session, sets no cookie, prints no code, and the removed routes answer 404", async () => {
    const seed = await seededFile();
    const app = await startServer(seed.file);
    expect(app.out).not.toMatch(/pairing/i);
    const state = await call(app.port, "GET", "/api/state", {});
    expect(state.status).toBe(200);
    expect(state.setCookie).toEqual([]);
    expect(state.body).toMatchObject({ generation: 0, messages: [{ id: "m2" }] });
    expect(state.body.grants).toBeUndefined();
    expect(state.body.proposals).toBeUndefined();
    for (const [method, p] of REMOVED) {
      const res = await call(app.port, method, p, app.page(), method === "POST" ? { code: "ABCD-EFGH", expectedVersion: 0 } : undefined);
      expect([method, p, res.status, res.body?.error]).toEqual([method, p, 404, "not_found"]);
      expect(res.setCookie).toEqual([]);
    }
    for (const r of allRoutes()) expect(r.path, r.path).not.toMatch(/pair|grant|proposal/);
  }, 30_000);

  it("refuses every write route from another page, a cross-site fetch, no Origin or no app header, and writes nothing", async () => {
    const seed = await seededFile();
    const app = await startServer(seed.file);
    const writes = allRoutes().filter((r) => r.method !== "GET");
    expect(writes.length).toBeGreaterThanOrEqual(20);
    expect(writes).toContainEqual({ method: "POST", path: "/api/case/delete" });
    expect(writes).toContainEqual({ method: "PUT", path: "/api/settings/timezone" });
    expect(writes).toContainEqual({ method: "POST", path: "/api/activity/x/undo" });
    const { Origin: _o, ...noOrigin } = app.page();
    const { "X-Appointments-App": _h, ...noApp } = app.page();
    const bad = [app.page({ Origin: "http://attacker.example" }), app.page({ Origin: "http://attacker.example", "Sec-Fetch-Site": "cross-site" }), noOrigin, noApp];
    for (const r of writes) {
      for (const headers of bad) {
        const res = await call(app.port, r.method, r.path, headers, {});
        expect([r.method, r.path, res.status, res.body?.error]).toEqual([r.method, r.path, 403, "forbidden_source"]);
      }
    }
    const before = (await call(app.port, "GET", "/api/state", {})).body;
    expect(before.messages).toHaveLength(1);
    expect(before.settings.timezoneSource).toBe("default");
    // From the app's page, a write goes through. Sec-Fetch-Site
    // same-origin is enough in place of the Origin.
    expect((await call(app.port, "POST", "/api/messages", { ...noOrigin, "Sec-Fetch-Site": "same-origin" }, { ...fixtureMessage("m4"), id: "m4" })).status).toBe(200);
    const tz = await call(app.port, "PUT", "/api/settings/timezone", app.page(), { timezone: "Europe/London", expectedVersion: 0 });
    expect(tz).toMatchObject({ status: 200, body: { timezone: "Europe/London", timezoneSource: "you", settingsVersion: 1 } });
    const after = (await call(app.port, "GET", "/api/state", {})).body;
    expect(after.messages).toHaveLength(2);
    expect(after.activity.entries.map((e: { kind: string; actor: string }) => [e.kind, e.actor])).toEqual([
      ["timezone_set", "you"],
      ["message_imported", "you"],
    ]);
  }, 60_000);

  it("the page check itself", () => {
    const origins = ["http://127.0.0.1:5180", "http://localhost:5180"];
    expect(requestSourceProblem({ method: "GET" }, origins)).toBeNull();
    expect(requestSourceProblem({ method: "POST", origin: "http://localhost:5180", appHeader: "1" }, origins)).toBeNull();
    expect(requestSourceProblem({ method: "POST", secFetchSite: "same-origin", appHeader: "1" }, origins)).toBeNull();
    expect(requestSourceProblem({ method: "PUT", secFetchSite: "same-origin", appHeader: "1" }, origins)).toBeNull();
    expect(requestSourceProblem({ method: "POST", secFetchSite: "same-site", appHeader: "1" }, origins)).not.toBeNull();
    expect(requestSourceProblem({ method: "POST", origin: "http://127.0.0.1:5181", appHeader: "1" }, origins)).not.toBeNull();
    expect(requestSourceProblem({ method: "POST", origin: "null", appHeader: "1" }, origins)).not.toBeNull();
    expect(requestSourceProblem({ method: "PUT", origin: "http://localhost:5180" }, origins)).not.toBeNull();
  });
});
