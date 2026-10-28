// The live client's tool turn (G1), against a stubbed fetch: the request it
// sends, the event stream it reads, and its failures. No network.
import { describe, expect, it, vi } from "vitest";
import { MetaResponsesClient, ModelCallError } from "../src/model/client.ts";
import { buildToolRequest, readSse } from "../src/model/responses.ts";
import { functionTools } from "../src/agent/tools.ts";

const KEY = "test-key-not-real-1234567890";

const body = (stream = true) =>
  buildToolRequest({ model: "muse-spark-1.3", effort: "low", instructions: "x", input: [{ role: "user", content: "Hi" }], tools: functionTools(), stream });

function streamOf(text: string, cut = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += cut) controller.enqueue(bytes.slice(i, i + cut));
      controller.close();
    },
  });
}

const sse = (events: Array<[string, unknown]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

const COMPLETED = {
  type: "response.completed",
  response: {
    output: [
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_schedule", arguments: "{}" },
    ],
    usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 100 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 12 } },
  },
};

describe("MetaResponsesClient.respond", () => {
  it("sends store false, streaming, tools and encrypted reasoning, and reads the output from response.completed", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(
        streamOf(
          ": keep-alive\n\n" +
            sse([
              ["response.created", { type: "response.created" }],
              ["response.output_text.delta", { delta: "Hel" }],
              ["response.completed", COMPLETED],
            ]),
        ),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const reply = await new MetaResponsesClient({ apiKey: KEY }).respond({ key: "chat-t1-1", effort: "low", body: body() });
    expect(reply.output).toEqual(COMPLETED.response.output);
    expect(reply.usage).toEqual({ input: 900, cachedInput: 100, output: 40, reasoning: 12 });
    expect(reply.firstByteMs).not.toBeNull();
    const sent = JSON.parse(String(seen[0]!.init.body));
    expect(sent).toMatchObject({ model: "muse-spark-1.3", store: false, stream: true, include: ["reasoning.encrypted_content"], tool_choice: "auto" });
    expect(sent.tools.map((t: { name: string }) => t.name)).toContain("import_message");
    expect((seen[0]!.init.headers as Record<string, string>).Accept).toBe("text/event-stream");
  });

  it("reads a non-streaming body too", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(COMPLETED.response), { status: 200 }));
    const reply = await new MetaResponsesClient({ apiKey: KEY }).respond({ key: "k", effort: "low", body: body(false) });
    expect(reply.output).toHaveLength(2);
    expect(reply.firstByteMs).toBeNull();
  });

  it("fails as a model call, without the key, on HTTP errors, failed streams and streams that end early", async () => {
    const client = new MetaResponsesClient({ apiKey: KEY });
    const cases: Array<() => Response> = [
      () => new Response("rate limited", { status: 429 }),
      () => new Response(streamOf(sse([["response.failed", { type: "response.failed" }]])), { status: 200 }),
      () => new Response(streamOf(sse([["error", { message: "bad" }]])), { status: 200 }),
      () => new Response(streamOf(sse([["response.created", {}]])), { status: 200 }),
      () => new Response(streamOf("event: response.completed\ndata: {not json\n\n"), { status: 200 }),
    ];
    for (const make of cases) {
      vi.stubGlobal("fetch", async () => make());
      const err = await client.respond({ key: "k", effort: "low", body: body() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelCallError);
      expect(String((err as Error).message)).not.toContain(KEY);
    }
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });
    expect(await client.respond({ key: "k", effort: "low", body: body() }).catch((e: unknown) => e)).toBeInstanceOf(ModelCallError);
  });

  it("refuses a request without store false or with a contributor model", async () => {
    const client = new MetaResponsesClient({ apiKey: KEY });
    await expect(client.respond({ key: "k", effort: "low", body: { ...body(), store: true as unknown as false } })).rejects.toThrow("store: false");
    expect(() => buildToolRequest({ model: "muse-spark-1.3-contributor", effort: "low", instructions: "", input: [], tools: [] })).toThrow(/Contributor/);
  });
});

describe("readSse", () => {
  it("splits events across chunk boundaries and line endings, and joins data lines", async () => {
    const text = "event: a\r\ndata: 1\r\n\r\n: comment\n\nevent: b\ndata: x\ndata: y\n\ndata: last";
    const out = [];
    for await (const e of readSse(streamOf(text, 3) as unknown as AsyncIterable<Uint8Array>)) out.push(e);
    expect(out).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "x\ny" },
      { event: "message", data: "last" },
    ]);
  });
});
