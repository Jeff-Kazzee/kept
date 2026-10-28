// 0010, design items 1, 4 and 5 and the model choice: the ChatGPT
// Responses client and the provider factory, against offline fakes. The
// same requests the app builds for Meta go through both providers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL, buildJsonRequest } from "../src/model/request.ts";
import { buildToolRequest } from "../src/model/responses.ts";
import { ModelCallError } from "../src/model/client.ts";
import { ChatGptResponsesClient, TOOL_NAMESPACE, chatGptBody } from "../src/model/providers/chatgpt-client.ts";
import { ChatGptAuth } from "../src/model/providers/chatgpt-auth.ts";
import { createProviderClient } from "../src/model/providers/factory.ts";
import {
  CHATGPT_SESSION_ENDED_TEXT,
  CHATGPT_SIGNED_OUT_TEXT,
  META_KEY_MISSING_TEXT,
  NO_PROVIDER_TEXT,
  PLAN_USAGE_OFF_TEXT,
  USAGE_LIMIT_TEXT,
} from "../src/model/providers/messages.ts";
import { DEFAULT_META_MODEL, chatGptModel, modelOptions } from "../src/model/providers/models.ts";
import { FakeOpenAi, META_URL, PORT, RESPONSES, TOKEN_URL, completed, fakeSecret, message, signIn, sse, tempStore } from "./provider-fakes.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(serverMetaKey: string | null = null) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const fake = new FakeOpenAi();
  // The Meta client calls the global fetch.
  vi.stubGlobal("fetch", fake.fetch);
  const auth = new ChatGptAuth({ store: t.store, port: PORT, fetch: fake.fetch, now: () => fake.now });
  const client = createProviderClient({ store: t.store, auth, serverMetaKey, fetch: fake.fetch });
  return { ...t, fake, auth, client };
}

const jsonCall = () => ({
  key: "msg-1",
  attempt: 1,
  effort: "minimal" as const,
  body: buildJsonRequest({ model: MODEL, effort: "minimal", instructions: "Extract.", input: "{\"text\":\"hi\"}", schemaName: "s", schema: { type: "object" } }),
});

const toolCall = () => ({
  key: "chat-1-1",
  effort: "low" as const,
  body: buildToolRequest({
    model: MODEL,
    effort: "low",
    instructions: "Help.",
    input: [{ role: "user" as const, content: "What is next?" }],
    tools: [{ type: "function" as const, name: "read_case", description: "Reads the case.", parameters: { type: "object" }, strict: false as const }],
  }),
});

const bodyOf = (fake: FakeOpenAi, url: string, i = 0) => JSON.parse(fake.to(url)[i]!.body) as Record<string, unknown>;

describe("0010 ChatGPT Responses client", () => {
  it("maps a request: store false, stream true, the connection's model, input as an array, tools in a namespace, effort minimal as low", () => {
    const json = chatGptBody(jsonCall().body as never, "gpt-6.1-sol");
    expect(json).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true, input: [{ role: "user", content: "{\"text\":\"hi\"}" }], reasoning: { effort: "low" } });
    expect(json.text).toEqual(jsonCall().body.text);
    const tools = chatGptBody(toolCall().body as never, "gpt-6.1-sol");
    expect(tools.tools).toEqual([{ type: "namespace", name: TOOL_NAMESPACE, description: expect.any(String), tools: toolCall().body.tools }]);
    expect(tools.input).toEqual(toolCall().body.input);
    expect(chatGptBody({ ...toolCall().body, temperature: 1, metadata: {}, previous_response_id: "r" } as never, "m")).not.toHaveProperty("temperature");
  });

  it("a tool turn reads the stream to response.completed, and a namespaced function call comes back as it came", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    const call = { type: "function_call", namespace: TOOL_NAMESPACE, name: "read_case", call_id: "call_1", arguments: "{}" };
    s.fake.responses = () =>
      new Response(
        sse([
          { event: "response.created", data: {} },
          { event: "response.output_text.delta", data: { delta: "x" } },
          { event: "response.completed", data: { response: { output: [{ type: "reasoning", encrypted_content: "e" }, call], usage: { input_tokens: 7, output_tokens: 3 } } } },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    const reply = await s.client.respond(toolCall());
    expect(reply.output).toEqual([{ type: "reasoning", encrypted_content: "e" }, call]);
    expect(reply.usage).toEqual({ input: 7, cachedInput: 0, output: 3, reasoning: 0 });
    const req = s.fake.to(RESPONSES)[0]!;
    expect(req.headers.authorization).toBe(`Bearer ${s.fake.accessToken}`);
    expect(req.headers.accept).toBe("text/event-stream");
    expect(bodyOf(s.fake, RESPONSES)).toMatchObject({ store: false, stream: true, model: "gpt-6.1-sol" });
    expect(s.client.label).toBe("chatgpt-responses");
  });

  it("a JSON call (extraction and the other structured calls) returns the completed output text", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.responses = () => new Response(completed([message("{\"claims\":[]}")]), { headers: { "content-type": "text/event-stream" } });
    const reply = await s.client.call(jsonCall());
    expect(reply.outputText).toBe("{\"claims\":[]}");
  });

  it("design item 4: a 401 refreshes once and tries once more", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    const first = s.fake.accessToken;
    let n = 0;
    s.fake.responses = (req) => {
      n++;
      if (req.headers.authorization === `Bearer ${first}`) return Response.json({ detail: "expired" }, { status: 401 });
      return new Response(completed([message("ok")]), { headers: { "content-type": "text/event-stream" } });
    };
    s.fake.token = () => Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
    expect((await s.client.call(jsonCall())).outputText).toBe("ok");
    expect(n).toBe(2);
    expect(s.fake.to(TOKEN_URL)).toHaveLength(2);
    // A second 401 is not retried again.
    s.fake.responses = () => Response.json({ detail: "no" }, { status: 401 });
    await expect(s.client.call(jsonCall())).rejects.toBeInstanceOf(ModelCallError);
    expect(s.fake.to(RESPONSES)).toHaveLength(4);
  });

  it("design item 4: a refused refresh signs out and the call fails with the sign-in-again sentence, never going to Meta", async () => {
    const s = setup("server-meta-key-0123");
    await signIn(s.fake, s.store, s.auth);
    s.fake.now += 59 * 60_000;
    s.fake.token = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    const err = (await s.client.respond(toolCall()).catch((e: unknown) => e)) as ModelCallError;
    expect(err.userText).toBe(CHATGPT_SESSION_ENDED_TEXT);
    expect(err.message).toBe(CHATGPT_SESSION_ENDED_TEXT);
    const next = (await s.client.respond(toolCall()).catch((e: unknown) => e)) as ModelCallError;
    expect(next.userText).toBe(CHATGPT_SIGNED_OUT_TEXT);
    expect(s.fake.to(META_URL)).toHaveLength(0);
    expect(s.store.read().provider).toBe("chatgpt");
  });

  it("documented usage and stream errors become fixed sentences without response text", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.responses = () => Response.json({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "secret detail" } }, { status: 429 });
    const limit = (await s.client.call(jsonCall()).catch((e: unknown) => e)) as ModelCallError;
    expect(limit.userText).toBe(USAGE_LIMIT_TEXT);
    expect(limit.errorCode).toBe("subscription_sharing_usage_limit_exceeded");
    expect(limit.message).not.toContain("secret detail");
    s.fake.responses = () =>
      new Response(sse([{ event: "response.failed", data: { response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } } }]), {
        headers: { "content-type": "text/event-stream" },
      });
    expect(((await s.client.call(jsonCall()).catch((e: unknown) => e)) as ModelCallError).userText).toBe(USAGE_LIMIT_TEXT);
    s.fake.responses = () => new Response(sse([{ event: "response.created", data: {} }]), { headers: { "content-type": "text/event-stream" } });
    const ended = (await s.client.call(jsonCall()).catch((e: unknown) => e)) as ModelCallError;
    expect(ended.errorType).toBe("stream_ended");
  });

  it("design item 3: model calls are gated on the plan-usage scope", async () => {
    const s = setup();
    s.fake.scope = "email offline_access openid profile";
    await signIn(s.fake, s.store, s.auth);
    const err = (await s.client.call(jsonCall()).catch((e: unknown) => e)) as ModelCallError;
    expect(err.userText).toBe(PLAN_USAGE_OFF_TEXT);
    expect(s.fake.to(RESPONSES)).toHaveLength(0);
  });
});

describe("0010 provider factory", () => {
  it("with no provider and no key, a call fails with the set-up sentence", async () => {
    const s = setup();
    const err = (await s.client.call(jsonCall()).catch((e: unknown) => e)) as ModelCallError;
    expect(err.userText).toBe(NO_PROVIDER_TEXT);
    expect(s.client.label).toBe("no-provider");
  });

  it("Meta is the default: the server key works with no choice made, and the user's key wins over it", async () => {
    const s = setup("server-meta-key-0123");
    expect((await s.client.call(jsonCall())).outputText).toBe("meta ok");
    expect(s.fake.to(META_URL)[0]!.headers.authorization).toBe("Bearer server-meta-key-0123");
    s.store.update((x) => ({ ...x, meta: { key: "user-meta-key-4567" } }), { bump: true });
    await s.client.call(jsonCall());
    expect(s.fake.to(META_URL)[1]!.headers.authorization).toBe("Bearer user-meta-key-4567");
    expect(bodyOf(s.fake, META_URL, 1)).toMatchObject({ model: DEFAULT_META_MODEL, store: false });
    expect(s.client.label).toBe("meta-responses");
  });

  it("design item 4: with ChatGPT chosen and signed out, a Meta key is never used", async () => {
    const s = setup("server-meta-key-0123");
    s.store.update((x) => ({ ...x, provider: "chatgpt", meta: { key: "user-meta-key-4567" } }), { bump: true });
    const err = (await s.client.respond(toolCall()).catch((e: unknown) => e)) as ModelCallError;
    expect(err.userText).toBe(CHATGPT_SIGNED_OUT_TEXT);
    expect(s.fake.to(META_URL)).toHaveLength(0);
  });

  it("with Meta chosen and no key, ChatGPT is never used", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.store.update((x) => ({ ...x, provider: "meta" }), { bump: true });
    const err = (await s.client.call(jsonCall()).catch((e: unknown) => e)) as ModelCallError;
    expect(err.userText).toBe(META_KEY_MISSING_TEXT);
    expect(s.fake.to(RESPONSES)).toHaveLength(0);
  });

  it("the model choice: one choice per provider drives every call on it", async () => {
    const s = setup("server-meta-key-0123");
    s.store.update((x) => ({ ...x, metaModel: "muse-wonder-1.0" }), { bump: true });
    await s.client.respond(toolCall());
    await s.client.call(jsonCall());
    expect([bodyOf(s.fake, META_URL, 0).model, bodyOf(s.fake, META_URL, 1).model]).toEqual(["muse-wonder-1.0", "muse-wonder-1.0"]);
    // A contributor model never reaches the Meta API, even if stored.
    s.store.update((x) => ({ ...x, metaModel: "muse-spark-1.3-contributor" }), { bump: true });
    await s.client.call(jsonCall());
    expect(bodyOf(s.fake, META_URL, 2).model).toBe(DEFAULT_META_MODEL);

    await signIn(s.fake, s.store, s.auth);
    s.store.update((x) => ({ ...x, provider: "chatgpt", chatgpt: { ...x.chatgpt, model: "gpt-6.1-terra" } }), { bump: true });
    await s.client.respond(toolCall());
    await s.client.call(jsonCall());
    expect([bodyOf(s.fake, RESPONSES, 0).model, bodyOf(s.fake, RESPONSES, 1).model]).toEqual(["gpt-6.1-terra", "gpt-6.1-terra"]);
  });

  it("the model lists: Meta's fixed Muse list, ChatGPT's listing for the connection with the code default when none", () => {
    const { store } = setup();
    const settings = store.read();
    expect(modelOptions(settings, "meta")).toEqual([
      { id: "muse-spark-1.3", label: "Muse Spark 1.3", costHint: "lower" },
      { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", costHint: "higher" },
    ]);
    expect(modelOptions(settings, "chatgpt")).toEqual([{ id: "gpt-6.1-sol", label: "gpt-6.1-sol", costHint: null }]);
    const listed = { ...settings, chatgpt: { ...settings.chatgpt, models: [{ slug: "gpt-6.2-luna", displayName: "GPT-6.2 Luna" }] } };
    expect(chatGptModel(listed)).toBe("gpt-6.2-luna");
    expect(modelOptions(listed, "chatgpt")).toEqual([{ id: "gpt-6.2-luna", label: "GPT-6.2 Luna", costHint: null }]);
  });

  it("a model that lacks a capability is named in settings and the call fails, with no switch to another model", async () => {
    const s = setup();
    await signIn(s.fake, s.store, s.auth);
    s.fake.responses = () => Response.json({ error: { code: "subscription_sharing_unsupported_capability", param: "tools" } }, { status: 400 });
    const err = (await s.client.respond(toolCall()).catch((e: unknown) => e)) as ModelCallError;
    expect(err.userText).toBe("The model GPT-6.1 Sol does not support tool calling, which this app needs. Choose another model in settings. Nothing in your case changed.");
    expect(s.store.read().modelProblem).toEqual({ provider: "chatgpt", model: "gpt-6.1-sol", capability: "tool_calling" });
    expect(s.fake.to(RESPONSES).map((r) => JSON.parse(r.body).model)).toEqual(["gpt-6.1-sol"]);
  });

  it("no key or token reaches a log line or an error message", async () => {
    const logs: string[] = [];
    for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const userKey = fakeSecret("metakey");
    const s = setup();
    s.store.update((x) => ({ ...x, meta: { key: userKey } }), { bump: true });
    s.fake.meta = () => new Response(`bad request`, { status: 400 });
    const metaErr = (await s.client.call(jsonCall()).catch((e: unknown) => e)) as Error;
    await signIn(s.fake, s.store, s.auth);
    s.store.update((x) => ({ ...x, provider: "chatgpt" }), { bump: true });
    s.fake.responses = () => Response.json({ error: { code: "x" } }, { status: 500 });
    const gptErr = (await s.client.call(jsonCall()).catch((e: unknown) => e)) as Error;
    const text = [...logs, metaErr.message, metaErr.stack ?? "", gptErr.message, gptErr.stack ?? ""].join("\n");
    for (const secret of [userKey, s.fake.accessToken, s.fake.refreshToken, ...s.fake.idTokens]) expect(text).not.toContain(secret);
    vi.restoreAllMocks();
  });
});
