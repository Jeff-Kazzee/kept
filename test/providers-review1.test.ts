// Sprint 10 review round 1: each finding as a deterministic test built from
// its failing case, against offline fakes.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntakeService } from "../src/intake/service.ts";
import { MetaResponsesClient, ModelCallError } from "../src/model/client.ts";
import { buildToolRequest } from "../src/model/responses.ts";
import { MODEL } from "../src/model/request.ts";
import { ChatGptAuth, ChatGptAuthError, DYNAMIC_CLIENT_ID, SESSION_LEASE } from "../src/model/providers/chatgpt-auth.ts";
import { ChatGptResponsesClient } from "../src/model/providers/chatgpt-client.ts";
import { chatGptModel, DEFAULT_CHATGPT_MODEL, modelOptions } from "../src/model/providers/models.ts";
import { JWKS_DEFAULT_TTL_MS, OPENAI_ISSUER, OpenAiIdentity } from "../src/model/providers/oidc.ts";
import { LEASE_MS, SecretsStore } from "../src/model/providers/secrets.ts";
import { DatabaseSync } from "node:sqlite";
import { fromPackage } from "../src/paths.ts";
import { EventStore } from "../src/store/event-log.ts";
import { fixtureMessage } from "./helpers.ts";
import { FakeOpenAi, ISSUED_CLIENT, JWKS_URL, PORT, RESPONSES, REVOKE_URL, TOKEN_URL, jwt, signIn, signingKey, tempStore } from "./provider-fakes.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

function setup() {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const fake = new FakeOpenAi();
  const auth = new ChatGptAuth({ store: t.store, port: PORT, fetch: fake.fetch, now: () => fake.now });
  return { ...t, fake, auth };
}

// A refresh grant that waits until `release` is called.
function heldRefresh(fake: FakeOpenAi) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  fake.token = async (req) => {
    if (fake.form(req).get("grant_type") === "refresh_token") {
      await gate;
      return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
    }
    return fake.tokenResponse();
  };
  return release;
}

const refreshRequests = (fake: FakeOpenAi) => fake.to(TOKEN_URL).filter((r) => fake.form(r).get("grant_type") === "refresh_token");

describe("review round 1, finding 1: sign-out and a refresh in flight", () => {
  it("sign-out waits for the refresh, then revokes the new refresh token, and the session stays cleared", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.now += 59 * 60_000;
    const release = heldRefresh(s.fake);
    const call = s.auth.accessToken();
    await vi.waitFor(() => expect(refreshRequests(s.fake)).toHaveLength(1));
    const out = s.auth.signOut();
    // Sign-out is held back while the refresh holds the lock.
    await new Promise((r) => setTimeout(r, 50));
    expect(s.fake.to(REVOKE_URL)).toHaveLength(0);
    release();
    expect(await call).toBe("access-2");
    expect(await out).toEqual({ revoked: true, refused: false });
    const revoked = s.fake.to(REVOKE_URL).map((r) => s.fake.form(r).get("token"));
    expect(revoked).toEqual(["refresh-2"]);
    expect(s.store.read().chatgpt.session).toBeNull();
    expect(JSON.stringify(s.store.read())).not.toContain("refresh-2");
  });

  it("a refresh whose session was cleared meanwhile stores nothing and revokes the refresh token it got", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.now += 59 * 60_000;
    const release = heldRefresh(s.fake);
    const call = s.auth.accessToken().catch((e: unknown) => e);
    await vi.waitFor(() => expect(refreshRequests(s.fake)).toHaveLength(1));
    // A writer that does not take the lock clears the session.
    s.store.update((x) => ({ ...x, chatgpt: { ...x.chatgpt, session: null } }), { bump: true });
    release();
    const err = await call;
    expect(err).toBeInstanceOf(ChatGptAuthError);
    expect((err as ChatGptAuthError).kind).toBe("signed_out");
    expect(s.store.read().chatgpt.session).toBeNull();
    expect(s.fake.to(REVOKE_URL).map((r) => s.fake.form(r).get("token"))).toEqual(["refresh-2"]);
  });

  it("a new sign-in replacing the session during a refresh is kept, and the refresh result is dropped", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.now += 59 * 60_000;
    const release = heldRefresh(s.fake);
    const call = s.auth.accessToken().catch((e: unknown) => e);
    await vi.waitFor(() => expect(refreshRequests(s.fake)).toHaveLength(1));
    s.store.update((x) => ({ ...x, chatgpt: { ...x.chatgpt, session: { ...x.chatgpt.session!, id: "another-session", accessToken: "access-new" } } }), { bump: true });
    release();
    expect(await call).toBeInstanceOf(ChatGptAuthError);
    expect(s.store.read().chatgpt.session).toMatchObject({ id: "another-session", accessToken: "access-new" });
  });
});

describe("review round 1, finding 2: the issued client id is saved only after it verifies", () => {
  const begin = async (s: ReturnType<typeof setup>) => {
    const url = new URL((await s.auth.start()).authorizeUrl);
    return { state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")! };
  };
  // The token endpoint answers with an ID token for the client id it was sent.
  const tokenForClient = (s: ReturnType<typeof setup>) => {
    s.fake.token = (req) => s.fake.tokenResponse({ id_token: s.fake.idToken({}, s.fake.form(req).get("client_id")!) });
  };

  it("a tampered client_id with a valid state saves nothing, and the next sign-in still registers", async () => {
    const s = setup();
    const a = await begin(s);
    s.fake.nonce = a.nonce;
    // OpenAI issues the ID token for the real registration, not the tampered id.
    const result = await s.auth.callback(new URLSearchParams({ code: "c", state: a.state, client_id: "oaiapp_tampered" }));
    expect(result).toEqual({ ok: false, code: "identity_invalid" });
    expect(s.store.read().chatgpt.clientId).toBeNull();
    s.fake.token = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    const b = await begin(s);
    expect(await s.auth.callback(new URLSearchParams({ code: "c", state: b.state, client_id: "oaiapp_tampered" }))).toEqual({ ok: false, code: "exchange_failed" });
    expect(s.store.read().chatgpt.clientId).toBeNull();
    const next = new URL((await s.auth.start()).authorizeUrl);
    expect(next.searchParams.get("client_id")).toBe(DYNAMIC_CLIENT_ID);
  });

  it("of two first registrations, the first to finish is kept and the other is refused", async () => {
    const s = setup();
    tokenForClient(s);
    const a = await begin(s);
    const b = await begin(s);
    s.fake.nonce = a.nonce;
    expect((await s.auth.callback(new URLSearchParams({ code: "c", state: a.state, client_id: "oaiapp_first" }))).ok).toBe(true);
    s.fake.nonce = b.nonce;
    expect(await s.auth.callback(new URLSearchParams({ code: "c", state: b.state, client_id: "oaiapp_second" }))).toEqual({ ok: false, code: "client_mismatch" });
    expect(s.store.read().chatgpt.clientId).toBe("oaiapp_first");
  });
});

describe("review round 1, finding 3: refreshes are serialized across processes", () => {
  it("two connections on one file, as the app and the eval, make one refresh and share it", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.now += 59 * 60_000;
    const other = new ChatGptAuth({ store: new SecretsStore(s.store.file), port: PORT, fetch: s.fake.fetch, now: () => s.fake.now });
    let n = 0;
    s.fake.token = async () => {
      n++;
      await new Promise((r) => setTimeout(r, 20));
      return Response.json({ access_token: `access-${n + 1}`, refresh_token: `refresh-${n + 1}`, expires_in: 3600 });
    };
    expect(await Promise.all([s.auth.accessToken(), other.accessToken()])).toEqual(["access-2", "access-2"]);
    expect(n).toBe(1);
  });

  it("a live lease another process holds makes a refresh wait and use that process's result, and an expired one is taken over", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.now += 59 * 60_000;
    // Another process holds the session lease, live for 30 seconds.
    const raw = new DatabaseSync(s.store.file);
    raw.prepare("INSERT INTO lease (name, holder, expires_at) VALUES (?, ?, ?)").run(SESSION_LEASE, "other-process", Date.now() + LEASE_MS);
    const call = s.auth.accessToken();
    await new Promise((r) => setTimeout(r, 100));
    expect(refreshRequests(s.fake)).toHaveLength(0);
    // It stores its refresh. This process reads it and makes none.
    s.store.update((x) => ({ ...x, chatgpt: { ...x.chatgpt, session: { ...x.chatgpt.session!, accessToken: "access-other", expiresAt: s.fake.now + 3_600_000 } } }), { bump: false });
    expect(await call).toBe("access-other");
    expect(refreshRequests(s.fake)).toHaveLength(0);

    // Its holder stopped: the lease is past expires_at, so it is taken over.
    s.fake.now += 59 * 60_000;
    raw.prepare("UPDATE lease SET expires_at = ? WHERE name = ?").run(Date.now() - 1, SESSION_LEASE);
    raw.close();
    s.fake.token = () => Response.json({ access_token: "access-3", refresh_token: "refresh-3", expires_in: 3600 });
    expect(await s.auth.accessToken()).toBe("access-3");
    expect(refreshRequests(s.fake)).toHaveLength(1);
  });

  it("a refresh whose lease was taken over meanwhile stores nothing and revokes its new refresh token", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.now += 59 * 60_000;
    const release = heldRefresh(s.fake);
    const call = s.auth.accessToken().catch((e: unknown) => e);
    await vi.waitFor(() => expect(refreshRequests(s.fake)).toHaveLength(1));
    // The lease is lost, as when this process stalled past expires_at.
    const raw = new DatabaseSync(s.store.file);
    raw.prepare("UPDATE lease SET holder = ? WHERE name = ?").run("other-process", SESSION_LEASE);
    raw.close();
    const before = s.store.read().chatgpt.session;
    release();
    expect(await call).toBeInstanceOf(ChatGptAuthError);
    expect(s.store.read().chatgpt.session).toEqual(before);
    expect(s.fake.to(REVOKE_URL).map((r) => s.fake.form(r).get("token"))).toEqual(["refresh-2"]);
  });

  it("a real second process holding the lease runs before this one, never at the same time", async () => {
    const s = setup();
    s.store.read();
    const script = [
      `import { SecretsStore } from ${JSON.stringify(fromPackage("src/model/providers/secrets.ts"))};`,
      `const store = new SecretsStore(${JSON.stringify(s.store.file)});`,
      `await store.withLease("chatgpt_session", async () => { console.log("held " + Date.now()); await new Promise((r) => setTimeout(r, 400)); console.log("released " + Date.now()); });`,
      `store.close();`,
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    // Made now: the child may exit before this test waits for it.
    const closed = new Promise((r) => child.on("close", r));
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    await vi.waitFor(() => expect(out).toContain("held"), { timeout: 10_000 });
    let startedAt = 0;
    await s.store.withLease("chatgpt_session", async () => void (startedAt = Date.now()));
    await closed;
    const released = Number(/released (\d+)/.exec(out)![1]);
    expect(startedAt).toBeGreaterThanOrEqual(released);
  }, 20_000);
});

describe("review round 1, finding 4: the model sent is never a contributor model", () => {
  it("the listing's only usable models win, and a contributor slug is never chosen", () => {
    const { store } = setup();
    const base = store.read();
    const only = { ...base, chatgpt: { ...base.chatgpt, models: [{ slug: "gpt-6.1-contributor", displayName: "C" }] } };
    expect(chatGptModel(only)).toBe(DEFAULT_CHATGPT_MODEL);
    const mixed = { ...base, chatgpt: { ...base.chatgpt, models: [{ slug: "gpt-6.1-contributor", displayName: "C" }, { slug: "gpt-6.2-luna", displayName: "Luna" }] } };
    expect(chatGptModel(mixed)).toBe("gpt-6.2-luna");
    expect(modelOptions(mixed, "chatgpt").map((m) => m.id)).toEqual(["gpt-6.2-luna"]);
    const chosen = { ...base, chatgpt: { ...base.chatgpt, model: "gpt-6.1-contributor" } };
    expect(chatGptModel(chosen)).toBe(DEFAULT_CHATGPT_MODEL);
  });

  it("the client checks the model it sends, not the one it was given", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    const client = new ChatGptResponsesClient({ auth: s.auth, model: () => "gpt-6.1-contributor", fetch: s.fake.fetch });
    const body = buildToolRequest({ model: MODEL, effort: "low", instructions: "x", input: [{ role: "user", content: "hi" }], tools: [] });
    await expect(client.respond({ key: "k", effort: "low", body })).rejects.toThrow(/Contributor models are never used/);
    expect(s.fake.to(RESPONSES)).toHaveLength(0);
  });
});

describe("review round 1, finding 6: a refresh that drops plan usage", () => {
  it("refuses the call and shows plan usage off", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    const version = s.store.read().version;
    s.fake.now += 59 * 60_000;
    s.fake.token = () => Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "openid email profile offline_access" });
    await expect(s.auth.accessToken()).rejects.toMatchObject({ kind: "plan_usage_off" });
    expect(ChatGptAuth.view(s.store.read())).toMatchObject({ signedIn: true, planUsage: false });
    expect(s.store.read().version).toBe(version + 1);
    await expect(s.auth.accessToken()).rejects.toMatchObject({ kind: "plan_usage_off" });
  });
});

describe("review round 1, finding 7: Meta errors never carry body text", () => {
  const echoed = "LLM|EchoedKey0123456789abcdefABCDEF";

  it("an error body that echoes a key reaches no event, log line, error or answer", async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    const logs: string[] = [];
    for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { message: `Invalid key ${echoed}`, type: "authentication_error", code: echoed, param: echoed } }, { status: 401 }),
    );
    const db = path.join(t.dir, "app.sqlite");
    const store = new EventStore(db);
    const intake = new IntakeService(store, new MetaResponsesClient({ apiKey: "real-key-not-echoed" }), { now: () => "2026-11-06T10:00:00.000Z" });
    const imported = intake.importMessage(fixtureMessage("m2"));
    const result = await intake.extract("m2", { effort: "minimal", expectedVersion: imported.version });
    expect(result.result.attempts.every((a) => a.outcome !== "valid")).toBe(true);
    expect(result.result.attempts[0]!.detail).toBe("Model call returned HTTP 401 (type authentication_error).");
    store.close();
    const files = readdirSync(t.dir).filter((f) => f.startsWith("app.sqlite")).map((f) => readFileSync(path.join(t.dir, f)).toString("latin1"));
    for (const text of [JSON.stringify(result), ...files, ...logs]) expect(text).not.toContain("EchoedKey0123456789");

    const err = (await new MetaResponsesClient({ apiKey: "k" })
      .respond({ key: "c", effort: "low", body: buildToolRequest({ model: MODEL, effort: "low", instructions: "x", input: [{ role: "user", content: "hi" }], tools: [] }) })
      .catch((e: unknown) => e)) as ModelCallError;
    expect(err.message).toBe("Model call returned HTTP 401 (type authentication_error).");
    expect([err.errorCode, err.errorParam]).toEqual([null, null]);
  });
});

describe("review round 1, finding 8: the signing keys expire and reload once on a bad signature", () => {
  const verifier = (fake: FakeOpenAi) => new OpenAiIdentity({ fetch: fake.fetch, now: () => fake.now });
  const token = (fake: FakeOpenAi, key = fake.key) => {
    const t = Math.floor(fake.now / 1000);
    return jwt({ iss: OPENAI_ISSUER, aud: ISSUED_CLIENT, sub: "s", nonce: "n", iat: t, exp: t + 3600 }, key);
  };
  const jwksLoads = (fake: FakeOpenAi) => fake.to(JWKS_URL).length;

  it("keeps the keys for the Cache-Control max-age, then reloads", async () => {
    const fake = new FakeOpenAi();
    fake.jwksCacheControl = "public, max-age=120";
    const id = verifier(fake);
    await id.verifyIdToken(token(fake), { clientId: ISSUED_CLIENT, nonce: "n" });
    fake.now += 100_000;
    await id.verifyIdToken(token(fake), { clientId: ISSUED_CLIENT, nonce: "n" });
    expect(jwksLoads(fake)).toBe(1);
    fake.now += 30_000;
    await id.verifyIdToken(token(fake), { clientId: ISSUED_CLIENT, nonce: "n" });
    expect(jwksLoads(fake)).toBe(2);
  });

  it("without Cache-Control the keys last the default lifetime", async () => {
    const fake = new FakeOpenAi();
    const id = verifier(fake);
    await id.verifyIdToken(token(fake), { clientId: ISSUED_CLIENT, nonce: "n" });
    fake.now += JWKS_DEFAULT_TTL_MS - 1000;
    await id.verifyIdToken(token(fake), { clientId: ISSUED_CLIENT, nonce: "n" });
    expect(jwksLoads(fake)).toBe(1);
    fake.now += 2000;
    await id.verifyIdToken(token(fake), { clientId: ISSUED_CLIENT, nonce: "n" });
    expect(jwksLoads(fake)).toBe(2);
  });

  it("a key replaced under the same kid reloads once, and not again within a minute", async () => {
    const fake = new FakeOpenAi();
    const id = verifier(fake);
    await id.verifyIdToken(token(fake), { clientId: ISSUED_CLIENT, nonce: "n" });
    fake.now += 61_000;
    fake.key = signingKey("key-1");
    await expect(id.verifyIdToken(token(fake), { clientId: ISSUED_CLIENT, nonce: "n" })).resolves.toMatchObject({ subject: "s" });
    expect(jwksLoads(fake)).toBe(2);
    const forged = signingKey("key-1");
    await expect(id.verifyIdToken(token(fake, forged), { clientId: ISSUED_CLIENT, nonce: "n" })).rejects.toMatchObject({ reason: "signature" });
    expect(jwksLoads(fake)).toBe(2);
  });
});
