// Hosted mode, design item 3 (0014): Sign in with Google against the fake
// Google endpoints, the session cookie, its lifetime, sign-out, the rate
// limit on sign-in starts, and the checks every route keeps.
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_TTL_MS } from "../src/hosted/store.ts";
import { SIGNIN_SCOPES } from "../src/hosted/signin.ts";
import { jwt, signingKey } from "./provider-fakes.ts";
import { startHosted, type Hosted } from "./hosted-helpers.ts";

let h: Hosted | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("Sign in with Google", () => {
  it("signs in with openid email profile only, sets an HttpOnly session cookie, and keeps only the token's hash", async () => {
    h = await startHosted();
    const b = h.browser();
    expect((await b.call("GET", "/api/session")).body).toEqual({ mode: "hosted", signedIn: false, googleSignIn: true });
    const start = await b.call("POST", "/api/session/google", {});
    expect(start.status).toBe(200);
    const url = new URL(start.body.authorizeUrl);
    expect(url.searchParams.get("scope")).toBe(SIGNIN_SCOPES.join(" "));
    expect(url.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${h.port}/auth/signin/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBeNull();
    expect(url.searchParams.get("nonce")).toBeTruthy();
    const flowCookie = String(start.headers["set-cookie"]);
    expect(flowCookie).toMatch(/^appt_signin_\d+=[^;]+; Path=\/auth\/signin; HttpOnly; SameSite=Lax/);

    h.google!.fake.idToken = { name: "Dana Demo" };
    const back = h.google!.fake.consent(start.body.authorizeUrl);
    const cb = await b.visit(`${back.pathname}${back.search}`);
    expect(cb.status).toBe(303);
    expect(cb.headers.location).toBe("/?signedIn=google");
    const set = (cb.headers["set-cookie"] as string[]).find((c) => c.startsWith(`appt_session_${h!.port}=`))!;
    expect(set).toMatch(/; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const token = b.cookies.get(`appt_session_${h.port}`)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const s = await b.call("GET", "/api/session");
    expect(s.body).toMatchObject({ mode: "hosted", signedIn: true, account: { kind: "google", email: "dana.demo@example.com", name: "Dana Demo" }, balanceMicros: 0, balance: "$0.00" });
    // The token itself is in no log and not in the database file.
    expect(h.logs.join("\n")).not.toContain(token);
    const { readFileSync } = await import("node:fs");
    const file = readFileSync(h.app.store.file);
    expect(file.includes(Buffer.from(token))).toBe(false);
  });

  it("over HTTPS uses the __Host- cookie with Secure", async () => {
    h = await startHosted();
    const b = h.browser();
    const r = await b.call("POST", "/api/session/judge", { code: h.judgeCode().code }, { "X-Forwarded-Proto": "https" });
    const set = r.headers["set-cookie"] as string[];
    expect(set.find((c) => c.startsWith("__Host-"))).toMatch(/^__Host-appt_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
    // The loopback form is cleared (review round 1, finding 6).
    expect(set).toContain(`appt_session_${h.port}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  });

  it("refuses a callback with no flow, a wrong cookie, a bad signature, a wrong nonce or an unverified email", async () => {
    h = await startHosted();
    const b = h.browser();
    expect((await b.visit("/auth/signin/callback?state=nope&code=x")).headers.location).toBe("/?signInError=invalid_state");

    // Another browser's flow cookie.
    const start = await b.call("POST", "/api/session/google", {});
    const other = h.browser();
    const back = h.google!.fake.consent(start.body.authorizeUrl);
    expect((await other.visit(`${back.pathname}${back.search}`)).headers.location).toBe("/?signInError=invalid_state");

    // A token signed by a key Google never published.
    const stranger = signingKey("google-test-key");
    h.google!.fake.idToken = {};
    const s2 = await b.call("POST", "/api/session/google", {});
    const back2 = h.google!.fake.consent(s2.body.authorizeUrl);
    // Swap in a token signed by the stranger at the token endpoint.
    const original = h.google!.fake.fetch;
    h.google!.fake.fetch = async (input, init) => {
      const res = await original(input, init);
      if (String(input) !== "https://oauth2.googleapis.com/token") return res;
      const body = (await res.json()) as Record<string, string>;
      const payload = JSON.parse(Buffer.from(body.id_token!.split(".")[1]!, "base64url").toString("utf8"));
      return Response.json({ ...body, id_token: jwt(payload, stranger) });
    };
    // The helper re-signs with the real key, so turn that off for this one.
    h.google!.unsigned();
    expect((await b.visit(`${back2.pathname}${back2.search}`)).headers.location).toBe("/?signInError=id_token_signature");
    h.google!.fake.fetch = original;

    // Unsigned again (fake-signature) also fails.
    const s3 = await b.call("POST", "/api/session/google", {});
    const back3 = h.google!.fake.consent(s3.body.authorizeUrl);
    expect((await b.visit(`${back3.pathname}${back3.search}`)).headers.location).toBe("/?signInError=id_token_signature");
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect(h.logs.every((l) => /^Sign in with Google failed: [a-z_]+\.$/.test(l))).toBe(true);
  });

  it("checks the nonce and a verified email", async () => {
    for (const [idToken, code] of [
      [{ nonce: "another" }, "id_token_nonce"],
      [{ email_verified: false }, "email_unverified"],
      [{ aud: "someone-else" }, "id_token_audience"],
      [{ iss: "https://evil.example" }, "id_token_issuer"],
    ] as const) {
      h = await startHosted();
      const b = h.browser();
      h.google!.fake.idToken = idToken;
      const start = await b.call("POST", "/api/session/google", {});
      const back = h.google!.fake.consent(start.body.authorizeUrl);
      expect((await b.visit(`${back.pathname}${back.search}`)).headers.location).toBe(`/?signInError=${code}`);
      await h.close();
      h = null;
    }
  });

  it("the same Google account reopens the same account, and another opens its own", async () => {
    h = await startHosted();
    const a1 = h.browser();
    await h.googleSignIn(a1, { sub: "sub-a", email: "a@example.com" });
    const a2 = h.browser();
    await h.googleSignIn(a2, { sub: "sub-a", email: "a@example.com" });
    const b = h.browser();
    await h.googleSignIn(b, { sub: "sub-b", email: "b@example.com" });
    const id = (x: typeof a1) => h!.app.store.session(x.cookies.get(`appt_session_${h!.port}`)!)!.account.id;
    expect(id(a1)).toBe(id(a2));
    expect(id(b)).not.toBe(id(a1));
  });

  it("a session lasts 30 days, and sign-out ends it at once", async () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    h = await startHosted({ now: () => now });
    const b = h.browser();
    await h.googleSignIn(b);
    expect((await b.call("GET", "/api/state")).status).toBe(200);
    now += SESSION_TTL_MS - 1000;
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(true);
    now += 2000;
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect((await b.call("GET", "/api/state")).body).toMatchObject({ error: "signed_out" });

    await h.googleSignIn(b);
    const token = b.cookies.get(`appt_session_${h.port}`)!;
    const out = await b.call("POST", "/api/session/signout", {});
    expect(out.body).toMatchObject({ signedIn: false });
    expect(String(out.headers["set-cookie"])).toMatch(/Max-Age=0/);
    // The old token no longer works, even if a browser kept it.
    const replay = await h.raw("GET", "/api/state", { Cookie: `appt_session_${h.port}=${token}` });
    expect(replay.status).toBe(401);
  });

  it("rate-limits sign-in starts per address", async () => {
    h = await startHosted();
    const b = h.browser();
    const answers = [];
    for (let i = 0; i < 11; i++) answers.push((await b.call("POST", "/api/session/google", {}, { "CF-Connecting-IP": "203.0.113.7" })).status);
    expect(answers.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(answers[10]).toBe(429);
    // Another address is not limited.
    expect((await b.call("POST", "/api/session/google", {}, { "CF-Connecting-IP": "203.0.113.8" })).status).toBe(200);
  });

  it("keeps the host allowlist, the same-origin guard and the app header on every route", async () => {
    h = await startHosted();
    const b = h.browser();
    expect((await h.raw("GET", "/api/session", { Host: "evil.example" })).status).toBe(403);
    expect((await b.call("POST", "/api/session/judge", { code: "x" }, { Origin: "https://evil.example" })).body.error).toBe("forbidden_source");
    expect((await b.call("POST", "/api/session/google", {}, { "X-Appointments-App": "0" })).body.error).toBe("forbidden_source");
    expect((await b.call("POST", "/api/session/signout", {}, { "Content-Type": "text/plain" })).status).toBe(415);
    // Signed out, every workspace route answers 401 and writes nothing.
    for (const [m, p] of [["GET", "/api/state"], ["GET", "/api/chat"], ["GET", "/api/settings"], ["GET", "/api/google"], ["POST", "/api/messages"]] as const) {
      expect((await b.call(m, p, m === "GET" ? undefined : {}, { "X-Case-Generation": "0" })).status).toBe(401);
    }
  });

  it("without a Google client, only judge codes sign in", async () => {
    h = await startHosted({ google: false });
    const b = h.browser();
    expect((await b.call("GET", "/api/session")).body.googleSignIn).toBe(false);
    expect((await b.call("POST", "/api/session/google", {})).body.error).toBe("sign_in_unavailable");
  });
});
