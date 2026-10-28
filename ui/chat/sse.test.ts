// The event-stream reader for the chat route.
import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse.ts";
import type { ChatEvent } from "./types.ts";

describe("chat event stream", () => {
  it("reads events split across chunks, with CRLF and multi-line data", () => {
    const got: ChatEvent[] = [];
    const p = createSseParser((e) => got.push(e));
    p.push('event: turn.started\ndata: {"turnId":"t1","userMessageId":"u1"}\n\nevent: text.de');
    p.push('lta\r\ndata: {"turnId":"t1",\r\ndata: "text":"Hel"}\r\n\r\n: a comment\n\n');
    p.push('event: text.delta\ndata: {"turnId":"t1","text":"lo"}\n');
    p.end();
    expect(got).toEqual([
      { event: "turn.started", data: { turnId: "t1", userMessageId: "u1" } },
      { event: "text.delta", data: { turnId: "t1", text: "Hel" } },
      { event: "text.delta", data: { turnId: "t1", text: "lo" } },
    ]);
  });

  it("skips unknown events and data that is not JSON", () => {
    const got: ChatEvent[] = [];
    const p = createSseParser((e) => got.push(e));
    p.push('event: something.new\ndata: {"a":1}\n\nevent: card\ndata: not json\n\nevent: turn.done\ndata: {"turnId":"t1","assistantMessageId":"a1","chatVersion":2}\n\n');
    expect(got).toEqual([{ event: "turn.done", data: { turnId: "t1", assistantMessageId: "a1", chatVersion: 2 } }]);
  });
});
