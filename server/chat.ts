// The chat routes (0007). Kept free of sockets so tests can call them: the
// server hands each request to `serve` with a sink that writes JSON or
// server-sent events. The paired session, the same-origin check and the
// JSON content type are checked by the server before this runs, as for
// every /api route.
//
// POST /api/chat  { text, expectedVersion } with the case generation header.
//   A body that fails validation, or a missing generation, gets a JSON
//   error. Otherwise the answer is text/event-stream and every outcome,
//   failures included, is an event (see src/agent/types.ts).
// GET /api/chat   { chatVersion, messages }
import { z } from "zod";
import { MAX_CHAT_CHARS, type CaseAgent } from "../src/agent/agent.ts";
import type { ChatEvent } from "../src/agent/types.ts";

export const CHAT_PATH = "/api/chat";

const ChatBody = z
  .object({
    text: z.string().max(MAX_CHAT_CHARS).refine((t) => t.trim().length > 0, "The message is empty."),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ChatSink = {
  json(status: number, body: unknown): void;
  // Starts the event stream on the first event.
  event(event: ChatEvent): void;
  end(): void;
};

export type ChatRequest = { method: string; body: unknown; generation?: number };

export function createChat(agent: CaseAgent) {
  return {
    async serve(req: ChatRequest, sink: ChatSink): Promise<void> {
      if (req.method === "GET") return sink.json(200, agent.chat());
      if (req.method !== "POST") return sink.json(405, { error: "method_not_allowed" });
      if (!(Number.isSafeInteger(req.generation) && req.generation! >= 0)) {
        return sink.json(400, {
          error: "generation_required",
          message: "This request does not say which case it was made for. Reload the page and try again. Nothing was saved.",
        });
      }
      const parsed = ChatBody.safeParse(req.body);
      if (!parsed.success) {
        return sink.json(400, { error: "invalid_body", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      }
      await agent.turn({ text: parsed.data.text, expectedVersion: parsed.data.expectedVersion, generation: req.generation! }, (e) => sink.event(e));
      sink.end();
    },
  };
}

// One event in server-sent event form.
export function sseFrame(e: ChatEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}
