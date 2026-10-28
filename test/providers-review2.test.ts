// Sprint 10 review round 2: findings 7, 9 and 10, each from its failing
// case, against offline fakes. Findings 1 to 6 and 8 are in
// providers-store, providers-review1 and scan-secrets.
import { afterEach, describe, expect, it } from "vitest";
import { ModelCallError, apiError } from "../src/model/client.ts";
import { MODEL, buildJsonRequest } from "../src/model/request.ts";
import { ChatGptAuth } from "../src/model/providers/chatgpt-auth.ts";
import { createProviderClient } from "../src/model/providers/factory.ts";
import { SETTINGS_BUSY_TEXT as CALL_BUSY_TEXT } from "../src/model/providers/messages.ts";
import { capabilityProblem } from "../src/model/providers/models.ts";
import { OPENAI_ISSUER, OpenAiIdentity } from "../src/model/providers/oidc.ts";
import { SecretsBusyError, SecretsStore, type StoredSettings, type Transaction } from "../src/model/providers/secrets.ts";
import { SETTINGS_BUSY, createAuth } from "../server/auth.ts";
import { FakeOpenAi, ISSUED_CLIENT, JWKS_URL, PORT, RESPONSES, jwt, signIn, tempStore } from "./provider-fakes.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const jsonCall = () => ({
  key: "m",
  attempt: 1,
  effort: "low" as const,
  body: buildJsonRequest({ model: MODEL, effort: "low", instructions: "x", input: "y", schemaName: "s", schema: { type: "object" } }),
});

describe("review round 2, finding 7: one key load at a time", () => {
  it("calls that need the keys while a load runs share it", async () => {
    const fake = new FakeOpenAi();
    const id = new OpenAiIdentity({ fetch: fake.fetch, now: () => fake.now });
    const t = Math.floor(fake.now / 1000);
    const token = jwt({ iss: OPENAI_ISSUER, aud: ISSUED_CLIENT, sub: "s", nonce: "n", iat: t, exp: t + 3600 }, fake.key);
    const results = await Promise.all([1, 2, 3, 4].map(() => id.verifyIdToken(token, { clientId: ISSUED_CLIENT, nonce: "n" })));
    expect(results.map((r) => r.subject)).toEqual(["s", "s", "s", "s"]);
    expect(fake.to(JWKS_URL)).toHaveLength(1);
  });
});

describe("review round 2, finding 9: capability codes in any case", () => {
  it("known codes and params are kept in lower case, and unknown mixed-case text is still dropped", () => {
    expect(apiError({ error: { code: "Unsupported_Parameter", param: "Tools[0].Name", type: "invalid_request_error" } })).toEqual({
      type: "invalid_request_error",
      code: "unsupported_parameter",
      param: "tools",
    });
    expect(apiError({ error: { code: "SUBSCRIPTION_SHARING_UNSUPPORTED_CAPABILITY", param: "Text.Format" } })).toMatchObject({
      code: "subscription_sharing_unsupported_capability",
      param: "text.format",
    });
    expect(apiError({ error: { code: "LLMKey0123456789AbCd", param: "SomeKeyLike0123" } })).toMatchObject({ code: null, param: null });
    const err = new ModelCallError("x", 400, 0, apiError({ error: { code: "Unsupported_Parameter", param: "Stream" } }));
    expect(capabilityProblem(err, { tools: false, json: true })).toBe("streaming");
  });

  it("an upper-case capability error from ChatGPT is named in settings", async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    const fake = new FakeOpenAi();
    const auth = new ChatGptAuth({ store: t.store, port: PORT, fetch: fake.fetch, now: () => fake.now });
    await signIn(fake, t.store, auth);
    fake.responses = () => Response.json({ error: { code: "SUBSCRIPTION_SHARING_UNSUPPORTED_CAPABILITY", param: "Text.Format" } }, { status: 400 });
    const client = createProviderClient({ store: t.store, auth, serverMetaKey: null, fetch: fake.fetch });
    const err = (await client.call(jsonCall()).catch((e: unknown) => e)) as ModelCallError;
    expect(err.userText).toMatch(/does not support structured output/);
    expect(t.store.read().modelProblem).toEqual({ provider: "chatgpt", model: "gpt-6.1-sol", capability: "structured_output" });
    expect(fake.to(RESPONSES)).toHaveLength(1);
  });
});

// A store that reports busy, as when another process holds the database
// past the busy timeout or the lease past the wait.
class BusyStore extends SecretsStore {
  busy = true;
  override read(): StoredSettings {
    if (this.busy) throw new SecretsBusyError();
    return super.read();
  }
  override update(change: (current: StoredSettings, tx: Transaction) => StoredSettings | null, options: { bump: boolean }): StoredSettings {
    if (this.busy) throw new SecretsBusyError();
    return super.update(change, options);
  }
  override withLease<T>(name: string, fn: Parameters<SecretsStore["withLease"]>[1], options?: Parameters<SecretsStore["withLease"]>[2]): Promise<T> {
    if (this.busy) return Promise.reject(new SecretsBusyError());
    return super.withLease(name, fn, options) as Promise<T>;
  }
}

describe("review round 2, finding 10: a busy settings database is a retryable 503", () => {
  function setup() {
    const t = tempStore();
    const store = new BusyStore(t.store.file);
    cleanups.push(() => {
      store.close();
      t.cleanup();
    });
    const fake = new FakeOpenAi();
    const auth = new ChatGptAuth({ store, port: PORT, fetch: fake.fetch, now: () => fake.now });
    const routes = createAuth({ store, auth, serverMetaKey: "server-meta-key-0123" });
    return { store, fake, auth, routes };
  }

  it("every settings and sign-in route answers 503 settings_busy and writes nothing", async () => {
    const s = setup();
    const calls: Array<[string, string, unknown]> = [
      ["GET", "/api/settings", undefined],
      ["PUT", "/api/settings/provider", { provider: "meta", expectedVersion: 0 }],
      ["PUT", "/api/settings/model", { model: "muse-wonder-1.0", expectedVersion: 0 }],
      ["POST", "/api/auth/meta-key", { key: "key-12345678", expectedVersion: 0 }],
      ["DELETE", "/api/auth/meta-key", { expectedVersion: 0 }],
      ["POST", "/api/auth/chatgpt/start", {}],
      ["POST", "/api/auth/chatgpt/signout", { expectedVersion: 0 }],
    ];
    for (const [method, path, body] of calls) {
      const res = await s.routes.handle({ method, path, body });
      expect(res, `${method} ${path}`).toEqual(SETTINGS_BUSY);
    }
    expect(SETTINGS_BUSY.body).toMatchObject({ retryable: true, message: "The app's settings are busy in another window or process. Try again in a moment. Nothing was changed." });
    s.store.busy = false;
    expect(s.store.read().version).toBe(0);
  });

  it("the callback redirects with settings_busy when the sign-in cannot be saved", async () => {
    const s = setup();
    s.store.busy = false;
    const url = new URL((await s.auth.start()).authorizeUrl);
    s.fake.nonce = url.searchParams.get("nonce")!;
    s.store.busy = true;
    const res = await s.routes.callback("GET", new URLSearchParams({ code: "c", state: url.searchParams.get("state")!, client_id: ISSUED_CLIENT }));
    expect(res).toEqual({ status: 302, location: "/?signInError=settings_busy" });
  });

  it("a model call fails with a fixed try-again sentence", async () => {
    const s = setup();
    const client = createProviderClient({ store: s.store, auth: s.auth, serverMetaKey: "server-meta-key-0123", fetch: s.fake.fetch });
    const err = (await client.call(jsonCall()).catch((e: unknown) => e)) as ModelCallError;
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err.userText).toBe(CALL_BUSY_TEXT);
  });
});
