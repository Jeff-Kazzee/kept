// The chat contract shared with the case agent (sprint 7A). See
// docs/decisions/0008-web-app.md. Cards hold references only. The page
// renders each card from the current case view, so a card always shows the
// live state.

export type Card =
  | { kind: "claims"; messageId: string; evidenceIds: string[] }
  | { kind: "question"; conflictId: string }
  | { kind: "reply"; draftId: string }
  | { kind: "explanation"; conflictId: string }
  | { kind: "proposal"; proposalId: string }
  | { kind: "notice"; text: string };

export type FactChip = {
  slotKey: string;
  label: string;
  stateLabel: string;
  evidenceIds: string[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  // Assistant text is model output, labeled as such on screen.
  text: string;
  createdAt: string;
  cards: Card[];
  chips: FactChip[];
  // True for the fixed scope decline.
  declined?: boolean;
};

export type ChatLog = { chatVersion: number; messages: ChatMessage[] };

export type ChatEvent =
  | { event: "turn.started"; data: { turnId: string; userMessageId: string } }
  | { event: "text.delta"; data: { turnId: string; text: string } }
  | { event: "tool.started"; data: { turnId: string; callId: string; tool: string; label: string } }
  | { event: "tool.finished"; data: { turnId: string; callId: string; ok: boolean } }
  | { event: "card"; data: { turnId: string; card: Card } }
  | { event: "facts"; data: { turnId: string; chips: FactChip[] } }
  | { event: "turn.done"; data: { turnId: string; assistantMessageId: string; chatVersion: number } }
  | { event: "turn.error"; data: { turnId: string; code: string; message: string } };

export const CHAT_EVENTS = new Set<ChatEvent["event"]>(["turn.started", "text.delta", "tool.started", "tool.finished", "card", "facts", "turn.done", "turn.error"]);

// How the page reaches the chat: the real route, or the scripted mock.
export type ChatTransport = {
  // "real" or "mock". The mock's assistant text is scripted by code, not a
  // model, and the page says so.
  kind: "real" | "mock";
  load(): Promise<ChatLog | null>;
  send(text: string, expectedVersion: number, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void>;
};
