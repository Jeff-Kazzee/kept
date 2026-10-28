// The real chat route. GET /api/chat reads the stored chat. POST /api/chat
// sends one message and streams the turn back as server-sent events. Both
// need the paired session cookie, and the POST carries the same headers as
// every other write. Until the chat route exists, GET answers 404 and the
// page says the chat is not available.
import { ApiError, writeHeaders } from "../api.ts";
import { createSseParser } from "./sse.ts";
import type { ChatEvent, ChatLog, ChatTransport } from "./types.ts";

async function errorBody(res: Response): Promise<ApiError> {
  let body: ApiError["body"] = {};
  try {
    body = (await res.json()) as ApiError["body"];
  } catch {
    // Not JSON. The status says enough.
  }
  return new ApiError(res.status, body);
}

export const realTransport: ChatTransport = {
  kind: "real",
  async load(): Promise<ChatLog | null> {
    const res = await fetch("/api/chat", { method: "GET" });
    if (res.status === 404 || res.status === 405) return null;
    if (!res.ok) throw await errorBody(res);
    return (await res.json()) as ChatLog;
  },
  async send(text: string, expectedVersion: number, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { ...(await writeHeaders()), Accept: "text/event-stream" },
      body: JSON.stringify({ text, expectedVersion }),
      signal,
    });
    if (!res.ok) throw await errorBody(res);
    if (!res.body) return;
    const parser = createSseParser(onEvent);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(value);
    }
    parser.end();
  },
};
