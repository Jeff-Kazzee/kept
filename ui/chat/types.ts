// The chat contract is 7A's (src/agent/types.ts, docs/decisions/0007-case-agent.md).
// The page uses those types and fixed sentences as they are, and adds only
// how it reaches the chat.
import type { ChatEvent, ChatView } from "../../src/agent/types.ts";

export type { Card, ChatErrorCode, ChatEvent, ChatMessage, FactChip } from "../../src/agent/types.ts";

// What GET /api/chat answers.
export type ChatLog = ChatView;

export const CHAT_EVENTS = new Set<ChatEvent["event"]>(["turn.started", "text.delta", "tool.started", "tool.finished", "card", "facts", "turn.done", "turn.error"]);

// How the page reaches the chat: the real route, or, in a development
// build only, the scripted mock.
export type ChatTransport = {
  // "real" or "mock". The mock's assistant text is scripted by code, not a
  // model, and the page says so.
  kind: "real" | "mock";
  load(): Promise<ChatLog | null>;
  send(text: string, expectedVersion: number, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void>;
};
