// 0024: the operator's DeepSeek fallback on the server key. Off, nothing
// changes. On, every call kind goes to DeepSeek through the same client
// shapes, holds and caps, the app says so, and no error moves a call.
// Nothing reaches the network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../server/api.ts";
import { createChat } from "../server/chat.ts";
import { CaseAgent } from "../src/agent/agent.ts";
import { MODEL_UNAVAILABLE_TEXT, type ChatEvent } from "../src/agent/types.ts";
import { CaseService } from "../src/case/service.ts";
import { extractClaims } from "../src/extract/extract.ts";
import { ConfigError, readServerFallback } from "../src/hosted/config.ts";
import { MAX_OUTPUT_TOKENS, chargeMicros, modelCostMicros, priceOf, turnCostMicros } from "../src/hosted/prices.ts";
import { IntakeService } from "../src/intake/service.ts";
import { ModelCallError, type ModelClient } from "../src/model/client.ts";
import { ChatGptAuth } from "../src/model/providers/chatgpt-auth.ts";
import { DEEPSEEK_RESPONSES_URL, DeepSeekResponsesClient, deepSeekBody } from "../src/model/providers/deepseek-client.ts";
import { activeProvider, createProviderClient } from "../src/model/providers/factory.ts";
import { DEEPSEEK_KEY_MISSING_TEXT, FALLBACK_NOTICE_TEXT, NO_PROVIDER_TEXT, fallbackStartLine } from "../src/model/providers/messages.ts";
import { DEEPSEEK_MODEL, currentModel, modelOptions } from "../src/model/providers/models.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { MODEL, buildJsonRequest } from "../src/model/request.ts";
import { buildToolRequest, functionCalls, outputText } from "../src/model/responses.ts";
import { FALLBACK_USAGE_TEXT } from "../src/model/usage-text.ts";
import { USAGE_TEXT } from "../src/model/usage.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, fixtureMessage, intake as helperIntake } from "./helpers.ts";
import { sseEvents, startHosted, type Browser, type Hosted } from "./hosted-helpers.ts";
import { FakeOpenAi, META_URL, PORT, completed, message, tempStore } from "./provider-fakes.ts";

const NOTICE = "Running on the fallback model. Kept normally runs on Meta's Muse Spark. Our Meta API billing has a problem right now, and that's our issue, not Meta's, so DeepSeek is answering until we fix it.";
const KEY = "deepseek-key-for-tests";
const USAGE = { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 } };

type Call = { url: string; body: any; authorization: string | null };

const stream = (output: unknown[]) => new Response(completed(output, USAGE as never), { headers: { "content-type": "text/event-stream" } });
const refused = (status: number, code: string) => Response.json({ error: { type: "invalid_request_error", code, message: "text that must not be repeated" } }, { status });

// A fake of both APIs over the global fetch. `script` answers each call in
// order. The default is a short text, or empty claims for a JSON call.
function fakeApis() {
  const calls: Call[] = [];
  const state = { calls, script: [] as Array<(call: Call) => Response>, text: "I can help with your appointments." };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (url !== DEEPSEEK_RESPONSES_URL && url !== META_URL) throw new Error(`No fake for ${url}.`);
    const call = { url, body: JSON.parse(String(init.body)), authorization: new Headers(init.headers).get("authorization") };
    calls.push(call);
    const next = state.script.shift();
    if (next) return next(call);
    return call.body.stream ? stream([message(state.text)]) : Response.json({ output: [message(JSON.stringify({ claims: [] }))], usage: USAGE });
  });
  return state;
}

const jsonCall = () => ({
  key: "msg-1",
  attempt: 1,
  effort: "minimal" as const,
  body: buildJsonRequest({ model: MODEL, effort: "minimal", instructions: "Extract.", input: "text", schemaName: "s", schema: { type: "object", required: ["claims"] } }),
});
const tools = [{ type: "function" as const, name: "read_case", description: "Read.", parameters: { type: "object" }, strict: false as const }];
const toolCall = () => ({ key: "chat-1-1", effort: "low" as const, body: buildToolRequest({ model: MODEL, effort: "low", instructions: "Help.", input: [{ role: "user", content: "hi" }], tools }) });

const cleanups: Array<() => void> = [];
let h: Hosted | null = null;
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await h?.close();
  h = null;
  vi.unstubAllGlobals();
});

function local(options: { fallback?: { key: string | null } | null; metaKey?: string | null } = {}) {
  const t = tempStore();
  cleanups.push(t.cleanup);
  const auth = new ChatGptAuth({ store: t.store, port: PORT, fetch: new FakeOpenAi().fetch });
  const client = createProviderClient({ store: t.store, auth, serverMetaKey: options.metaKey === undefined ? "server-meta-key" : options.metaKey, serverFallback: options.fallback ?? null });
  return { ...t, client };
}

describe("the APP_SERVER_MODEL setting", () => {
  it("is off when unset or meta, on with deepseek, and a typo stops the app", () => {
    expect(readServerFallback({})).toBeNull();
    expect(readServerFallback({ APP_SERVER_MODEL: "" })).toBeNull();
    expect(readServerFallback({ APP_SERVER_MODEL: "meta", DEEPSEEK_API_KEY: KEY })).toBeNull();
    // A key alone turns nothing on.
    expect(readServerFallback({ DEEPSEEK_API_KEY: KEY })).toBeNull();
    expect(readServerFallback({ APP_SERVER_MODEL: "DeepSeek", DEEPSEEK_API_KEY: ` ${KEY} ` })).toEqual({ key: KEY });
    expect(readServerFallback({ APP_SERVER_MODEL: "deepseek" })).toEqual({ key: null });
    expect(() => readServerFallback({ APP_SERVER_MODEL: "deepsek", DEEPSEEK_API_KEY: KEY })).toThrow(ConfigError);
  });

  it("the start line says what is on, and says plainly when the key is absent", () => {
    expect(fallbackStartLine(KEY)).toMatch(/go to DeepSeek/);
    expect(fallbackStartLine(KEY)).not.toContain(KEY);
    expect(fallbackStartLine(null)).toMatch(/DEEPSEEK_API_KEY is not set/);
  });
});

describe("the DeepSeek client", () => {
  it("turns thinking off, sets the model, and leaves a tool request's shape alone", () => {
    const body = deepSeekBody(toolCall().body);
    expect(body).toMatchObject({ model: DEEPSEEK_MODEL, reasoning: { effort: "none" }, instructions: "Help.", tool_choice: "auto", stream: true, store: false });
    expect(body.tools).toEqual(tools);
  });

  it("a JSON call says JSON and states its schema in the instructions, and keeps text.format", () => {
    const body = deepSeekBody(jsonCall().body);
    expect(body.instructions).toContain("Extract.");
    expect(body.instructions).toContain("JSON");
    expect(body.instructions).toContain('{"type":"object","required":["claims"]}');
    expect(body.text.format.type).toBe("json_schema");
  });

  it("maps tool calls and usage, with cached input and no reasoning billed apart", async () => {
    const fake = fakeApis();
    fake.script.push(() => stream([{ type: "function_call", call_id: "c1", name: "read_case", arguments: "{}" }]));
    const reply = await new DeepSeekResponsesClient({ apiKey: KEY }).respond(toolCall());
    expect(fake.calls).toEqual([expect.objectContaining({ url: "https://api.deepseek.com/responses", authorization: `Bearer ${KEY}` })]);
    expect(functionCalls(reply.output)).toEqual([expect.objectContaining({ call_id: "c1", name: "read_case" })]);
    expect(reply.usage).toEqual({ input: 1000, cachedInput: 200, output: 100, reasoning: 0 });
  });

  it("reads an event named only by its data", async () => {
    fakeApis().script.push(() => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [message("hello")], usage: USAGE } })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const reply = await new DeepSeekResponsesClient({ apiKey: KEY }).respond(toolCall());
    expect(outputText(reply.output)).toBe("hello");
  });

  it("a call names the model that answered, or that failed", async () => {
    const fake = fakeApis();
    expect((await new DeepSeekResponsesClient({ apiKey: KEY }).call(jsonCall())).model).toBe(DEEPSEEK_MODEL);
    fake.script.push(() => refused(402, "insufficient_balance"));
    expect((await new DeepSeekResponsesClient({ apiKey: KEY }).call(jsonCall()).catch((e) => e)).model).toBe(DEEPSEEK_MODEL);
  });

  it("a truncated stream fails with its usage, so the charge is what ran", async () => {
    const event = `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { output: [], usage: USAGE } })}\n\n`;
    fakeApis().script.push(() => new Response(event, { headers: { "content-type": "text/event-stream" } }));
    const err = await new DeepSeekResponsesClient({ apiKey: KEY }).respond(toolCall()).catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err.usage).toEqual({ input: 1000, cachedInput: 200, output: 100, reasoning: 0 });
  });

  it("an API error reads like any other model error, with no body text and no key", async () => {
    fakeApis().script.push(() => refused(402, "insufficient_balance"));
    const err = await new DeepSeekResponsesClient({ apiKey: KEY }).call(jsonCall()).catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err.message).toBe("Model call returned HTTP 402 (type invalid_request_error, code insufficient_balance).");
    expect(err.status).toBe(402);
    expect(`${err.message}${err.userText}`).not.toContain(KEY);
    expect(err.message).not.toContain("must not be repeated");
  });
});

describe("the provider factory", () => {
  it("off: every call goes to Meta, and DeepSeek is never reached", async () => {
    const fake = fakeApis();
    const { client } = local();
    await client.call(jsonCall());
    await client.respond(toolCall());
    expect(fake.calls.map((c) => c.url)).toEqual([META_URL, META_URL]);
    expect(fake.calls.map((c) => c.body.model)).toEqual([MODEL, MODEL]);
    expect(client.label).toBe("meta-responses");
  });

  it("on: both call kinds go to DeepSeek with its key, and the label says so", async () => {
    const fake = fakeApis();
    const { client } = local({ fallback: { key: KEY } });
    await client.call(jsonCall());
    await client.respond(toolCall());
    expect(fake.calls.map((c) => c.url)).toEqual([DEEPSEEK_RESPONSES_URL, DEEPSEEK_RESPONSES_URL]);
    expect(fake.calls.map((c) => c.body.model)).toEqual([DEEPSEEK_MODEL, DEEPSEEK_MODEL]);
    expect(fake.calls.every((c) => c.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(client.label).toBe("deepseek-responses");
  });

  it("on with no Meta key at all still works, as the setting replaces the server key", async () => {
    const fake = fakeApis();
    const { client } = local({ fallback: { key: KEY }, metaKey: null });
    expect(client.ready()).toBe(true);
    await client.respond(toolCall());
    expect(fake.calls.map((c) => c.url)).toEqual([DEEPSEEK_RESPONSES_URL]);
  });

  it("a person's own Meta key and a ChatGPT choice are theirs, and stay", async () => {
    const fake = fakeApis();
    const { client, store } = local({ fallback: { key: KEY } });
    store.update((s) => ({ ...s, provider: "meta", meta: { key: "the-persons-own-key" } }), { bump: true });
    await client.respond(toolCall());
    expect(fake.calls).toEqual([expect.objectContaining({ url: META_URL, authorization: "Bearer the-persons-own-key" })]);
    const settings = { ...store.read(), meta: null, provider: "chatgpt" as const };
    expect(activeProvider({ settings, serverMetaKey: "k", serverFallback: { key: KEY } })).toBe("chatgpt");
  });

  it("no automatic failover: Meta's billing refusal stays Meta's while the setting is off", async () => {
    const fake = fakeApis();
    fake.script.push(() => refused(402, "billing_not_configured"));
    const err = await local().client.respond(toolCall()).catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err.errorCode).toBe("billing_not_configured");
    expect(fake.calls.map((c) => c.url)).toEqual([META_URL]);
  });

  it("no automatic failover: a DeepSeek failure stays DeepSeek's while the setting is on", async () => {
    const fake = fakeApis();
    for (const status of [402, 429, 500, 503]) {
      fake.script.push(() => refused(status, "failed"));
      await expect(local({ fallback: { key: KEY } }).client.respond(toolCall())).rejects.toBeInstanceOf(ModelCallError);
    }
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls.every((c) => c.url === DEEPSEEK_RESPONSES_URL)).toBe(true);
  });

  it("key absent: not ready, and a direct call gets a fixed refusal, with no call to either API and never back to Meta", async () => {
    const fake = fakeApis();
    const { client } = local({ fallback: { key: null } });
    expect(client.ready()).toBe(false);
    const err = await client.call(jsonCall()).catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err.userText).toBe(DEEPSEEK_KEY_MISSING_TEXT);
    await expect(client.respond(toolCall())).rejects.toThrow(DEEPSEEK_KEY_MISSING_TEXT);
    expect(fake.calls).toEqual([]);
  });

  it("key absent: a person's own Meta key is still ready", () => {
    const { client, store } = local({ fallback: { key: null } });
    store.update((s) => ({ ...s, provider: "meta", meta: { key: "the-persons-own-key" } }), { bump: true });
    expect(client.ready()).toBe(true);
  });

  it("the model list and the current model are DeepSeek's", () => {
    const { store } = local();
    expect(modelOptions(store.read(), "deepseek")).toEqual([{ id: "deepseek-flash", label: "DeepSeek Flash", costHint: null }]);
    expect(currentModel(store.read(), "deepseek")).toBe("deepseek-flash");
  });
});

describe("the DeepSeek prices", () => {
  it("are the peak rates, with a source and a date, in the same money math", () => {
    const price = priceOf("deepseek-flash")!;
    expect(price).toMatchObject({ input: 300_000, cachedInput: 6_000, output: 1_200_000 });
    expect(price.source).toMatch(/api-docs\.deepseek\.com.*2026-11-04/);
    const usage = { input: 1000, cachedInput: 200, output: 100, reasoning: 0 };
    // 800 × 0.30 + 200 × 0.006 + 100 × 1.20 per million, rounded up.
    expect(modelCostMicros(price, usage)).toBe(362);
    expect(chargeMicros(price, usage, 300)).toBe(1084);
    expect(turnCostMicros("deepseek-flash", 300)).toBeGreaterThan(0);
  });
});

const gen = (state: { generation: number }) => ({ "X-Case-Generation": String(state.generation) });

async function signedIn(options: Parameters<typeof startHosted>[0] = {}, grantUsd = 5) {
  h = await startHosted(options);
  const b = h.browser();
  await h.signUp(b);
  const id = await h.accountOf(b);
  if (grantUsd > 0) h.app.store.grant(id, grantUsd * 1_000_000, "judge:j000000000000");
  return { b, id };
}

const chat = async (b: Browser, text: string) => {
  const s = (await b.call("GET", "/api/state")).body;
  const c = (await b.call("GET", "/api/chat")).body;
  return sseEvents((await b.call("POST", "/api/chat", { text, expectedVersion: c.chatVersion }, gen(s))).text);
};

describe("the hosted site with the fallback on", () => {
  it("a chat turn with a tool call runs on DeepSeek, and every call is held and charged at its prices", async () => {
    const fake = fakeApis();
    fake.script.push(() => stream([{ type: "function_call", call_id: "c1", name: "get_schedule", arguments: "{}" }]));
    const { b, id } = await signedIn({ serverFallback: { key: KEY } });
    const events = await chat(b, "What is on my schedule?");
    expect(events.at(-1)!.event).toBe("turn.done");
    expect(events.some((e) => e.event === "tool.finished")).toBe(true);
    expect(fake.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of fake.calls) {
      expect(c).toMatchObject({ url: DEEPSEEK_RESPONSES_URL, authorization: `Bearer ${KEY}` });
      expect(c.body).toMatchObject({ model: DEEPSEEK_MODEL, max_output_tokens: MAX_OUTPUT_TOKENS.tool, reasoning: { effort: "none" } });
    }
    // The tool's result went back with its call.
    expect(fake.calls[1]!.body.input.map((i: { type?: string }) => i.type)).toEqual(expect.arrayContaining(["function_call", "function_call_output"]));

    const charges = h!.app.store.charges(id);
    expect(charges).toHaveLength(fake.calls.length);
    const price = priceOf(DEEPSEEK_MODEL)!;
    const usage = { input: 1000, cachedInput: 200, output: 100, reasoning: 0 };
    expect(charges.every((c) => c.model === DEEPSEEK_MODEL && c.amountMicros === chargeMicros(price, usage, 300))).toBe(true);
    // The daily cap counts Jeff's real cost, at DeepSeek's prices.
    expect(h!.app.store.dayCost()).toBe(charges.length * modelCostMicros(price, usage));
    expect(h!.app.store.ledger(id).filter((r) => r.kind === "hold" && r.open)).toEqual([]);

    const page = (await b.call("GET", "/api/usage")).body;
    expect(page.charges[0]).toMatchObject({ model: DEEPSEEK_MODEL, modelLabel: "DeepSeek Flash" });
    expect(JSON.stringify(page)).not.toContain("Muse");
    expect(JSON.stringify(page)).not.toContain(KEY);
    expect(h!.logs.join("\n")).not.toContain(KEY);
  });

  it("the other call kinds go to DeepSeek too: extraction is charged at its prices", async () => {
    const fake = fakeApis();
    const { b, id } = await signedIn({ serverFallback: { key: KEY } });
    const s = (await b.call("GET", "/api/state")).body;
    await b.call("POST", "/api/messages", fixtureMessage("m2"), gen(s));
    const s2 = (await b.call("GET", "/api/state")).body;
    const m = s2.messages.at(-1);
    expect((await b.call("POST", `/api/messages/${m.id}/extract`, { expectedVersion: m.version }, gen(s2))).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ url: DEEPSEEK_RESPONSES_URL, body: { model: DEEPSEEK_MODEL, max_output_tokens: MAX_OUTPUT_TOKENS.json, reasoning: { effort: "none" } } });
    expect(fake.calls[0]!.body.instructions).toContain("JSON schema");
    expect(h!.app.store.charges(id).map((c) => c.model)).toEqual([DEEPSEEK_MODEL]);
    const after = (await b.call("GET", "/api/state")).body;
    expect(after.messages.at(-1).attempts.map((a: { model: string }) => a.model)).toEqual([DEEPSEEK_MODEL]);
  });

  it("the notice is on the session, signed in and out, and in the settings, with DeepSeek as the model", async () => {
    fakeApis();
    const { b } = await signedIn({ serverFallback: { key: KEY } });
    const settings = (await b.call("GET", "/api/settings")).body;
    expect(settings).toMatchObject({ provider: "deepseek", model: "deepseek-flash", fallbackNotice: NOTICE });
    expect(FALLBACK_NOTICE_TEXT).toBe(NOTICE);
    expect(settings.models.map((m: { label: string }) => m.label)).toEqual(["DeepSeek Flash"]);
    expect(settings.hosted.chatgptText).not.toContain("Meta");
    expect((await b.call("GET", "/api/session")).body.fallbackNotice).toBe(NOTICE);
    expect((await h!.browser().call("GET", "/api/session")).body.fallbackNotice).toBe(NOTICE);
    expect(h!.app.startLines().join("\n")).toContain("go to DeepSeek");
  });

  it("nobody can choose the fallback, and the model route writes nothing for it", async () => {
    fakeApis();
    const { b } = await signedIn({ serverFallback: { key: KEY } });
    const before = (await b.call("GET", "/api/settings")).body;
    const chosen = await b.call("PUT", "/api/settings/provider", { provider: "deepseek", expectedVersion: before.settingsVersion });
    expect(chosen.status).toBe(400);
    const model = await b.call("PUT", "/api/settings/model", { model: "deepseek-flash", expectedVersion: before.settingsVersion });
    expect(model.status).toBe(200);
    expect(model.body.settingsVersion).toBe(before.settingsVersion);
    const muse = await b.call("PUT", "/api/settings/model", { model: "muse-spark-1.3", expectedVersion: before.settingsVersion });
    expect(muse.status).toBe(422);
  });

  it("the daily cap holds, and its sentence does not name Meta", async () => {
    const fake = fakeApis();
    const { b } = await signedIn({ serverFallback: { key: KEY }, env: { APP_DAILY_COST_CAP_USD: "0" } });
    const events = await chat(b, "What is on my schedule?");
    expect(events).toEqual([{ event: "turn.error", data: { turnId: expect.any(String), code: "usage_paused", message: FALLBACK_USAGE_TEXT.daily_cap.text } }]);
    expect(fake.calls).toEqual([]);
  });

  it("the credit limit holds: no balance, no call", async () => {
    const fake = fakeApis();
    const { b } = await signedIn({ serverFallback: { key: KEY } }, 0);
    const events = await chat(b, "What is on my schedule?");
    expect(events).toEqual([{ event: "turn.error", data: { turnId: expect.any(String), code: "credits_exhausted", message: USAGE_TEXT.credits_exhausted.text } }]);
    expect(fake.calls).toEqual([]);
  });

  it("a failed DeepSeek call is released when refused, and Meta is not tried", async () => {
    const fake = fakeApis();
    const { b, id } = await signedIn({ serverFallback: { key: KEY } });
    fake.script.push(() => refused(402, "insufficient_balance"));
    const events = await chat(b, "What is on my schedule?");
    expect(events.find((e) => e.event === "turn.error")).toMatchObject({ data: { code: "model_unavailable", message: MODEL_UNAVAILABLE_TEXT } });
    expect(fake.calls.map((c) => c.url)).toEqual([DEEPSEEK_RESPONSES_URL]);
    expect(h!.app.store.charges(id)).toEqual([]);
    expect(h!.app.store.ledger(id).filter((r) => r.kind === "hold" && r.open)).toEqual([]);
  });

  it("key absent: a clear start line, a plain refusal, no call, and no notice that says DeepSeek is answering", async () => {
    const fake = fakeApis();
    const { b } = await signedIn({ serverFallback: { key: null } });
    expect(h!.app.startLines().join("\n")).toContain("DEEPSEEK_API_KEY is not set");
    const events = await chat(b, "What is on my schedule?");
    expect(events.at(-1)).toMatchObject({ event: "turn.error", data: { code: "usage_paused", message: FALLBACK_USAGE_TEXT.server_key_off.text } });
    expect(fake.calls).toEqual([]);
    const settings = (await b.call("GET", "/api/settings")).body;
    expect(settings.provider).toBe("deepseek");
    expect(settings.fallbackNotice).toBeUndefined();
    expect((await b.call("GET", "/api/session")).body.fallbackNotice).toBeUndefined();

    // A model route is refused too, and records no attempt.
    const s = (await b.call("GET", "/api/state")).body;
    await b.call("POST", "/api/messages", fixtureMessage("m2"), gen(s));
    const s2 = (await b.call("GET", "/api/state")).body;
    const m = s2.messages.at(-1);
    const r = await b.call("POST", `/api/messages/${m.id}/extract`, { expectedVersion: m.version }, gen(s2));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "server_key_off", message: FALLBACK_USAGE_TEXT.server_key_off.text });
    const after = (await b.call("GET", "/api/state")).body;
    expect(after.messages.at(-1)).toMatchObject({ attempts: [], version: m.version });
  });
});

describe("the hosted site with the fallback off", () => {
  it("nothing changes: Muse on Meta, no notice, no DeepSeek price, and a DeepSeek key alone is ignored", async () => {
    const fake = fakeApis();
    const { b, id } = await signedIn();
    const events = await chat(b, "What is on my schedule?");
    expect(events.at(-1)!.event).toBe("turn.done");
    expect(fake.calls.every((c) => c.url === META_URL && c.body.model === MODEL)).toBe(true);
    expect(h!.app.store.charges(id).every((c) => c.model === MODEL)).toBe(true);

    const settings = (await b.call("GET", "/api/settings")).body;
    expect(settings).toMatchObject({ provider: "meta", model: MODEL });
    expect("fallbackNotice" in settings).toBe(false);
    const session = (await b.call("GET", "/api/session")).body;
    expect("fallbackNotice" in session).toBe(false);
    expect("fallbackNotice" in (await h!.browser().call("GET", "/api/session")).body).toBe(false);
    const usage = (await b.call("GET", "/api/usage")).body;
    expect(usage.prices.map((p: { model: string }) => p.model)).toEqual(["muse-spark-1.3", "muse-wonder-1.0"]);
    expect(h!.app.startLines().join("\n")).not.toMatch(/deepseek/i);
  });

  it("the sentences still name Meta, as they did", async () => {
    const fake = fakeApis();
    const { b } = await signedIn({ env: { APP_DAILY_COST_CAP_USD: "0" } });
    const events = await chat(b, "What is on my schedule?");
    expect(events).toEqual([{ event: "turn.error", data: { turnId: expect.any(String), code: "usage_paused", message: USAGE_TEXT.daily_cap.text } }]);
    expect(fake.calls).toEqual([]);
  });

  it("a charge made on DeepSeek keeps its label after the switch back", async () => {
    fakeApis();
    const { b, id } = await signedIn();
    const held = h!.app.store.hold({ accountId: id, workspace: id, route: "chat", turn: null, model: DEEPSEEK_MODEL }, 1000, 100, 20_000_000);
    expect(held.ok).toBe(true);
    if (held.ok) h!.app.store.settle(held.holdId, { usage: { input: 10, cachedInput: 0, output: 5, reasoning: 0 }, amountMicros: 100, costMicros: 10 });
    const usage = (await b.call("GET", "/api/usage")).body;
    expect(usage.charges[0]).toMatchObject({ model: DEEPSEEK_MODEL, modelLabel: "DeepSeek Flash" });
  });
});

// The app as server/main.ts wires it in local mode, on the provider factory.
function localApp(options: { fallback: { key: string | null } }) {
  const t = local(options);
  const store = new EventStore(":memory:");
  const intake = new IntakeService(store, t.client);
  const kase = new CaseService(store, intake, t.client, { userName: "Dana Reyes" });
  const reply = new ReplyService(store, kase, t.client);
  const records = new RecordsService(store, intake, kase);
  const ready = () => t.client.ready();
  const api = createApi(intake, kase, { ready }, reply, { store, records });
  const chat = createChat(new CaseAgent(store, { intake, kase, reply, records }, t.client, { ready }));
  const call = (method: string, p: string, body?: unknown) => api({ method, path: p, body, generation: kase.generation() });
  const say = async (text: string) => {
    const events: ChatEvent[] = [];
    const chatVersion = (await new Promise<{ chatVersion: number }>((resolve) => chat.serve({ method: "GET", body: undefined }, { json: (_s, b) => resolve(b as { chatVersion: number }), event: () => {}, end: () => {} }))).chatVersion;
    await chat.serve({ method: "POST", body: { text, expectedVersion: chatVersion }, generation: kase.generation() }, { json: () => {}, event: (e) => events.push(e), end: () => {} });
    return events;
  };
  return { client: t.client, store, call, say };
}

describe("J12 with the fallback on and no key, in local mode", () => {
  it("a chat turn is refused before it starts, and nothing is saved", async () => {
    const fake = fakeApis();
    const a = localApp({ fallback: { key: null } });
    const before = a.store.readAll().length;
    const events = await a.say("What is confirmed?");
    expect(events.map((e) => e.event)).toEqual(["turn.error"]);
    expect(events[0]!.data).toMatchObject({ code: "provider_not_ready", message: NO_PROVIDER_TEXT });
    expect(a.store.readAll()).toHaveLength(before);
    expect(fake.calls).toEqual([]);
  });

  it("every model route answers 422 provider_not_ready and records no attempt", async () => {
    const fake = fakeApis();
    const a = localApp({ fallback: { key: null } });
    const imported = await a.call("POST", "/api/messages", fixtureMessage("m1"));
    expect(imported.status).toBe(200);
    const count = a.store.readAll().length;
    const refused = [
      await a.call("POST", "/api/messages/m1/extract", { effort: "minimal", expectedVersion: (imported.body as { version: number }).version }),
      await a.call("POST", "/api/conflicts/c-1/explain", { expectedVersion: 0 }),
      await a.call("POST", "/api/questions/next", { expectedVersion: 0 }),
      await a.call("POST", "/api/reply/suggest", { expectedVersion: 0, intent: "MON" }),
    ];
    for (const r of refused) expect(r).toEqual({ status: 422, body: { error: "provider_not_ready", message: NO_PROVIDER_TEXT } });
    expect(a.store.readAll()).toHaveLength(count);
    expect(fake.calls).toEqual([]);
  });

  it("with the key the same routes run, on DeepSeek", async () => {
    const fake = fakeApis();
    const a = localApp({ fallback: { key: KEY } });
    const imported = await a.call("POST", "/api/messages", fixtureMessage("m1"));
    const r = await a.call("POST", "/api/messages/m1/extract", { effort: "minimal", expectedVersion: (imported.body as { version: number }).version });
    expect(r.status).toBe(200);
    expect(fake.calls.map((c) => c.url)).toEqual([DEEPSEEK_RESPONSES_URL]);
  });
});

// Recorded model answers, carried through the real DeepSeek client, so the
// services see valid outputs on the path a DeepSeek answer takes.
function throughDeepSeek(fake: ReturnType<typeof fakeApis>): ModelClient {
  const recorded = RecordedModelClient.fromDirectory();
  const deepseek = new DeepSeekResponsesClient({ apiKey: KEY });
  return {
    label: deepseek.label,
    call: async (request) => {
      const { outputText: text } = await recorded.call(request);
      fake.script.push(() => Response.json({ output: [message(text)], usage: USAGE }));
      return deepseek.call(request);
    },
  };
}

async function story(client: ModelClient) {
  const store = new EventStore();
  // The first messages were read before the switch, by the recorded model.
  const earlier = helperIntake(store);
  await acceptMessages(earlier, ["m1", "m2", "m3"]);
  const kase = new CaseService(store, earlier, client, { now: () => "2026-11-06T10:00:00.000Z", userName: "Dana Reyes" });
  const reply = new ReplyService(store, kase, client, { now: () => "2026-11-06T10:00:00.000Z" });
  return { store, intake: earlier, kase, reply };
}

const extractionModels = (store: EventStore) => store.readAll().filter((e) => e.type === "extraction_attempted").map((e) => (e.data as { model: string }).model);

describe("the model that really answered", () => {
  it("an explanation and a question on DeepSeek say DeepSeek, in the records and the API answer, and old rows keep what they say", async () => {
    const fake = fakeApis();
    const { store, kase } = await story(throughDeepSeek(fake));
    const conflict = kase.view().conflicts[0]!;

    const explained = await kase.explain(conflict.id, conflict.version);
    expect(explained.explanation).toMatchObject({ outcome: "valid", model: DEEPSEEK_MODEL });
    expect(explained.explanation!.attempts).toHaveLength(1);

    await kase.askNext(0);
    const stored = JSON.stringify(store.readAll().filter((e) => e.type !== "extraction_attempted"));
    expect(stored.split(`"model":"${DEEPSEEK_MODEL}"`).length - 1).toBe(fake.calls.length);
    expect(stored).not.toContain(`"model":"${MODEL}"`);
    expect(fake.calls).toHaveLength(2);

    // The extractions were before the switch, and stay as they were.
    expect(extractionModels(store)).toEqual([MODEL, MODEL, MODEL]);
  });

  it("a suggestion on DeepSeek says DeepSeek", async () => {
    const fake = fakeApis();
    const { reply } = await story(throughDeepSeek(fake));
    const view = await reply.suggest("I want Monday.", 0);
    expect(view.reply.suggestion).toMatchObject({ outcome: "valid", model: DEEPSEEK_MODEL });
  });

  it("an extraction on DeepSeek says DeepSeek, and so does each attempt of one that failed", async () => {
    const fake = fakeApis();
    const client = new DeepSeekResponsesClient({ apiKey: KEY });
    const m = fixtureMessage("m1");
    const valid = await extractClaims(m, client, { effort: "minimal" });
    expect(valid.attempts.map((a) => a.model)).toEqual([DEEPSEEK_MODEL]);
    fake.script.push(
      () => Response.json({ output: [message("not json")], usage: USAGE }),
      () => refused(402, "insufficient_balance"),
    );
    const failed = await extractClaims(m, client, { effort: "minimal" });
    expect(failed.attempts.map((a) => [a.problem, a.model])).toEqual([
      ["not_json", DEEPSEEK_MODEL],
      ["call_failed", DEEPSEEK_MODEL],
    ]);
  });

  it("a failed explanation says DeepSeek too", async () => {
    const fake = fakeApis();
    const { kase } = await story(new DeepSeekResponsesClient({ apiKey: KEY }));
    const conflict = kase.view().conflicts[0]!;
    fake.script.push(() => refused(500, "failed"), () => refused(500, "failed"));
    const explained = await kase.explain(conflict.id, conflict.version);
    expect(explained.explanation!.outcome).not.toBe("valid");
    expect(explained.explanation!.model).toBe(DEEPSEEK_MODEL);
  });

  it("a refusal named as a missing capability keeps the model", async () => {
    const fake = fakeApis();
    fake.script.push(() => refused(400, "unsupported_parameter"), () => refused(400, "unsupported_parameter"));
    const { client } = local({ fallback: { key: KEY } });
    const r = await extractClaims(fixtureMessage("m1"), client, { effort: "minimal" });
    expect(r.attempts.map((a) => a.model)).toEqual([DEEPSEEK_MODEL, DEEPSEEK_MODEL]);
  });

  it("off, and on a person's own Meta key with the setting on, records stay as they were, with no new field on a reply", async () => {
    const fake = fakeApis();
    const off = local();
    expect(await off.client.call(jsonCall())).not.toHaveProperty("model");
    expect((await extractClaims(fixtureMessage("m1"), off.client, { effort: "minimal" })).attempts.map((a) => a.model)).toEqual([MODEL]);
    const own = local({ fallback: { key: KEY } });
    own.store.update((s) => ({ ...s, provider: "meta", meta: { key: "the-persons-own-key" } }), { bump: true });
    expect((await extractClaims(fixtureMessage("m1"), own.client, { effort: "minimal" })).attempts.map((a) => a.model)).toEqual([MODEL]);
    expect(fake.calls.map((c) => c.url)).toEqual([META_URL, META_URL, META_URL]);
    fake.script.push(() => refused(402, "billing_not_configured"), () => refused(402, "billing_not_configured"));
    expect((await extractClaims(fixtureMessage("m1"), off.client, { effort: "minimal" })).attempts.map((a) => a.model)).toEqual([MODEL, MODEL]);
  });
});
