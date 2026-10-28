// Sprint 6 review rounds 1 and 2: access control on the local HTTP API.
// The browser pairs once with the code the server prints at start and gets
// an HttpOnly session cookie. Every other /api route, reads included,
// needs that session. Wrong codes back off for a while, and a request that
// changes state must also come from the app's own page. Run against the
// real server process on a temporary database. These checks raise the bar
// only: a process running as the same OS user can still open the database
// file (see 0006).
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../server/api.ts";
import { FIRST_WAIT_MS, FORGET_AFTER_MS, FREE_TRIES, MAX_WAIT_MS, Pairing, Sessions, cookieValue, createGate, requestSourceProblem, sessionCookieName } from "../server/guard.ts";
import { CaseService } from "../src/case/service.ts";
import { GrantStore } from "../src/grants/grants.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { fromPackage } from "../src/paths.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, fixtureMessage, intake } from "./helpers.ts";

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

// A case with m2 accepted, a grant and one pending proposal from an agent.
async function seededFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "http-guard-"));
  dirs.push(dir);
  const file = path.join(dir, "app.sqlite");
  const store = new EventStore(file);
  const svc = intake(store);
  const records = new RecordsService(store, svc, new CaseService(store, svc, RecordedModelClient.fromDirectory()));
  await acceptMessages(svc, ["m2"]);
  const { grant } = new GrantStore(store).create("Phone helper", "propose");
  const proposal = records.propose({ kind: "user_report", claim_type: "cancel", date: "2026-11-12", time: "10:30", statement: "Dana canceled Thursday." }, grant);
  store.close();
  return { file, proposalId: proposal.id };
}

// The real app process. Returns the pairing code it printed.
async function startServer(file: string, port = 20000 + Math.floor(Math.random() * 20000)) {
  const env = { ...process.env, APP_PORT: String(port), APP_DB: file, APP_LIVE_MODEL: "", MODEL_API_KEY: "" };
  const child = spawn(process.execPath, [fromPackage("server/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const code = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /Pairing code for this run: ([A-Z0-9]{4}-[A-Z0-9]{4})\./.exec(out);
      if (m) resolve(m[1]!);
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
  const pair = async (given = code) => {
    const res = await call(port, "POST", "/api/pair", page(), { code: given });
    const cookie = res.setCookie[0]?.split(";")[0];
    return { res, cookie };
  };
  const stop = () =>
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
    });
  return { port, code, page, pair, stop };
}

// Every route the API has, with a sample path for each pattern.
function allRoutes() {
  const store = new EventStore();
  const client = RecordedModelClient.fromDirectory();
  const svc = intake(store);
  const kase = new CaseService(store, svc, client);
  const api = createApi(svc, kase, { mode: "recorded" }, new ReplyService(store, kase, client), { records: new RecordsService(store, svc, kase), grants: new GrantStore(store) });
  store.close();
  return api.routes.map(({ method, pattern }) => ({ method, path: pattern.source.replace(/^\^/, "").replace(/\$$/, "").replaceAll("\\/", "/").replaceAll("([^/]+)", "x") }));
}

describe("B1: every /api route needs the paired session", () => {
  it("refuses every route without a session or with a forged one, and writes nothing", async () => {
    const seed = await seededFile();
    const app = await startServer(seed.file);
    const routes = allRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(25);
    expect(routes).toContainEqual({ method: "POST", path: "/api/case/delete" });
    expect(routes).toContainEqual({ method: "GET", path: "/api/state" });
    const forged = `${sessionCookieName(app.port)}=${randomBytes(32).toString("base64url")}`;
    for (const r of routes) {
      for (const cookie of [undefined, forged, `${sessionCookieName(app.port + 1)}=x`]) {
        const res = await call(app.port, r.method, r.path, cookie ? app.page({ Cookie: cookie }) : app.page(), r.method === "POST" ? {} : undefined);
        expect([r.method, r.path, cookie ? "cookie" : "none", res.status, res.body?.error]).toEqual([r.method, r.path, cookie ? "cookie" : "none", 401, "not_paired"]);
      }
    }
    // The failing cases from the review, each refused: Delete case, and a
    // fabricated office message imported, extracted and accepted.
    expect((await call(app.port, "POST", "/api/case/delete", app.page(), { expectedVersion: 0, confirmation: "DELETE" })).status).toBe(401);
    expect((await call(app.port, "POST", "/api/messages", app.page(), { ...fixtureMessage("m4"), id: "fake" })).status).toBe(401);
    expect((await call(app.port, "POST", "/api/messages/m2/extract", app.page(), { expectedVersion: 1 })).status).toBe(401);
    expect((await call(app.port, "POST", "/api/evidence/m2-e1/accept", app.page(), { expectedVersion: 1 })).status).toBe(401);

    // Paired, the case is as it was seeded.
    const { cookie } = await app.pair();
    const state = (await call(app.port, "GET", "/api/state", { Cookie: cookie! })).body;
    expect(state).toMatchObject({ generation: 0, messages: [{ id: "m2" }], grants: [{ name: "Phone helper" }], proposals: [{ id: seed.proposalId, status: "pending" }] });
  }, 60_000);

  it("a valid pairing sets an HttpOnly SameSite=Strict cookie that unlocks every route, writes included, with no other code", async () => {
    const seed = await seededFile();
    const app = await startServer(seed.file);
    const { res, cookie } = await app.pair(app.code.toLowerCase().replace("-", ""));
    expect(res).toMatchObject({ status: 200, body: { paired: true } });
    expect(res.setCookie).toHaveLength(1);
    expect(res.setCookie[0]).toMatch(new RegExp(`^appointments_session_${app.port}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/$`));
    const withSession = (extra: Record<string, string> = {}) => app.page({ Cookie: cookie!, ...extra });
    expect((await call(app.port, "GET", "/api/state", { Cookie: cookie! })).status).toBe(200);
    expect((await call(app.port, "GET", "/api/case/version", { Cookie: cookie! })).status).toBe(200);
    expect((await call(app.port, "POST", "/api/grants", withSession(), { name: "Agent made", tier: "read" })).status).toBe(200);
    expect((await call(app.port, "POST", `/api/proposals/${seed.proposalId}/confirm`, withSession(), { expectedVersion: 1 })).status).toBe(200);
    const state = (await call(app.port, "GET", "/api/state", { Cookie: cookie! })).body;
    expect(state.grants).toHaveLength(2);
    expect(state.proposals[0]).toMatchObject({ status: "confirmed" });
    // Neither the code nor the session id comes back in any response body.
    expect(JSON.stringify(state)).not.toContain(app.code);
    expect(JSON.stringify(state)).not.toContain(cookie!.split("=")[1]!);
    // The page check still applies with a session, as CSRF defense: a
    // foreign Origin, a cross-site fetch, no Origin, or no app header.
    const M = { channel: "sms", from: "Clinic", received_at: "2026-11-05T09:00:00-07:00", text: "See you Monday." };
    const { Origin: _o, ...noOrigin } = withSession();
    const { "X-Appointments-App": _h, ...noApp } = withSession();
    for (const headers of [withSession({ Origin: "http://attacker.example" }), withSession({ Origin: "http://attacker.example", "Sec-Fetch-Site": "cross-site" }), noOrigin, noApp]) {
      expect(await call(app.port, "POST", "/api/messages", headers, M)).toMatchObject({ status: 403, body: { error: "forbidden_source" } });
    }
    expect((await call(app.port, "GET", "/api/state", { Cookie: cookie! })).body.messages).toHaveLength(1);
    // Sec-Fetch-Site same-origin is enough in place of the Origin.
    expect((await call(app.port, "POST", "/api/messages", { ...noOrigin, "Sec-Fetch-Site": "same-origin" }, M)).status).toBe(200);
  }, 30_000);

  it("a restart forgets every session and makes a new code", async () => {
    const seed = await seededFile();
    const first = await startServer(seed.file);
    const { cookie } = await first.pair();
    expect((await call(first.port, "GET", "/api/state", { Cookie: cookie! })).status).toBe(200);
    await first.stop();
    const second = await startServer(seed.file, first.port);
    expect(await call(second.port, "GET", "/api/state", { Cookie: cookie! })).toMatchObject({ status: 401, body: { error: "not_paired" } });
    const again = await second.pair();
    expect((await call(second.port, "GET", "/api/state", { Cookie: again.cookie! })).status).toBe(200);
  }, 40_000);

  it("the pairing route: a wrong or missing code sets no cookie, only POST from the app's page works", async () => {
    const seed = await seededFile();
    const app = await startServer(seed.file);
    const wrong = await app.pair("2222-2222");
    expect(wrong.res).toMatchObject({ status: 401, body: { error: "pairing_failed" } });
    expect(wrong.res.setCookie).toEqual([]);
    expect((await call(app.port, "POST", "/api/pair", app.page(), {})).body).toMatchObject({ error: "pairing_required" });
    expect((await call(app.port, "GET", "/api/pair", {})).status).toBe(405);
    const { "X-Appointments-App": _a, ...noAppHeader } = app.page();
    expect((await call(app.port, "POST", "/api/pair", noAppHeader, { code: app.code })).status).toBe(403);
  }, 30_000);
});

describe("B1 and B2: the gate without sockets", () => {
  it("B2: five wrong codes are free, then the wait doubles from 1 minute to at most 10, and a right code resets it", () => {
    let now = 1_000_000;
    const pairing = new Pairing({ code: "ABCD-EFGH", now: () => now });
    for (let i = 1; i < FREE_TRIES; i++) expect(pairing.check("WRONG-CODE")).toEqual({ ok: false, error: "pairing_failed", retryAfterSeconds: null });
    expect(pairing.check("WRONG-CODE")).toEqual({ ok: false, error: "pairing_failed", retryAfterSeconds: 60 });
    // During the wait even the right code is not checked.
    expect(pairing.check("ABCD-EFGH")).toEqual({ ok: false, error: "pairing_wait", retryAfterSeconds: 60 });
    now += 30_000;
    expect(pairing.check("ABCD-EFGH")).toEqual({ ok: false, error: "pairing_wait", retryAfterSeconds: 30 });
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      now += MAX_WAIT_MS;
      const r = pairing.check("WRONG-CODE");
      waits.push(r.ok ? 0 : r.retryAfterSeconds!);
    }
    expect(waits).toEqual([120, 240, 480, 600, 600, 600]);
    now += MAX_WAIT_MS;
    expect(pairing.check("abcd efgh")).toEqual({ ok: true });
    // Reset: five free tries again.
    for (let i = 1; i < FREE_TRIES; i++) expect(pairing.check("WRONG-CODE")).toMatchObject({ retryAfterSeconds: null });
    expect(pairing.check("WRONG-CODE")).toMatchObject({ retryAfterSeconds: FIRST_WAIT_MS / 1000 });
  });

  it("B2: wrong codes older than 10 minutes no longer count", () => {
    let now = 0;
    const pairing = new Pairing({ code: "ABCD-EFGH", now: () => now });
    for (let i = 1; i < FREE_TRIES; i++) pairing.check("WRONG-CODE");
    now += FORGET_AFTER_MS + 1;
    expect(pairing.check("WRONG-CODE")).toMatchObject({ retryAfterSeconds: null });
  });

  it("B2: the response says how long to wait", () => {
    let now = 0;
    const gate = createGate({ pairing: new Pairing({ code: "ABCD-EFGH", now: () => now }), sessions: new Sessions(), port: 5186 });
    for (let i = 1; i < FREE_TRIES; i++) expect(gate.pair({ code: "x" })).toMatchObject({ status: 401, body: { message: "That pairing code is not right." } });
    expect(gate.pair({ code: "x" })).toMatchObject({ status: 401, body: { message: "That pairing code is not right. Wait 1 minute before the next try." } });
    now += 15_000;
    expect(gate.pair({ code: "ABCD-EFGH" })).toEqual({
      status: 429,
      body: { error: "pairing_wait", retryAfterSeconds: 45, message: "Too many wrong codes. Wait 45 seconds, then try again." },
    });
    now += 45_000;
    const ok = gate.pair({ code: "ABCD-EFGH" });
    expect(ok.status).toBe(200);
    const id = ok.setCookie!.split(";")[0]!.split("=")[1]!;
    expect(gate.sessionProblem(`other=1; appointments_session_5186=${id}`)).toBeNull();
    expect(gate.sessionProblem(`appointments_session_5180=${id}`)).toMatchObject({ status: 401 });
    expect(gate.sessionProblem(undefined)).toMatchObject({ status: 401, body: { error: "not_paired" } });
  });

  it("parses cookies and keeps only hashes of sessions", () => {
    expect(cookieValue("a=1; appointments_session_5186=abc; b=2", "appointments_session_5186")).toBe("abc");
    expect(cookieValue("xappointments_session_5186=abc", "appointments_session_5186")).toBeUndefined();
    const sessions = new Sessions();
    const id = sessions.create();
    expect(sessions.has(id)).toBe(true);
    expect(sessions.has(`${id}x`)).toBe(false);
    expect(sessions.has("")).toBe(false);
    expect(new Pairing().code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  });

  it("the page check itself", () => {
    const origins = ["http://127.0.0.1:5180", "http://localhost:5180"];
    expect(requestSourceProblem({ method: "GET" }, origins)).toBeNull();
    expect(requestSourceProblem({ method: "POST", origin: "http://localhost:5180", appHeader: "1" }, origins)).toBeNull();
    expect(requestSourceProblem({ method: "POST", secFetchSite: "same-origin", appHeader: "1" }, origins)).toBeNull();
    expect(requestSourceProblem({ method: "POST", secFetchSite: "same-site", appHeader: "1" }, origins)).not.toBeNull();
    expect(requestSourceProblem({ method: "POST", origin: "http://127.0.0.1:5181", appHeader: "1" }, origins)).not.toBeNull();
    expect(requestSourceProblem({ method: "POST", origin: "null", appHeader: "1" }, origins)).not.toBeNull();
    expect(requestSourceProblem({ method: "PUT", origin: "http://localhost:5180" }, origins)).not.toBeNull();
  });
});
