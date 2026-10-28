// The real chat route from the page: the POST carries the app's header and the case generation like
// every other write. fetch is replaced, so nothing leaves the test.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "./types.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stream(text: string) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      const bytes = new TextEncoder().encode(text);
      // Split mid-event to check the reader joins chunks.
      c.enqueue(bytes.slice(0, 25));
      c.enqueue(bytes.slice(25));
      c.close();
    },
  });
}

describe("chat transport", () => {
  it("POST sends the generation, the app header and the expected version, and streams the events", async () => {
    const sent: Array<{ method: string; path: string; headers: Record<string, string>; body?: string }> = [];
    vi.stubGlobal("fetch", async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      sent.push({ method: init.method, path, headers: init.headers, body: init.body });
      if (path === "/api/state") return { ok: true, status: 200, json: async () => ({ generation: 7 }) };
      return {
        ok: true,
        status: 200,
        body: stream('event: turn.started\ndata: {"turnId":"t1","userMessageId":"u1"}\n\nevent: turn.done\ndata: {"turnId":"t1","assistantMessageId":"a1","chatVersion":5}\n\n'),
      };
    });
    const { realTransport } = await import("./transport.ts");
    const events: ChatEvent[] = [];
    await realTransport.send("What is confirmed?", 4, (e) => events.push(e));
    const post = sent.find((s) => s.path === "/api/chat")!;
    expect(post.method).toBe("POST");
    expect(post.headers).toMatchObject({ "X-Appointments-App": "1", "X-Case-Generation": "7", "Content-Type": "application/json" });
    expect(JSON.parse(post.body!)).toEqual({ text: "What is confirmed?", expectedVersion: 4 });
    expect(events.map((e) => e.event)).toEqual(["turn.started", "turn.done"]);
  });

  it("GET answers null when the chat route does not exist, and any other refusal as an error", async () => {
    let status = 404;
    vi.stubGlobal("fetch", async () => ({ ok: status === 200, status, json: async () => ({ error: "forbidden_source" }) }));
    const { realTransport } = await import("./transport.ts");
    const { ApiError } = await import("../api.ts");
    expect(await realTransport.load()).toBeNull();
    status = 403;
    const err = await realTransport.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).body.error).toBe("forbidden_source");
  });

  it("reads the sprint 8 action event and skips names it does not know", async () => {
    const { createSseParser } = await import("./sse.ts");
    const events: ChatEvent[] = [];
    const parser = createSseParser((e) => events.push(e));
    parser.push('event: action\ndata: {"turnId":"t1","entry":{"id":"act-1","at":"2026-11-05T09:00:00-07:00","actor":"agent","kind":"claim_accepted","summary":"Accepted.","target":null,"undoable":true,"undone":false}}\n\nevent: later.event\ndata: {}\n\n');
    parser.end();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "action", data: { entry: { id: "act-1", actor: "agent" } } });
  });
});
