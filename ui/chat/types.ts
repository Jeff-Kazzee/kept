// The chat contract is 7A's (src/agent/types.ts, docs/decisions/0007-case-agent.md),
// with the sprint 8 additions in ../contract.ts: the action event and the
// actions of each message. The page adds only how it reaches the chat.
import type { ChatEvent, ChatMessage } from "../contract.ts";

export type { Card, ChatErrorCode, FactChip } from "../../src/agent/types.ts";
export type { ChatEvent, ChatMessage };

// What GET /api/chat answers.
export type ChatLog = { chatVersion: number; messages: ChatMessage[] };

export const CHAT_EVENTS = new Set<ChatEvent["event"]>(["turn.started", "text.delta", "tool.started", "tool.finished", "card", "facts", "action", "turn.done", "turn.error"]);

// How the page reaches the chat: the real route, or, in a development
// build only, the scripted mock.
export type ChatTransport = {
  // "real" or "mock". The mock's assistant text is scripted by code, not a
  // model, and the page says so.
  kind: "real" | "mock";
  load(): Promise<ChatLog | null>;
  send(text: string, expectedVersion: number, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void>;
};
