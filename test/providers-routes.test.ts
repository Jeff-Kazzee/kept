// 0010: the settings and sign-in routes (server/auth.ts), with no sockets,
// against offline fakes. No route answer holds a key or a token.
import { afterEach, describe, expect, it } from "vitest";
import { ChatGptAuth } from "../src/model/providers/chatgpt-auth.ts";
import { createAuth, KEY_FORMAT_TEXT, SIGNED_OUT_UNCONFIRMED_TEXT } from "../server/auth.ts";
import { FakeOpenAi, ISSUED_CLIENT, PORT, REVOKE_URL, fakeSecret, tempStore } from "./provider-fakes.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(serverMetaKey: string | null = null) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const fake = new FakeOpenAi();
  const auth = new ChatGptAuth({ store: t.store, port: PORT, fetch: fake.fetch, now: () => fake.now });
  const routes = createAuth({ store: t.store, auth, serverMetaKey });
  const call = async (method: string, path: string, body?: unknown) => (await routes.handle({ method, path, body }))!;
  return { ...t, fake, auth, routes, call };
}

async function signInThroughRoutes(s: ReturnType<typeof setup>) {
  const start = await s.call("POST", "/api/auth/chatgpt/start", {});
  expect(start.status).toBe(200);
  const url = new URL((start.body as { authorizeUrl: string }).authorizeUrl);
  s.fake.nonce = url.searchParams.get("nonce")!;
  return s.routes.callback("GET", new URLSearchParams({ code: "c", state: url.searchParams.get("state")!, client_id: ISSUED_CLIENT }));
}

describe("0010 settings and sign-in routes", () => {
  it("GET /api/settings has the contract's shape, and Meta with the server key is the default", async () => {
    const s = setup("server-meta-key-0123");
    const res = await s.call("GET", "/api/settings");
    expect(res).toEqual({
      status: 200,
      body: {
        settingsVersion: 0,
        timezone: "America/Denver",
        timezoneSource: "default",
        provider: "meta",
        meta: { keySet: true, source: "server" },
        chatgpt: { signedIn: false, name: null, email: null, planUsage: false },
        model: "muse-spark-1.3",
        models: [
          { id: "muse-spark-1.3", label: "Muse Spark 1.3", costHint: "lower" },
          { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", costHint: "higher" },
        ],
        modelNotice: null,
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("server-meta-key-0123");
    const none = setup();
    expect((await none.call("GET", "/api/settings")).body).toMatchObject({ provider: null, meta: { keySet: false, source: null }, model: "", models: [] });
  });

  it("POST and DELETE /api/auth/meta-key store and remove the key without ever answering with it", async () => {
    const s = setup();
    const key = fakeSecret("metakey");
    const saved = await s.call("POST", "/api/auth/meta-key", { key: `  ${key}\n` });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ provider: "meta", meta: { keySet: true, source: "you" }, settingsVersion: 1 });
    expect(JSON.stringify(saved.body)).not.toContain(key);
    expect(s.store.read().meta).toEqual({ key });
    for (const bad of [{ key: "short" }, { key: "has a space in it" }, { key: 5 }, { key, extra: 1 }, null]) {
      const res = await s.call("POST", "/api/auth/meta-key", bad);
      expect(res).toEqual({ status: 400, body: { error: "invalid_key", message: KEY_FORMAT_TEXT } });
    }
    const removed = await s.call("DELETE", "/api/auth/meta-key");
    expect(removed.body).toMatchObject({ meta: { keySet: false, source: null }, settingsVersion: 2 });
    // The provider stays Meta: removing the key does not switch it.
    expect(removed.body).toMatchObject({ provider: "meta" });
    expect(s.store.read().meta).toBeNull();
  });

  it("PUT /api/settings/provider checks the version and that the provider is ready", async () => {
    const s = setup("server-meta-key-0123");
    const stale = await s.call("PUT", "/api/settings/provider", { provider: "meta", expectedVersion: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "stale_edit", currentVersion: 0 });
    const notReady = await s.call("PUT", "/api/settings/provider", { provider: "chatgpt", expectedVersion: 0 });
    expect(notReady).toMatchObject({ status: 422, body: { error: "provider_not_ready" } });
    expect((await s.call("PUT", "/api/settings/provider", { provider: "other", expectedVersion: 0 })).status).toBe(400);
    expect(await signInThroughRoutes(s)).toEqual({ status: 302, location: "/?signedIn=chatgpt" });
    // Meta was in use through the server key but not chosen, so signing in
    // chose ChatGPT.
    const after = (await s.call("GET", "/api/settings")).body as { settingsVersion: number; provider: string; chatgpt: object; models: unknown[] };
    expect(after).toMatchObject({ provider: "chatgpt", chatgpt: { signedIn: true, name: "Dana", email: "dana@example.test", planUsage: true } });
    expect(after.models).toEqual([
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", costHint: null },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", costHint: null },
    ]);
    const back = await s.call("PUT", "/api/settings/provider", { provider: "meta", expectedVersion: after.settingsVersion });
    expect(back.body).toMatchObject({ provider: "meta", settingsVersion: after.settingsVersion + 1, model: "muse-spark-1.3" });
  });

  it("PUT /api/settings/model takes only a model from the current provider's list", async () => {
    const s = setup("server-meta-key-0123");
    const ok = await s.call("PUT", "/api/settings/model", { model: "muse-wonder-1.0", expectedVersion: 0 });
    expect(ok.body).toMatchObject({ model: "muse-wonder-1.0", settingsVersion: 1 });
    for (const model of ["muse-spark-1.3-contributor", "gpt-6.1-sol", "anything"]) {
      expect((await s.call("PUT", "/api/settings/model", { model, expectedVersion: 1 })).body).toMatchObject({ error: "unknown_model" });
    }
    expect((await s.call("PUT", "/api/settings/model", { model: "muse-spark-1.3", expectedVersion: 0 })).status).toBe(409);
    expect(s.store.read().metaModel).toBe("muse-wonder-1.0");
    const none = setup();
    expect((await none.call("PUT", "/api/settings/model", { model: "muse-spark-1.3", expectedVersion: 0 })).body).toMatchObject({ error: "provider_not_ready" });
  });

  it("a model capability problem shows in settings until another model is picked", async () => {
    const s = setup("server-meta-key-0123");
    s.store.update((x) => ({ ...x, modelProblem: { provider: "meta", model: "muse-spark-1.3", capability: "structured_output" } }), { bump: true });
    expect((await s.call("GET", "/api/settings")).body).toMatchObject({
      modelNotice: "The model Muse Spark 1.3 does not support structured output, which this app needs. Choose another model in settings. Nothing in your case changed.",
    });
    const picked = await s.call("PUT", "/api/settings/model", { model: "muse-wonder-1.0", expectedVersion: 1 });
    expect(picked.body).toMatchObject({ modelNotice: null });
  });

  it("the callback redirects to the page with a code, never a token, and refuses anything but GET", async () => {
    const s = setup();
    expect(await s.routes.callback("GET", new URLSearchParams({ state: "nope", code: "c" }))).toEqual({ status: 302, location: "/?signInError=state_mismatch" });
    expect(await s.routes.callback("POST", new URLSearchParams())).toEqual({ status: 405, location: null });
    const start = await s.call("POST", "/api/auth/chatgpt/start", {});
    const state = new URL((start.body as { authorizeUrl: string }).authorizeUrl).searchParams.get("state")!;
    expect(await s.routes.callback("GET", new URLSearchParams({ state, error: "access_denied" }))).toEqual({ status: 302, location: "/?signInError=access_denied" });
  });

  it("start answers 503 with a plain message when OpenAI's sign-in cannot be reached", async () => {
    const s = setup();
    s.fake.discovery = () => {
      throw new Error("down");
    };
    expect(await s.call("POST", "/api/auth/chatgpt/start", {})).toMatchObject({ status: 503, body: { error: "sign_in_unavailable" } });
  });

  it("sign-out revokes and clears, and says when the revocation was not confirmed", async () => {
    const s = setup();
    await signInThroughRoutes(s);
    const out = await s.call("POST", "/api/auth/chatgpt/signout", {});
    expect(out.body).toMatchObject({ chatgpt: { signedIn: false }, notice: null, provider: "chatgpt" });
    expect(s.fake.to(REVOKE_URL)).toHaveLength(1);
    await signInThroughRoutes(s);
    s.fake.revoke = () => new Response("", { status: 500 });
    expect((await s.call("POST", "/api/auth/chatgpt/signout", {})).body).toMatchObject({ notice: SIGNED_OUT_UNCONFIRMED_TEXT });
  });

  it("no route answer, start URL included, holds a token, the verifier or an ID token", async () => {
    const s = setup();
    const answers: unknown[] = [];
    const start = await s.call("POST", "/api/auth/chatgpt/start", {});
    answers.push(start.body);
    const url = new URL((start.body as { authorizeUrl: string }).authorizeUrl);
    s.fake.nonce = url.searchParams.get("nonce")!;
    answers.push(await s.routes.callback("GET", new URLSearchParams({ code: "c", state: url.searchParams.get("state")!, client_id: ISSUED_CLIENT })));
    answers.push((await s.call("GET", "/api/settings")).body);
    const verifier = new URLSearchParams(s.fake.requests.find((r) => r.body.includes("code_verifier"))!.body).get("code_verifier")!;
    const text = JSON.stringify(answers);
    for (const secret of [s.fake.accessToken, s.fake.refreshToken, verifier, ...s.fake.idTokens]) expect(text).not.toContain(secret);
  });

  it("unknown methods get 405 and other paths are left to the API", async () => {
    const s = setup();
    expect(await s.call("POST", "/api/settings", {})).toEqual({ status: 405, body: { error: "method_not_allowed" } });
    expect(await s.routes.handle({ method: "GET", path: "/api/state", body: undefined })).toBeNull();
  });
});
