// 0010, design item 3: Sign in with ChatGPT against offline fakes of
// OpenAI's discovery, key, token, revocation and model endpoints. Each test
// names the guide step it checks.
import { afterEach, describe, expect, it } from "vitest";
import { ChatGptAuth, ChatGptAuthError, DYNAMIC_CLIENT_ID, pkceChallenge } from "../src/model/providers/chatgpt-auth.ts";
import { OPENAI_ISSUER } from "../src/model/providers/oidc.ts";
import { AUTHORIZE_URL, FakeOpenAi, ISSUED_CLIENT, MODELS, PORT, REVOKE_URL, TOKEN_URL, jwt, signIn, signingKey, tempStore } from "./provider-fakes.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup() {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const fake = new FakeOpenAi();
  const auth = new ChatGptAuth({ store: t.store, port: PORT, fetch: fake.fetch, now: () => fake.now });
  return { ...t, fake, auth };
}

async function begin(s: ReturnType<typeof setup>) {
  const { authorizeUrl } = await s.auth.start();
  const url = new URL(authorizeUrl);
  s.fake.nonce = url.searchParams.get("nonce")!;
  return { url, state: url.searchParams.get("state")! };
}

const callbackFor = (state: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ code: "auth-code", state, client_id: ISSUED_CLIENT, ...extra });

describe("0010 Sign in with ChatGPT", () => {
  it("step 1 and 2: a first sign-in registers with dynamic_agent_client, the agent name, a saved urn:uuid host id, PKCE S256, state, nonce and the resource", async () => {
    const s = setup();
    const { url } = await begin(s);
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    const p = url.searchParams;
    expect(p.get("client_id")).toBe(DYNAMIC_CLIENT_ID);
    expect(p.get("agent_name_hint")).toBe("Appointment change assistant");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe(`http://127.0.0.1:${PORT}/auth/callback`);
    expect(p.get("scope")).toBe("openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
    expect(p.get("resource")).toBe("https://api.openai.com/v1");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")!.length).toBeGreaterThanOrEqual(43);
    expect(p.get("nonce")!.length).toBeGreaterThanOrEqual(43);
    expect(p.has("id_token_hint")).toBe(false);
    expect(p.has("prompt")).toBe(false);
    const hostId = p.get("ext_agent_host_id")!;
    expect(hostId).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Saved before the first sign-in and reused on the next attempt.
    expect(s.store.read().chatgpt.hostId).toBe(hostId);
    const again = await begin(s);
    expect(again.url.searchParams.get("ext_agent_host_id")).toBe(hostId);
    expect(again.url.searchParams.get("state")).not.toBe(p.get("state"));
    expect(again.url.searchParams.get("nonce")).not.toBe(p.get("nonce"));
    expect(again.url.searchParams.get("code_challenge")).not.toBe(p.get("code_challenge"));
  });

  it("step 3 and 5: the callback exchanges the code with the verifier, the same redirect URI and the resource, and saves the issued client id and tokens", async () => {
    const s = setup();
    const { url, state } = await begin(s);
    const result = await s.auth.callback(callbackFor(state));
    expect(result).toEqual({ ok: true, planUsage: true });
    const [exchange] = s.fake.to(TOKEN_URL);
    const form = s.fake.form(exchange!);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe(ISSUED_CLIENT);
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"));
    expect(form.get("resource")).toBe("https://api.openai.com/v1");
    expect(pkceChallenge(form.get("code_verifier")!)).toBe(url.searchParams.get("code_challenge"));
    expect(form.has("client_secret")).toBe(false);
    const saved = s.store.read();
    expect(saved.chatgpt.clientId).toBe(ISSUED_CLIENT);
    expect(saved.chatgpt.account).toEqual({ issuer: OPENAI_ISSUER, subject: "user-sub-1", email: "dana@example.test", name: "Dana" });
    expect(saved.chatgpt.session).toMatchObject({ accessToken: s.fake.accessToken, refreshToken: s.fake.refreshToken, expiresAt: s.fake.now + 3_600_000 });
    expect(saved.chatgpt.session!.scopes).toContain("chatgpt.tokens.use.direct");
    // The ID token is checked and not kept.
    expect(JSON.stringify(saved)).not.toContain(s.fake.idTokens[0]!);
    // Signing in chose ChatGPT, as no provider was chosen yet.
    expect(saved.provider).toBe("chatgpt");
    expect(saved.version).toBe(1);
    // The models listed for display, from the connection's listing.
    expect(saved.chatgpt.models.map((m) => m.slug)).toEqual(["gpt-6.1-terra", "gpt-6.1-sol"]);
    expect(s.fake.to(MODELS)[0]!.headers.authorization).toBe(`Bearer ${s.fake.accessToken}`);
  });

  it("step 3: checks state first, uses it once, and drops it after ten minutes", async () => {
    const s = setup();
    const { state } = await begin(s);
    expect(await s.auth.callback(callbackFor("not-the-state"))).toEqual({ ok: false, code: "state_mismatch" });
    expect(await s.auth.callback(new URLSearchParams({ code: "auth-code" }))).toEqual({ ok: false, code: "state_mismatch" });
    expect((await s.auth.callback(callbackFor(state))).ok).toBe(true);
    expect(await s.auth.callback(callbackFor(state))).toEqual({ ok: false, code: "state_mismatch" });
    const late = await begin(s);
    s.fake.now += 11 * 60_000;
    expect(await s.auth.callback(callbackFor(late.state))).toEqual({ ok: false, code: "expired" });
    expect(s.fake.to(TOKEN_URL)).toHaveLength(1);
  });

  it("step 3: access_denied and other OAuth errors stop without a code exchange", async () => {
    const s = setup();
    const a = await begin(s);
    expect(await s.auth.callback(new URLSearchParams({ state: a.state, error: "access_denied" }))).toEqual({ ok: false, code: "access_denied" });
    const b = await begin(s);
    expect(await s.auth.callback(new URLSearchParams({ state: b.state, error: "server_error", code: "x" }))).toEqual({ ok: false, code: "authorization_failed" });
    expect(s.fake.to(TOKEN_URL)).toHaveLength(0);
    expect(s.store.read().chatgpt.session).toBeNull();
  });

  it("step 3: a new registration without an issued client id is incomplete, and dynamic_agent_client is never saved", async () => {
    const s = setup();
    const a = await begin(s);
    expect(await s.auth.callback(new URLSearchParams({ code: "c", state: a.state }))).toEqual({ ok: false, code: "registration_incomplete" });
    const b = await begin(s);
    expect(await s.auth.callback(new URLSearchParams({ code: "c", state: b.state, client_id: DYNAMIC_CLIENT_ID }))).toEqual({ ok: false, code: "registration_incomplete" });
    expect(s.store.read().chatgpt.clientId).toBeNull();
    expect(s.fake.to(TOKEN_URL)).toHaveLength(0);
  });

  it("step 2 and 3: a returning sign-in uses the saved client id without agent_name_hint, and refuses a different client id or account", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    await s.auth.signOut();
    const { url, state } = await begin(s);
    expect(url.searchParams.get("client_id")).toBe(ISSUED_CLIENT);
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    expect(url.searchParams.get("login_hint")).toBe("dana@example.test");
    expect(await s.auth.callback(callbackFor(state, { client_id: "oaiapp_other" }))).toEqual({ ok: false, code: "client_mismatch" });
    // The callback may leave out the client id on a returning sign-in.
    const b = await begin(s);
    s.fake.subject = "someone-else";
    expect(await s.auth.callback(new URLSearchParams({ code: "c", state: b.state }))).toEqual({ ok: false, code: "account_mismatch" });
    expect(s.store.read().chatgpt.session).toBeNull();
    const c = await begin(s);
    s.fake.subject = "user-sub-1";
    expect((await s.auth.callback(new URLSearchParams({ code: "c", state: c.state }))).ok).toBe(true);
  });

  it("step 4: refuses an ID token with a bad signature, issuer, audience, nonce, expiry or algorithm", async () => {
    const other = signingKey("key-1");
    const cases: Array<[string, (f: FakeOpenAi) => string]> = [
      ["signature", (f) => jwt({ iss: OPENAI_ISSUER, aud: ISSUED_CLIENT, sub: "s", nonce: f.nonce, iat: f.now / 1000, exp: f.now / 1000 + 60 }, other)],
      ["issuer", (f) => f.idToken({ iss: "https://evil.example" })],
      ["audience", (f) => f.idToken({ aud: "oaiapp_someone_else" })],
      ["nonce", (f) => f.idToken({ nonce: "replayed" })],
      ["expired", (f) => f.idToken({ exp: Math.floor(f.now / 1000) - 60 })],
      ["no subject", (f) => f.idToken({ sub: "" })],
      ["alg none", (f) => {
        const [, p] = f.idToken().split(".");
        return `${Buffer.from(JSON.stringify({ alg: "none", kid: "key-1" })).toString("base64url")}.${p}.AAAA`;
      }],
      ["HS256", (f) => {
        const [, p, sig] = f.idToken().split(".");
        return `${Buffer.from(JSON.stringify({ alg: "HS256", kid: "key-1" })).toString("base64url")}.${p}.${sig}`;
      }],
      ["unknown key", (f) => jwt({ iss: OPENAI_ISSUER, aud: ISSUED_CLIENT, sub: "s", nonce: f.nonce, iat: f.now / 1000, exp: f.now / 1000 + 60 }, signingKey("key-9"))],
    ];
    for (const [name, make] of cases) {
      const s = setup();
      const { state } = await begin(s);
      s.fake.token = () => s.fake.tokenResponse({ id_token: make(s.fake) });
      const result = await s.auth.callback(callbackFor(state));
      expect(result, name).toEqual({ ok: false, code: "identity_invalid" });
      expect(s.store.read().chatgpt.session, name).toBeNull();
    }
  });

  it("step 4: a discovery document from another issuer or with endpoints elsewhere is refused before any redirect", async () => {
    const s = setup();
    s.fake.discovery = () => ({ issuer: OPENAI_ISSUER, authorization_endpoint: "https://evil.example/authorize", token_endpoint: TOKEN_URL, jwks_uri: "x" });
    await expect(s.auth.start()).rejects.toMatchObject({ name: "IdentityError", kind: "unavailable" });
  });

  it("step 4: without chatgpt.tokens.use.direct the sign-in is kept, plan usage is off, and model calls are refused", async () => {
    const s = setup();
    s.fake.scope = "email offline_access openid profile";
    const { result } = await signIn(s.fake, s.store, s.auth);
    expect(result).toEqual({ ok: true, planUsage: false });
    expect(ChatGptAuth.view(s.store.read())).toMatchObject({ signedIn: true, planUsage: false });
    await expect(s.auth.accessToken()).rejects.toMatchObject({ kind: "plan_usage_off" });
    // No model listing without plan usage.
    expect(s.fake.to(MODELS)).toHaveLength(0);
    // Asking again names the full scope set and asks for consent.
    const { url } = await begin(s);
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
  });

  it("refreshes before expiry with the issued client id, the refresh token and the resource, and saves the rotated token set", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    expect(await s.auth.accessToken()).toBe(s.fake.accessToken);
    expect(s.fake.to(TOKEN_URL)).toHaveLength(1);
    const oldRefresh = s.fake.refreshToken;
    s.fake.now += 59 * 60_000;
    s.fake.accessToken = "access-rotated";
    s.fake.refreshToken = "refresh-rotated";
    s.fake.token = () => Response.json({ access_token: s.fake.accessToken, refresh_token: s.fake.refreshToken, expires_in: 3600, token_type: "Bearer" });
    expect(await s.auth.accessToken()).toBe("access-rotated");
    const form = s.fake.form(s.fake.to(TOKEN_URL)[1]!);
    expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", client_id: ISSUED_CLIENT, refresh_token: oldRefresh, resource: "https://api.openai.com/v1" });
    const session = s.store.read().chatgpt.session!;
    expect(session).toMatchObject({ accessToken: "access-rotated", refreshToken: "refresh-rotated", expiresAt: s.fake.now + 3_600_000 });
    // Scope left out of a refresh keeps the granted scopes.
    expect(session.scopes).toContain("chatgpt.tokens.use.direct");
    // A refresh does not change what the settings page sees.
    expect(s.store.read().version).toBe(1);
  });

  it("serializes refreshes: two calls that need one share it", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.now += 59 * 60_000;
    let n = 0;
    s.fake.token = async () => {
      n++;
      await new Promise((r) => setTimeout(r, 10));
      return Response.json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600 });
    };
    const [a, b] = await Promise.all([s.auth.accessToken(), s.auth.accessToken()]);
    expect([a, b]).toEqual(["access-1", "access-1"]);
    expect(n).toBe(1);
  });

  it("design item 4: a refused refresh signs out and keeps the registration, a network failure keeps the tokens", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.now += 59 * 60_000;
    s.fake.token = () => {
      throw new TypeError("fetch failed");
    };
    await expect(s.auth.accessToken()).rejects.toMatchObject({ kind: "unavailable" });
    expect(s.store.read().chatgpt.session).not.toBeNull();
    s.fake.token = () => Response.json({ error: "server_error" }, { status: 503 });
    await expect(s.auth.accessToken()).rejects.toMatchObject({ kind: "unavailable" });
    expect(s.store.read().chatgpt.session).not.toBeNull();
    for (const code of ["invalid_grant", "refresh_token_reused"]) {
      const t = setup();
      await signIn(t.fake, t.store, t.auth);
      t.fake.now += 59 * 60_000;
      t.fake.token = () => Response.json({ error: code }, { status: 400 });
      const err = await t.auth.accessToken().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChatGptAuthError);
      expect((err as ChatGptAuthError).kind).toBe("session_ended");
      const saved = t.store.read();
      expect(saved.chatgpt.session).toBeNull();
      expect(saved.chatgpt.clientId).toBe(ISSUED_CLIENT);
      expect(saved.chatgpt.hostId).toMatch(/^urn:uuid:/);
      // The provider stays ChatGPT: nothing switches to Meta.
      expect(saved.provider).toBe("chatgpt");
      expect(ChatGptAuth.view(saved).signedIn).toBe(false);
    }
  });

  it("a refresh whose ID token names another account signs out", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.now += 59 * 60_000;
    s.fake.subject = "someone-else";
    s.fake.token = () => Response.json({ access_token: "a2", refresh_token: "r2", expires_in: 3600, id_token: s.fake.idToken({ nonce: undefined }) });
    await expect(s.auth.accessToken()).rejects.toMatchObject({ kind: "session_ended" });
    expect(s.store.read().chatgpt.session).toBeNull();
  });

  it("sign-out revokes the refresh token at the discovered endpoint, then clears the tokens and keeps the client id and host id", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    const refresh = s.fake.refreshToken;
    expect(await s.auth.signOut()).toEqual({ revoked: true });
    expect(Object.fromEntries(s.fake.form(s.fake.to(REVOKE_URL)[0]!))).toEqual({ token: refresh, token_type_hint: "refresh_token", client_id: ISSUED_CLIENT });
    const saved = s.store.read();
    expect(saved.chatgpt.session).toBeNull();
    expect(saved.chatgpt.clientId).toBe(ISSUED_CLIENT);
    expect(JSON.stringify(saved)).not.toContain(refresh);
    await expect(s.auth.accessToken()).rejects.toMatchObject({ kind: "signed_out" });
  });

  it("sign-out retries a failed revocation once, then clears locally and says it was not confirmed", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.revoke = () => new Response("", { status: 502 });
    expect(await s.auth.signOut()).toEqual({ revoked: false });
    expect(s.fake.to(REVOKE_URL)).toHaveLength(2);
    expect(s.store.read().chatgpt.session).toBeNull();
  });
});
