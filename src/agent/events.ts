// The chat stream (0007, G9). Each chat message is one event on the `chat`
// stream, written with the stream's expected version and the case
// generation. Delete case erases the stream with the rest of the case, and
// a reopened app reads it back. Encrypted reasoning items and tool results
// are never stored: an assistant event keeps only the checked text, the
// card references, the chips, the tool names and the call measurements.
import type { TokenUsage } from "../model/request.ts";
import { zonedIso } from "../domain/zone.ts";
import type { StoredEvent } from "../store/event-log.ts";
import type { Card, ChatMessage, FactChip } from "./types.ts";

export const CHAT_STREAM = "chat";

// answered: model text that passed the checks. declined: the fixed scope
// decline. ungrounded: the model text failed the checks twice and code
// replaced it. stopped: a limit ended the turn. model_unavailable: a model
// call failed.
export type AssistantOutcome = "answered" | "declined" | "ungrounded" | "stopped" | "model_unavailable";

// One model call of a turn. `kind` is "loop" for the tool loop and "retry"
// for the answer retry. A failed call keeps the HTTP status and the API's
// error type and code, never its message.
export type ChatCallRecord = {
  latency_ms: number;
  first_byte_ms: number | null;
  usage: TokenUsage;
  kind?: "loop" | "retry";
  error?: { status: number | null; type: string | null; code: string | null };
};

export type ChatEventData =
  | {
      type: "chat_user_message";
      data: {
        message_id: string;
        turn_id: string;
        text: string;
        // True when the text was clinical and code saved a fixed sentence
        // in its place (G5).
        withheld: boolean;
      };
    }
  | {
      type: "chat_assistant_message";
      data: {
        message_id: string;
        turn_id: string;
        text: string;
        outcome: AssistantOutcome;
        cards: Card[];
        chips: FactChip[];
        // Each tool call with its result code, such as ok or not_from_user.
        tools: Array<{ tool: string; ok: boolean; code?: string }>;
        // Problem codes from the checks of the model's final text, attempt by
        // attempt. Never the text itself.
        problems: string[][];
        calls: ChatCallRecord[];
        // Activity entry ids of the actions taken in the turn (0009).
        // Absent in chats from before sprint 8.
        actions?: string[];
      };
    }
  | {
      // Lines of the person's message that a tool imported, written in the
      // same transaction as the import (review round 2, finding 10).
      // History sends a reference in their place.
      type: "chat_lines_imported";
      data: { turn_id: string; user_message_id: string; message_id: string; first_line: number; last_line: number };
    };

// `imported` maps a user message id to the lines its turn imported.
export type ChatLog = {
  version: number;
  messages: ChatMessage[];
  imported: Map<string, Array<{ message_id: string; first_line: number; last_line: number }>>;
};

// `zone` is the case's time zone, for the messages' times.
export function projectChat(events: StoredEvent[], zone: string): ChatLog {
  const log: ChatLog = { version: 0, messages: [], imported: new Map() };

  for (const e of events) {
    if (e.streamId !== CHAT_STREAM) continue;
    log.version = e.version;
    const event = { type: e.type, data: e.data } as ChatEventData;
    if (event.type === "chat_user_message") {
      log.messages.push({ id: event.data.message_id, role: "user", text: event.data.text, createdAt: zonedIso(e.recordedAt, zone), cards: [], chips: [], actions: [] });
    } else if (event.type === "chat_lines_imported") {
      const { user_message_id, message_id, first_line, last_line } = event.data;
      log.imported.set(user_message_id, [...(log.imported.get(user_message_id) ?? []), { message_id, first_line, last_line }]);
    } else if (event.type === "chat_assistant_message") {
      log.messages.push({
        id: event.data.message_id,
        role: "assistant",
        text: event.data.text,
        createdAt: zonedIso(e.recordedAt, zone),
        // Proposal cards from before sprint 8 are dropped.
        cards: event.data.cards.filter((c) => (c.kind as string) !== "proposal"),
        chips: event.data.chips,
        actions: event.data.actions ?? [],
        ...(event.data.outcome === "declined" ? { declined: true } : {}),
      });
    }
  }
  return log;
}
