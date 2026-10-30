// Sprint 18 (0020): hosted accounts through Better Auth. Email and
// password sign-up and sign-in, sign-out, a wrong password, both kinds of
// rate limit, passkeys with a software authenticator, judge codes on an
// email account, Delete account, the origin check, the cookie behind
// Tailscale Funnel, the dashboard plugin off and on with a fake key, and
// that no secret reaches a log or an answer. Offline.
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readAuthConfig, authLogLine } from "../src/hosted/auth.ts";
import { ConfigError } from "../src/hosted/config.ts";
import { clientAddress } from "../src/hosted/rate-limit.ts";
import { AccountsStore } from "../src/hosted/store.ts";
import { runAdminAsync } from "../scripts/admin.ts";
import { RATE_LIMITED_TEXT, isBetterAuthPath } from "../server/hosted.ts";
import { loggedPath } from "../server/request-log.ts";
import { TEST_AUTH_SECRET, TEST_PASSWORD, startHosted, type Browser, type Hosted, type Res } from "./hosted-helpers.ts";
import { SoftPasskey } from "./webauthn-soft.ts";

let h: Hosted | null = null;
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await h?.close();
  h = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cookiesOf = (r: Res) => {
  const set = r.headers["set-cookie"];
  return Array.isArray(set) ? set : set ? [set] : [];
};
const sessionCookie = (r: Res) => cookiesOf(r).find((c) => c.includes(".session_token="));
const PUBLIC = "https://the-little-ai-co.tail374dd0.ts.net:10000";
const PUBLIC_HOST = "the-little-ai-co.tail374dd0.ts.net:10000";

describe("0020, B2 and B6: email and password", () => {
  it("sign up, sign out, sign in, and a wrong password, with the session in an HttpOnly cookie only", async () => {
    h = await startHosted();
    const b = h.browser();
    const up = await h.signUp(b, { email: "pat@example.com", name: "Pat Example" });
    expect(up.status).toBe(200);
    // B6: the token is in the cookie, never in the JSON the page reads.
    expect(up.body.token).toBeUndefined();
    expect(up.text).not.toContain(b.cookies.get(`appt-${h.port}.session_token`)!.split(".")[0]!);
    expect(sessionCookie(up)).toMatch(new RegExp(`^appt-${h.port}\\.session_token=[^;]+; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax$`));
    const s = (await b.call("GET", "/api/session")).body;
    expect(s).toMatchObject({ mode: "hosted", signedIn: true, account: { kind: "user", email: "pat@example.com", name: "Pat Example" }, balance: "$0.00" });
    const gs = await b.auth("GET", "/api/auth/get-session");
    expect(gs.body.session.token).toBeUndefined();
    expect(gs.body.user.email).toBe("pat@example.com");

    expect((await b.call("POST", "/api/session/signout", {})).body).toMatchObject({ signedIn: false });
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect((await b.call("GET", "/api/state")).status).toBe(401);

    const wrong = await h.signIn(b, "pat@example.com", "not the password");
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(sessionCookie(wrong)).toBeUndefined();

    const back = await h.signIn(b, "pat@example.com");
    expect(back.status).toBe(200);
    expect(back.body.token).toBeUndefined();
    expect((await b.call("GET", "/api/session")).body.account.email).toBe("pat@example.com");
  });

  it("a password under 10 characters, a second sign-up with the same email and a bad email are refused", async () => {
    h = await startHosted();
    expect((await h.signUp(h.browser(), { email: "short@example.com", password: "123456789" })).body.code).toBe("PASSWORD_TOO_SHORT");
    expect((await h.signUp(h.browser(), { email: "same@example.com" })).status).toBe(200);
    const again = await h.signUp(h.browser(), { email: "same@example.com", password: "another password" });
    expect(again.status).toBe(422);
    expect((await h.signUp(h.browser(), { email: "not an email" })).status).toBe(400);
  });

  it("routes the site does not offer answer 404, and the app's own provider routes stay the app's", async () => {
    h = await startHosted();
    const b = h.browser();
    await h.signUp(b);
    for (const p of ["/api/auth/update-user", "/api/auth/request-password-reset", "/api/auth/change-password", "/api/auth/list-sessions", "/api/auth/sign-in/social"]) {
      expect((await b.auth("POST", p, {})).status, p).toBe(404);
    }
    expect(isBetterAuthPath("/api/auth/sign-in/email")).toBe(true);
    expect(isBetterAuthPath("/api/auth/meta-key")).toBe(false);
    expect(isBetterAuthPath("/api/auth/chatgpt/start")).toBe(false);
  });

  it("a request to Better Auth without a stated size, or too large, is refused before it runs", async () => {
    h = await startHosted();
    // A chunked body states no size.
    const port = h.port;
    const unsized = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/auth/sign-in/email", method: "POST", headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, "Content-Type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.write(JSON.stringify({ email: "x@example.com" }));
      req.end(JSON.stringify({}).slice(0, 0));
    });
    expect(unsized).toBe(413);
    const big = await h.browser().auth("POST", "/api/auth/sign-up/email", { email: "big@example.com", password: TEST_PASSWORD, name: "x".repeat(70_000) });
    expect(big.status).toBe(413);
  });
});

describe("0020, B6: the origin check", () => {
  it("refuses a cross-origin sign-in and sign-up, and sets no cookie", async () => {
    h = await startHosted();
    await h.signUp(h.browser(), { email: "victim@example.com" });
    const b = h.browser();
    for (const p of ["/api/auth/sign-in/email", "/api/auth/sign-up/email"]) {
      const r = await b.auth("POST", p, { email: "victim@example.com", password: TEST_PASSWORD, name: "" }, { Origin: "https://evil.example" });
      expect(r.status, p).toBe(403);
      expect(r.body.code).toBe("INVALID_ORIGIN");
      expect(sessionCookie(r)).toBeUndefined();
    }
    // A cross-site form post, as a page on another site makes it.
    const nav = await b.auth("POST", "/api/auth/sign-in/email", { email: "victim@example.com", password: TEST_PASSWORD }, { Origin: "null", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" });
    expect(nav.status).toBe(403);
    // The app's own routes still need the app's origin and header.
    const own = await h.raw("POST", "/api/session/signout", { Origin: "https://evil.example", "Content-Type": "application/json" }, {});
    expect(own.status).toBe(403);
  });
});

describe("0020, B2: rate limits", () => {
  it("Better Auth allows 3 sign-in tries per 10 seconds from an address, and another address is apart", async () => {
    h = await startHosted();
    await h.signUp(h.browser(), { email: "rl@example.com" });
    const b = h.browser();
    const tries = [];
    for (let i = 0; i < 4; i++) tries.push((await h.signIn(b, "rl@example.com", "wrong password!")).status);
    expect(tries).toEqual([401, 401, 401, 429]);
    expect((await h.signIn(h.browser(), "rl@example.com")).status).toBe(200);
  });

  it("the app's own limit allows 20 sign-in tries per address in 10 minutes", async () => {
    let t = Date.parse("2026-11-02T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => t);
    h = await startHosted({ now: () => t });
    await h.signUp(h.browser(), { email: "app-rl@example.com" });
    const b = h.browser();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      // Past Better Auth's 10 second window each time.
      t += 11_000;
      statuses.push((await h.signIn(b, "app-rl@example.com", "wrong password!")).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    const last = await h.signIn(b, "app-rl@example.com");
    expect(statuses[20]).toBe(429);
    expect(last.status).toBe(429);
    expect(last.body.message).toBe(RATE_LIMITED_TEXT);
  });
});

async function addPasskey(b: Browser, key: SoftPasskey, origin: string) {
  const options = await b.auth("GET", "/api/auth/passkey/generate-register-options");
  expect(options.status).toBe(200);
  return b.auth("POST", "/api/auth/passkey/verify-registration", { response: key.register(options.body, origin), name: "Test passkey" });
}

async function passkeySignIn(b: Browser, key: SoftPasskey, origin: string, overrides: { rpId?: string; origin?: string } = {}) {
  const options = await b.auth("GET", "/api/auth/passkey/generate-authenticate-options");
  expect(options.status).toBe(200);
  return b.auth("POST", "/api/auth/passkey/verify-authentication", { response: key.authenticate(options.body, origin, overrides) });
}

describe("0020, B3: passkeys", () => {
  it("a signed-in person adds a passkey, signs out, and signs in with it alone", async () => {
    h = await startHosted();
    const b = h.browser();
    await h.signUp(b, { email: "keys@example.com" });
    const id = await h.accountOf(b);
    const key = new SoftPasskey();
    const added = await addPasskey(b, key, h.authConfig.origin);
    expect(added.status).toBe(200);
    expect((await b.auth("GET", "/api/auth/passkey/list-user-passkeys")).body).toHaveLength(1);
    await b.call("POST", "/api/session/signout", {});
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(false);

    const fresh = h.browser();
    const r = await passkeySignIn(fresh, key, h.authConfig.origin);
    expect(r.status).toBe(200);
    expect(r.body.session?.token).toBeUndefined();
    expect(r.body.token).toBeUndefined();
    expect(await h.accountOf(fresh)).toBe(id);
  });

  it("refuses a passkey answer for another site, or another origin, and adding one needs a session", async () => {
    h = await startHosted();
    const b = h.browser();
    await h.signUp(b);
    const key = new SoftPasskey();
    expect((await addPasskey(b, key, h.authConfig.origin)).status).toBe(200);
    const anon = h.browser();
    expect((await passkeySignIn(anon, key, h.authConfig.origin, { rpId: "evil.example" })).status).toBe(400);
    expect((await passkeySignIn(anon, key, h.authConfig.origin, { origin: "https://evil.example" })).status).toBe(400);
    expect((await anon.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect((await h.browser().auth("GET", "/api/auth/passkey/generate-register-options")).status).toBe(401);
  });
});

describe("0020, B5: judge codes and credits on an email account", () => {
  it("redeems a code after sign-up once, and a revoked code takes its unspent credit back", async () => {
    h = await startHosted();
    const b = h.browser();
    await h.signUp(b);
    const { id, code } = h.judgeCode("Judge A", 5);
    const added = await b.call("POST", "/api/account/judge-code", { code });
    expect(added.status).toBe(200);
    expect(added.body.balance).toBe("$5.00");
    expect(added.body.canAddCode).toBe(true);
    // Each account takes one code, and each code works once.
    expect((await b.call("POST", "/api/account/judge-code", { code: h.judgeCode("Judge B", 1).code })).body.error).toBe("judge_has_code");
    const other = h.browser();
    await h.signUp(other);
    expect((await other.call("POST", "/api/account/judge-code", { code })).body.error).toBe("judge_used");
    // The code no longer signs in on its own: it belongs to the email account.
    expect((await h.browser().call("POST", "/api/session/judge", { code })).body.error).toBe("judge_attached");
    h.app.store.revokeJudgeCode(id);
    expect((await b.call("GET", "/api/session")).body).toMatchObject({ signedIn: true, balance: "$0.00" });
  });

  it("a judge code still signs in on its own, and signing in by email after it ends the judge session", async () => {
    h = await startHosted();
    const b = h.browser();
    const j = await b.call("POST", "/api/session/judge", { code: h.judgeCode().code });
    expect(j.body.account.kind).toBe("judge");
    const judgeCookie = b.cookies.get(`appt_session_${h.port}`)!;
    await h.signUp(b, { email: "after-judge@example.com" });
    expect((await b.call("GET", "/api/session")).body.account.kind).toBe("user");
    await b.call("POST", "/api/session/signout", {});
    // Sign-out ends both kinds.
    expect((await h.raw("GET", "/api/state", { Cookie: `appt_session_${h.port}=${judgeCookie}` })).status).toBe(401);
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(false);
  });
});

describe("0020, B5: Delete account", () => {
  it("deletes the Better Auth user with its password, passkeys and sessions, and the workspace", async () => {
    h = await startHosted();
    const b = h.browser();
    await h.signUp(b, { email: "gone@example.com" });
    const id = await h.accountOf(b);
    const key = new SoftPasskey();
    await addPasskey(b, key, h.authConfig.origin);
    const second = h.browser();
    await h.signIn(second, "gone@example.com");
    await b.call("GET", "/api/state");
    const del = await b.call("POST", "/api/account/delete", { confirmation: "DELETE" });
    expect(del.body).toEqual({ deleted: true });
    expect(cookiesOf(del).some((c) => /\.session_token=; .*Max-Age=0/.test(c))).toBe(true);
    expect(h.app.store.account(id)).toMatchObject({ deleted: true, email: null });
    // Every session, the password and the passkey went with the user.
    expect((await second.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect((await h.signIn(h.browser(), "gone@example.com")).status).toBe(401);
    expect((await passkeySignIn(h.browser(), key, h.authConfig.origin)).status).not.toBe(200);
    const db = new DatabaseSync(path.join(h.dir, "hosted", "auth.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM user").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM passkey").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 0 });
    db.close();
    // The email may sign up again, as a new, empty account.
    const again = h.browser();
    expect((await h.signUp(again, { email: "gone@example.com" })).status).toBe(200);
    expect(await h.accountOf(again)).not.toBe(id);
  });

  it("a user deleted outside the app, as from the dashboard, closes its account too", async () => {
    h = await startHosted();
    const b = h.browser();
    await h.signUp(b, { email: "dash-gone@example.com" });
    const id = await h.accountOf(b);
    const user = (await b.auth("GET", "/api/auth/get-session")).body.user.id;
    await h.app.auth.deleteUser(user);
    await vi.waitFor(() => expect(h!.app.store.account(id)).toMatchObject({ deleted: true }));
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(false);
  });
});

describe("0020, B6 and B11: behind Tailscale Funnel on port 10000", () => {
  const funnel = (h: Hosted, extra: Record<string, string> = {}) => ({
    Host: PUBLIC_HOST,
    "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": PUBLIC_HOST,
    "X-Forwarded-For": "203.0.113.9",
    "Tailscale-Funnel-Request": "?1",
    ...extra,
  });

  it("sets the __Secure- cookie with Secure, HttpOnly and SameSite=Lax, and the session reads through the proxy", async () => {
    h = await startHosted({ env: { APP_TRUSTED_PROXY: "tailscale" }, authEnv: { BETTER_AUTH_URL: PUBLIC } });
    const up = await h.raw("POST", "/api/auth/sign-up/email", { ...funnel(h), Origin: PUBLIC, "Content-Type": "application/json" }, { email: "funnel@example.com", password: TEST_PASSWORD, name: "" });
    expect(up.status).toBe(200);
    const c = sessionCookie(up)!;
    expect(c).toMatch(/^__Secure-appt\.session_token=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    const pair = c.split(";")[0]!;
    const s = await h.raw("GET", "/api/session", { ...funnel(h), Cookie: pair });
    expect(s.body).toMatchObject({ signedIn: true, account: { email: "funnel@example.com" } });
    // The app's own routes take writes from the public origin, with its port.
    expect((await h.raw("POST", "/api/session/signout", { ...funnel(h), Origin: PUBLIC, "Content-Type": "application/json", "X-Appointments-App": "1", Cookie: pair }, {})).status).toBe(200);
  });

  it("allows the host only with its port, and the origin only with its port", async () => {
    h = await startHosted({ env: { APP_TRUSTED_PROXY: "tailscale" }, authEnv: { BETTER_AUTH_URL: PUBLIC } });
    expect((await h.raw("GET", "/api/session", funnel(h, { Host: "the-little-ai-co.tail374dd0.ts.net" }))).status).toBe(403);
    const noPort = await h.raw("POST", "/api/auth/sign-up/email", { ...funnel(h), Origin: "https://the-little-ai-co.tail374dd0.ts.net", "Content-Type": "application/json" }, { email: "x@example.com", password: TEST_PASSWORD, name: "" });
    expect(noPort.status).toBe(403);
    expect(noPort.body.code).toBe("INVALID_ORIGIN");
    expect(h.authConfig).toMatchObject({ origin: PUBLIC, host: PUBLIC_HOST, rpId: "the-little-ai-co.tail374dd0.ts.net", secure: true });
  });

  it("passkeys use the host name as the relying party and the origin with its port", async () => {
    h = await startHosted({ env: { APP_TRUSTED_PROXY: "tailscale" }, authEnv: { BETTER_AUTH_URL: PUBLIC } });
    const jar = new Map<string, string>();
    const call = async (method: string, p: string, body?: unknown) => {
      const r = await h!.raw(method, p, { ...funnel(h!), ...(method === "GET" ? {} : { Origin: PUBLIC, "Content-Type": "application/json" }), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }, body);
      for (const c of cookiesOf(r)) {
        const [pair] = c.split(";");
        jar.set(pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1));
      }
      return r;
    };
    await call("POST", "/api/auth/sign-up/email", { email: "rp@example.com", password: TEST_PASSWORD, name: "" });
    const options = await call("GET", "/api/auth/passkey/generate-register-options");
    expect(options.body.rp.id).toBe("the-little-ai-co.tail374dd0.ts.net");
    const key = new SoftPasskey();
    expect((await call("POST", "/api/auth/passkey/verify-registration", { response: key.register(options.body, PUBLIC) })).status).toBe(200);
    jar.clear();
    const auth = await call("GET", "/api/auth/passkey/generate-authenticate-options");
    expect(auth.body.rpId).toBe("the-little-ai-co.tail374dd0.ts.net");
    expect((await call("POST", "/api/auth/passkey/verify-authentication", { response: key.authenticate(auth.body, PUBLIC) })).status).toBe(200);
  });

  it("trusts Tailscale's X-Forwarded-For only from loopback, and only as one plain address", () => {
    expect(clientAddress({ "x-forwarded-for": "203.0.113.9" }, "127.0.0.1", "tailscale")).toBe("203.0.113.9");
    expect(clientAddress({ "x-forwarded-for": "2001:db8::7" }, "::1", "tailscale")).toBe("2001:db8::7");
    expect(clientAddress({ "x-forwarded-for": "203.0.113.9" }, "198.51.100.4", "tailscale")).toBe("198.51.100.4");
    expect(clientAddress({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }, "127.0.0.1", "tailscale")).toBe("127.0.0.1");
    expect(clientAddress({ "x-forwarded-for": "not-an-ip" }, "127.0.0.1", "tailscale")).toBe("127.0.0.1");
    expect(clientAddress({ "cf-connecting-ip": "203.0.113.9" }, "127.0.0.1", "tailscale")).toBe("127.0.0.1");
    expect(clientAddress({ "x-forwarded-for": "203.0.113.9" }, "127.0.0.1", "none")).toBe("127.0.0.1");
  });

  it("Better Auth's limits count each Funnel visitor apart, and a client cannot set the address header", async () => {
    h = await startHosted({ env: { APP_TRUSTED_PROXY: "tailscale" }, authEnv: { BETTER_AUTH_URL: PUBLIC } });
    const tryIn = (ip: string, extra: Record<string, string> = {}) =>
      h!.raw("POST", "/api/auth/sign-in/email", { ...funnel(h!, { "X-Forwarded-For": ip }), Origin: PUBLIC, "Content-Type": "application/json", ...extra }, { email: "nobody@example.com", password: "wrong password!" });
    const one = [];
    for (let i = 0; i < 4; i++) one.push((await tryIn("203.0.113.1", { "X-Appt-Client-Address": `198.51.100.${i}` })).status);
    expect(one).toEqual([401, 401, 401, 429]);
    expect((await tryIn("203.0.113.2")).status).toBe(401);
  });
});

describe("0020, B7: the dashboard plugin", () => {
  it("is off without BETTER_AUTH_API_KEY and makes no outside call", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      calls.push(String(input));
      throw new Error("no network in tests");
    });
    h = await startHosted();
    expect(h.app.auth.dashboardOn).toBe(false);
    expect(h.app.startLines().join("\n")).toContain("The Better Auth dashboard plugin is off.");
    const b = h.browser();
    await h.signUp(b);
    await b.call("POST", "/api/session/signout", {});
    expect(calls).toEqual([]);
    expect((await b.auth("GET", "/api/auth/dash/config")).status).toBe(404);
  });

  it("is on with a fake key: sign-up events go to the dashboard address, never the password, and its routes need Better Auth's signed token", async () => {
    const calls: Array<{ url: string; body: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
      const req = input instanceof Request ? input : null;
      calls.push({ url: req ? req.url : String(input), body: req ? await req.clone().text() : String(init.body ?? ""), auth: new Headers(req ? req.headers : init.headers).get("authorization") });
      return Response.json({}, { status: 200 });
    });
    const KEY = "ba_fake_dashboard_key_for_tests_only_0123456789";
    h = await startHosted({ authEnv: { BETTER_AUTH_API_KEY: KEY, BETTER_AUTH_API_URL: "https://dash.example.test", BETTER_AUTH_KV_URL: "https://kv.example.test" } });
    expect(h.app.auth.dashboardOn).toBe(true);
    const lines = h.app.startLines().join("\n");
    expect(lines).toContain("The Better Auth dashboard plugin is on");
    expect(lines).not.toContain(KEY);
    const b = h.browser();
    await h.signUp(b, { email: "dash@example.com", name: "Dash Person" });
    await h.signIn(h.browser(), "dash@example.com", "wrong password!");
    await vi.waitFor(() => expect(calls.some((c) => c.url.startsWith("https://dash.example.test/events/track"))).toBe(true));
    for (const c of calls) {
      expect(c.url.startsWith("https://dash.example.test/") || c.url.startsWith("https://kv.example.test/")).toBe(true);
      expect(c.body).not.toContain(TEST_PASSWORD);
      expect(c.body).not.toContain("wrong password!");
    }
    // What a sign-up sends: the user's id, email and name, and the address.
    const signup = calls.find((c) => c.url.endsWith("/events/track") && c.body.includes("user_created"))!;
    expect(JSON.parse(signup.body)).toMatchObject({ eventType: "user_created", eventData: { userEmail: "dash@example.com", userName: "Dash Person" }, ipAddress: expect.any(String) });
    // The dashboard's routes refuse a request without its signed token.
    expect((await b.auth("GET", "/api/auth/dash/config")).status).toBe(401);
    expect((await b.auth("POST", "/api/auth/dash/execute-adapter", { action: "count", model: "user" })).status).toBe(401);
  });
});

describe("0020, B8 and the logs: no secret, password, token or email", () => {
  it("readAuthConfig needs a 32 byte secret and an https origin, and its errors hold neither", () => {
    const secret = "s".repeat(31);
    for (const env of [{}, { BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: PUBLIC }, { BETTER_AUTH_SECRET: TEST_AUTH_SECRET }, { BETTER_AUTH_SECRET: TEST_AUTH_SECRET, BETTER_AUTH_URL: "http://example.com" }, { BETTER_AUTH_SECRET: TEST_AUTH_SECRET, BETTER_AUTH_URL: `${PUBLIC}/app` }, { BETTER_AUTH_SECRET: TEST_AUTH_SECRET, BETTER_AUTH_URL: "http://127.0.0.1:5300" }]) {
      let err: unknown;
      try {
        readAuthConfig(env);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect(String((err as Error).message)).not.toContain(secret);
      expect(String((err as Error).message)).not.toContain(TEST_AUTH_SECRET);
    }
    expect(readAuthConfig({ BETTER_AUTH_SECRET: TEST_AUTH_SECRET, BETTER_AUTH_URL: "http://localhost:5300" })).toMatchObject({ secure: false, rpId: "localhost", dashboard: null });
  });

  it("a whole run of sign-ups, failures and passkeys leaves no secret, password, token or email in the log or an answer", async () => {
    h = await startHosted();
    const answers: string[] = [];
    const b = h.browser();
    const record = (r: Res) => (answers.push(r.text), r);
    record(await h.signUp(b, { email: "logs@example.com" }));
    record(await h.signIn(h.browser(), "logs@example.com", "wrong password!"));
    record(await h.browser().auth("POST", "/api/auth/sign-in/email", { email: "logs@example.com", password: TEST_PASSWORD }, { Origin: "https://evil.example" }));
    record(await addPasskey(b, new SoftPasskey(), h.authConfig.origin));
    record(await b.call("GET", "/api/session"));
    record(await b.call("POST", "/api/account/judge-code", { code: "judge_nope" }));
    const token = b.cookies.get(`appt-${h.port}.session_token`)!;
    const all = [...h.logs, ...answers].join("\n");
    expect(h.logs.join("\n")).not.toContain("logs@example.com");
    for (const secret of [TEST_AUTH_SECRET, TEST_PASSWORD, "wrong password!", token, token.split(".")[0]!]) expect(all).not.toContain(secret);
    expect(authLogLine("error", "User not found for logs@example.com")).toBe("Better Auth error: User not found for [email]");
    // The request log writes Better Auth's paths without a value.
    expect(loggedPath("/api/auth/sign-in/email?email=logs@example.com")).toBe("/api/auth/sign-in/email");
    expect(loggedPath("/api/auth/reset-password/abc123secret")).toBe("/api/auth/reset-password/*");
  });
});

describe("0020: an accounts database from before Better Auth", () => {
  it("is brought up to date with every row kept, and takes email accounts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "s18-migrate-"));
    dirs.push(dir);
    const file = path.join(dir, "accounts.sqlite");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('google', 'judge')), google_sub TEXT UNIQUE, email TEXT, name TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER) STRICT;
CREATE TABLE sessions (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts (id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
INSERT INTO accounts VALUES ('a${"1".repeat(32)}', 'google', 'sub-1', 'old@example.com', 'Old', 1, NULL);
INSERT INTO sessions VALUES ('h', 'a${"1".repeat(32)}', 1, 2);`);
    old.close();
    const s = new AccountsStore(file);
    expect(s.account(`a${"1".repeat(32)}`)).toMatchObject({ kind: "google", email: "old@example.com" });
    const u = s.userAccount({ userId: "ba-user-1", email: "new@example.com", name: null });
    expect(u.kind).toBe("user");
    expect(s.userAccount({ userId: "ba-user-1", email: "new@example.com", name: null }).id).toBe(u.id);
    expect(s.accountOfUser("ba-user-1")!.id).toBe(u.id);
    s.close();
  });
});

describe("0020, B2 and B12: the coordinator's reset and backup", () => {
  it("reset-password sets a new password once, ends the sessions and keeps the passkeys", async () => {
    h = await startHosted();
    const b = h.browser();
    await h.signUp(b, { email: "forgot@example.com" });
    await addPasskey(b, new SoftPasskey(), h.authConfig.origin);
    const env = { APP_DB: path.join(h.dir, "app.sqlite") };
    const r = await runAdminAsync(["users", "reset-password", "--email", "Forgot@Example.com"], env);
    expect(r.code).toBe(0);
    const password = r.out.at(-1)!;
    expect(password).toMatch(/^[A-Za-z0-9_-]{20}$/);
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect((await h.signIn(h.browser(), "forgot@example.com")).status).toBe(401);
    expect((await h.signIn(h.browser(), "forgot@example.com", password)).status).toBe(200);
    expect((await runAdminAsync(["users", "list"], env)).out.join("\n")).toContain("forgot@example.com");
    expect((await runAdminAsync(["users", "list"], env)).out.join("\n")).toContain("1 passkey(s)");
    expect((await runAdminAsync(["users", "reset-password", "--email", "nobody@example.com"], env)).code).toBe(1);
  });

  it("backup copies both databases with VACUUM INTO into a new private folder", async () => {
    h = await startHosted();
    await h.signUp(h.browser(), { email: "kept@example.com" });
    const to = path.join(h.dir, "backup-1");
    const r = await runAdminAsync(["backup", "--to", to], { APP_DB: path.join(h.dir, "app.sqlite") });
    expect(r.code).toBe(0);
    expect(statSync(to).mode & 0o777).toBe(0o700);
    for (const f of ["accounts.sqlite", "auth.sqlite"]) expect(statSync(path.join(to, f)).mode & 0o777).toBe(0o600);
    const copy = new DatabaseSync(path.join(to, "auth.sqlite"), { readOnly: true });
    expect(copy.prepare("SELECT email FROM user").all()).toEqual([{ email: "kept@example.com" }]);
    copy.close();
    expect((await runAdminAsync(["backup", "--to", to], { APP_DB: path.join(h.dir, "app.sqlite") })).code).toBe(2);
  });
});
