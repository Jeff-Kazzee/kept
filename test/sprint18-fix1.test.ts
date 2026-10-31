// Sprint 18 fix round 1 (Muse Wonder's review of 53ee090..a540639) and
// Jeff's K7 and K9: no judge session revives after an email sign-in, a
// deleted account never gets a fresh workspace, an expired code takes no
// grant, Better Auth's routes are an allowlist, every disabled route and
// every bad dashboard token is refused, a refused sign-up says only that
// the email cannot be used, sign-up is off unless APP_PUBLIC_SIGNUP is on,
// and the waitlist link. Offline.
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAdminAsync } from "../scripts/admin.ts";
import { DISABLED_PATHS, authRouteServed, readAuthConfig } from "../src/hosted/auth.ts";
import { ConfigError } from "../src/hosted/config.ts";
import { AccountsStore, JudgeCodeError } from "../src/hosted/store.ts";
import { SIGNUP_CLOSED_TEXT } from "../server/hosted.ts";
import { AccountClosedError } from "../server/workspaces.ts";
import { TEST_AUTH_SECRET, TEST_PASSWORD, startHosted, type Hosted, type Res } from "./hosted-helpers.ts";
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

describe("item 1: an email sign-in ends the browser's judge session", () => {
  it("judge, then email sign-in: the judge cookie is cleared, its session ended, and Better Auth's own sign-out is gone", async () => {
    h = await startHosted();
    await h.signUp(h.browser(), { email: "shared@example.com" });
    const b = h.browser();
    await b.call("POST", "/api/session/judge", { code: h.judgeCode().code });
    const judgeCookie = b.cookies.get(`appt_session_${h.port}`)!;
    expect(judgeCookie).toBeTruthy();
    const signedIn = await h.signIn(b, "shared@example.com");
    expect(signedIn.status).toBe(200);
    expect(cookiesOf(signedIn).some((c) => c.startsWith(`appt_session_${h!.port}=; `))).toBe(true);
    expect(b.cookies.has(`appt_session_${h.port}`)).toBe(false);
    // The judge session is ended on the server, not only forgotten.
    expect((await h.raw("GET", "/api/session", { Cookie: `appt_session_${h.port}=${judgeCookie}` })).body.signedIn).toBe(false);
    // Better Auth's sign-out is not served, so it cannot leave the judge
    // cookie behind: only the app's sign-out ends sessions.
    expect((await b.auth("POST", "/api/auth/sign-out", {})).status).toBe(404);
    expect((await b.call("GET", "/api/session")).body.account.kind).toBe("user");
    await b.call("POST", "/api/session/signout", {});
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(false);
    // Even with the old judge cookie sent back by hand, nothing revives.
    expect((await h.raw("GET", "/api/session", { Cookie: `appt_session_${h.port}=${judgeCookie}; ${b.cookieHeader()}` })).body.signedIn).toBe(false);
  });

  it("a sign-up and a passkey sign-in also end the judge session, and a failed sign-in leaves it", async () => {
    h = await startHosted();
    const b = h.browser();
    await b.call("POST", "/api/session/judge", { code: h.judgeCode("A").code });
    expect((await h.signIn(b, "nobody@example.com")).status).toBe(401);
    expect((await b.call("GET", "/api/session")).body.account.kind).toBe("judge");
    await h.signUp(b, { email: "after-judge-2@example.com" });
    expect(b.cookies.has(`appt_session_${h.port}`)).toBe(false);
    const key = new SoftPasskey();
    const options = await b.auth("GET", "/api/auth/passkey/generate-register-options");
    await b.auth("POST", "/api/auth/passkey/verify-registration", { response: key.register(options.body, h.authConfig.origin) });
    await b.call("POST", "/api/session/signout", {});
    await b.call("POST", "/api/session/judge", { code: h.judgeCode("B").code });
    const judgeCookie = b.cookies.get(`appt_session_${h.port}`)!;
    const auth = await b.auth("GET", "/api/auth/passkey/generate-authenticate-options");
    expect((await b.auth("POST", "/api/auth/passkey/verify-authentication", { response: key.authenticate(auth.body, h.authConfig.origin) })).status).toBe(200);
    expect(b.cookies.has(`appt_session_${h.port}`)).toBe(false);
    expect((await h.raw("GET", "/api/session", { Cookie: `appt_session_${h.port}=${judgeCookie}` })).body.signedIn).toBe(false);
  });
});

describe("item 2: Delete account and a request that read its session first", () => {
  it("the request is refused as signed out, and no workspace is made for the deleted account", async () => {
    h = await startHosted();
    const b = h.browser();
    await h.signUp(b, { email: "race@example.com" });
    const id = await h.accountOf(b);
    await b.call("GET", "/api/state");
    const dir = path.join(h.dir, "accounts", id);
    expect(existsSync(dir)).toBe(true);
    // Delete account finishes after this request read its session, and
    // before it reaches the workspace.
    const store = h.app.store;
    const userAccount = store.userAccount.bind(store);
    vi.spyOn(store, "userAccount").mockImplementationOnce((identity) => {
      const account = userAccount(identity);
      const claim = h!.app.workspaces.claim(account.id);
      claim.remove();
      claim.release();
      store.deleteAccount(account.id);
      return account;
    });
    const r = await b.call("GET", "/api/state");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("signed_out");
    expect(existsSync(dir)).toBe(false);
    expect(h.app.workspaces.isOpen(id)).toBe(false);
    await expect(h.app.workspaces.use(id, () => "served")).rejects.toBeInstanceOf(AccountClosedError);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("item 3: an expired judge code takes no grant", () => {
  it("grant refuses it with nothing written, as redeem does", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "s18-grant-"));
    dirs.push(dir);
    let now = Date.parse("2026-11-01T00:00:00Z");
    const s = new AccountsStore(path.join(dir, "accounts.sqlite"), { now: () => now });
    const { id, code } = s.createJudgeCode({ label: "J", capMicros: 1_000_000, expiresAt: now + 86_400_000, totalCapMicros: 100_000_000 });
    const account = s.redeemJudgeCode(code);
    now += 2 * 86_400_000;
    const before = s.ledger(account.id).length;
    let err: unknown;
    try {
      s.grantJudgeCode(id, 2_000_000, 100_000_000);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JudgeCodeError);
    expect((err as JudgeCodeError).code).toBe("expired");
    expect(s.ledger(account.id)).toHaveLength(before);
    expect(s.listJudgeCodes()[0]!.capMicros).toBe(1_000_000);
    s.close();
  });
});

describe("items 4 and 5: Better Auth's routes are an allowlist, and every disabled route is refused", () => {
  it("serves only the sign-in, sign-up, session and passkey routes, and the dashboard's only while it is on", () => {
    for (const p of ["/sign-in/email", "/sign-up/email", "/get-session", "/passkey/generate-register-options", "/passkey/verify-registration", "/passkey/generate-authenticate-options", "/passkey/verify-authentication", "/passkey/list-user-passkeys", "/passkey/delete-passkey"]) {
      expect(authRouteServed(p, false), p).toBe(true);
    }
    for (const p of ["/sign-out", "/ok", "/error", "/sign-in/social", "/sign-in/email/", "/passkey", "/dash/config", "/update-user", ""]) expect(authRouteServed(p, false), p).toBe(false);
    expect(authRouteServed("/dash/config", true)).toBe(true);
    expect(authRouteServed("/dash/execute-adapter", true)).toBe(true);
  });

  it("every DISABLED_PATHS entry, and any other path, answers 404 through HTTP, and Better Auth's own list refuses each too", async () => {
    h = await startHosted();
    const b = h.browser();
    await h.signUp(b);
    const concrete = (p: string) => p.replace(/:[a-z]+/g, "x");
    for (const p of [...DISABLED_PATHS.map(concrete), "/ok", "/error", "/anything-new", "/dash/config"]) {
      for (const method of ["GET", "POST"]) {
        const r = await b.auth(method, `/api/auth${p}`, method === "POST" ? {} : undefined);
        expect(r.status, `${method} ${p}`).toBe(404);
      }
    }
    // Behind the allowlist, Better Auth's disabled paths hold on their own.
    for (const p of DISABLED_PATHS.map(concrete)) {
      for (const method of ["GET", "POST"]) {
        const res = await h.app.auth.auth.handler(
          new Request(`${h.authConfig.origin}/api/auth${p}`, {
            method,
            headers: { origin: h.authConfig.origin, cookie: b.cookieHeader(), ...(method === "POST" ? { "content-type": "application/json" } : {}) },
            ...(method === "POST" ? { body: "{}" } : {}),
          }),
        );
        expect(res.status, `Better Auth ${method} ${p}`).toBe(404);
      }
    }
  });

  it("refuses a forged, an expired and a wrong-key dashboard token, and serves a good one, with no network", async () => {
    const KEY = "ba_fake_dashboard_key_for_tests_only_9876543210";
    const apiUrl = `https://dash-${randomUUID()}.example.test`;
    const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const forger = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const kid = "test-key-1";
    const jwk = { ...(signing.publicKey.export({ format: "jwk" }) as object), kid, alg: "ES256", use: "sig" };
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${apiUrl}/api/auth/jwks`) return Response.json({ keys: [jwk] });
      if (url.startsWith(apiUrl)) return Response.json({ valid: false });
      throw new Error(`no network in tests: ${url}`);
    });
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const jwt = (claims: Record<string, unknown>, key = signing.privateKey) => {
      const head = `${b64({ alg: "ES256", kid, typ: "JWT" })}.${b64(claims)}`;
      return `${head}.${sign("sha256", Buffer.from(head), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    };
    const hashOf = (k: string) => createHash("sha256").update(k).digest("hex");
    const nowS = () => Math.floor(Date.now() / 1000);
    h = await startHosted({ authEnv: { BETTER_AUTH_API_KEY: KEY, BETTER_AUTH_API_URL: apiUrl, BETTER_AUTH_KV_URL: `${apiUrl}/kv` } });
    await h.signUp(h.browser(), { email: "dash-target@example.com" });
    const b = h.browser();
    const count = (token: string) => b.auth("POST", "/api/auth/dash/execute-adapter", { action: "count", model: "user" }, { Authorization: `Bearer ${token}` });
    const fresh = { apiKeyHash: hashOf(KEY), iat: nowS(), exp: nowS() + 300, jti: randomUUID() };
    expect((await count("not-a-token")).status).toBe(401);
    expect((await count(jwt(fresh, forger.privateKey))).status).toBe(401);
    expect((await count(jwt({ ...fresh, apiKeyHash: hashOf("some-other-key") }))).status).toBe(401);
    expect((await count(jwt({ ...fresh, iat: nowS() - 3600, exp: nowS() - 3000 }))).status).toBe(401);
    // Older than the grace period and not vouched for by the replay check.
    expect((await count(jwt({ ...fresh, iat: nowS() - 120, exp: nowS() + 120 }))).status).toBe(401);
    // A good token is served: this is the power the plugin hands to
    // Better Auth's cloud (K6 keeps it off).
    const good = await count(jwt(fresh));
    expect(good.status).toBe(200);
    expect(good.body).toEqual({ count: 1 });
  });
});

describe("item 6: a refused sign-up says only that the email cannot be used", () => {
  it("a second sign-up with an email answers EMAIL_UNAVAILABLE, never that an account has it", async () => {
    h = await startHosted();
    await h.signUp(h.browser(), { email: "taken@example.com" });
    const again = await h.signUp(h.browser(), { email: "taken@example.com", password: "another password" });
    expect(again.status).toBe(422);
    expect(again.body).toEqual({ code: "EMAIL_UNAVAILABLE", message: "That email cannot be used here." });
    expect(again.text).not.toMatch(/exist|already/i);
  });
});

describe("K7: APP_PUBLIC_SIGNUP", () => {
  it("off by default: sign-up is refused on the server, and an account made with pnpm admin signs in and adds a passkey", async () => {
    h = await startHosted({ authEnv: { APP_PUBLIC_SIGNUP: "" } });
    expect(h.authConfig.publicSignup).toBe(false);
    const b = h.browser();
    expect((await b.call("GET", "/api/session")).body).toMatchObject({ signedIn: false, publicSignup: false });
    const up = await h.signUp(b, { email: "public@example.com" });
    expect(up.status).toBe(403);
    expect(up.body).toEqual({ error: "signup_closed", message: SIGNUP_CLOSED_TEXT });
    // Better Auth's own sign-up route is disabled too, not only the app's door.
    const direct = await h.app.auth.auth.handler(
      new Request(`${h.authConfig.origin}/api/auth/sign-up/email`, { method: "POST", headers: { origin: h.authConfig.origin, "content-type": "application/json" }, body: JSON.stringify({ email: "public@example.com", password: TEST_PASSWORD, name: "" }) }),
    );
    expect(direct.status).toBe(404);
    const db = new DatabaseSync(path.join(h.dir, "hosted", "auth.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM user").get()).toEqual({ n: 0 });
    db.close();

    const env = { APP_DB: path.join(h.dir, "app.sqlite") };
    const made = await runAdminAsync(["users", "create", "--email", "Existing@Example.com", "--name", "Ex Isting"], env);
    expect(made.code).toBe(0);
    const password = made.out.at(-1)!;
    expect(password).toMatch(/^[A-Za-z0-9_-]{20}$/);
    // Sprint 18 round 2: printed exactly once, in out and err together.
    expect([...made.out, ...made.err].join("\n").split(password).length - 1).toBe(1);
    expect((await runAdminAsync(["users", "create", "--email", "existing@example.com"], env)).code).toBe(1);
    expect((await h.signIn(b, "existing@example.com", password)).status).toBe(200);
    expect((await b.call("GET", "/api/session")).body.account).toMatchObject({ kind: "user", email: "existing@example.com", name: "Ex Isting" });
    const key = new SoftPasskey();
    const options = await b.auth("GET", "/api/auth/passkey/generate-register-options");
    expect((await b.auth("POST", "/api/auth/passkey/verify-registration", { response: key.register(options.body, h.authConfig.origin) })).status).toBe(200);
    const fresh = h.browser();
    const auth = await fresh.auth("GET", "/api/auth/passkey/generate-authenticate-options");
    expect((await fresh.auth("POST", "/api/auth/passkey/verify-authentication", { response: key.authenticate(auth.body, h.authConfig.origin) })).status).toBe(200);
    // Judge codes sign in as before.
    expect((await h.browser().call("POST", "/api/session/judge", { code: h.judgeCode().code })).status).toBe(200);
  });

  it("on: sign-up works and the session view says so, and a bad value stops the app", async () => {
    h = await startHosted({ authEnv: { APP_PUBLIC_SIGNUP: "on" } });
    const b = h.browser();
    expect((await b.call("GET", "/api/session")).body).toMatchObject({ publicSignup: true, waitlistUrl: null });
    expect((await h.signUp(b, { email: "open@example.com" })).status).toBe(200);
    expect(() => readAuthConfig({ BETTER_AUTH_SECRET: TEST_AUTH_SECRET, BETTER_AUTH_URL: "http://localhost:5300", APP_PUBLIC_SIGNUP: "yes" })).toThrow(ConfigError);
  });
});

describe("K9: APP_WAITLIST_URL", () => {
  const URL_ = "https://kept.here.now/";

  it("off sign-up with the setting: the session view carries the waitlist link", async () => {
    h = await startHosted({ authEnv: { APP_PUBLIC_SIGNUP: "off", APP_WAITLIST_URL: URL_ } });
    expect((await h.browser().call("GET", "/api/session")).body).toMatchObject({ publicSignup: false, waitlistUrl: "https://kept.here.now" });
  });

  it("unset, or with public sign-up on, there is no link, and only an https address is taken", async () => {
    h = await startHosted({ authEnv: { APP_PUBLIC_SIGNUP: "off" } });
    expect((await h.browser().call("GET", "/api/session")).body.waitlistUrl).toBeNull();
    await h.close();
    h = await startHosted({ authEnv: { APP_PUBLIC_SIGNUP: "on", APP_WAITLIST_URL: URL_ } });
    expect((await h.browser().call("GET", "/api/session")).body.waitlistUrl).toBeNull();
    for (const bad of ["http://kept.example/", "javascript:alert(1)", "not a url"]) {
      expect(() => readAuthConfig({ BETTER_AUTH_SECRET: TEST_AUTH_SECRET, BETTER_AUTH_URL: "http://localhost:5300", APP_WAITLIST_URL: bad }), bad).toThrow(ConfigError);
    }
  });
});
