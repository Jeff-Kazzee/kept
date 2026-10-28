// The chat stream (0007, G9). Each chat message is one event on the `chat`
// stream, written with the stream's expected version and the case
// generation. Delete case erases the stream with the rest of the case, and
// a reopened app reads it back. Encrypted reasoning items and tool results
// are never stored: an assistant event keeps only the checked text, the
// card references, the chips, the tool names and the call measurements.
import type { TokenUsage } from "../model/request.ts";
import { CASE_TIME_ZONE } from "../slots/clash.ts";
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

export function projectChat(events: StoredEvent[]): ChatLog {
  const log: ChatLog = { version: 0, messages: [], imported: new Map() };

  for (const e of events) {
    if (e.streamId !== CHAT_STREAM) continue;
    log.version = e.version;
    const event = { type: e.type, data: e.data } as ChatEventData;
    if (event.type === "chat_user_message") {
      log.messages.push({ id: event.data.message_id, role: "user", text: event.data.text, createdAt: caseIso(e.recordedAt), cards: [], chips: [] });
    } else if (event.type === "chat_lines_imported") {
      const { user_message_id, message_id, first_line, last_line } = event.data;
      log.imported.set(user_message_id, [...(log.imported.get(user_message_id) ?? []), { message_id, first_line, last_line }]);
    } else if (event.type === "chat_assistant_message") {
      log.messages.push({
        id: event.data.message_id,
        role: "assistant",
        text: event.data.text,
        createdAt: caseIso(e.recordedAt),
        cards: event.data.cards,
        chips: event.data.chips,
        ...(event.data.outcome === "declined" ? { declined: true } : {}),
      });
    }
  }
  return log;
}

// An instant written with the America/Denver offset of that instant, so
// times before and after the 2026-11-01 change carry -06:00 and -07:00.
export function caseIso(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CASE_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const local = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")), Number(get("hour")), Number(get("minute")), Number(get("second")));
  const offsetMin = Math.round((local - Math.floor(ms / 1000) * 1000) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const millis = pad(new Date(ms).getUTCMilliseconds(), 3);
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}.${millis}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
