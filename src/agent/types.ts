// The chat contract shared with the web app (0007). Cards hold references
// only: the page renders each one from the current case view, so a card
// always shows the live state, and an action on it uses the existing route
// with that entity's expected version. Runs in the browser and in Node, so
// it must not import Node modules.

export type Card =
  | { kind: "claims"; messageId: string; evidenceIds: string[] } // review each claim
  | { kind: "question"; conflictId: string } // the current question
  | { kind: "reply"; draftId: string } // readback and approve
  | { kind: "explanation"; conflictId: string } // checked explanation
  | { kind: "proposal"; proposalId: string } // from an agent grant
  | { kind: "notice"; text: string }; // code-written

export type FactChip = {
  slotKey: string; // "2026-11-16T13:00"
  label: string; // "Mon 11/16 1:00 PM"
  stateLabel: string; // "Requested · reported by you"
  evidenceIds: string[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  // Assistant text is model output that passed the code checks, or a fixed
  // sentence written by code. The page labels it.
  text: string;
  createdAt: string; // ISO with the America/Denver offset
  cards: Card[];
  chips: FactChip[];
  // True for the fixed scope decline.
  declined?: boolean;
};

export type ChatView = { chatVersion: number; messages: ChatMessage[] };

export const CHAT_ERROR_CODES = [
  "out_of_scope",
  "case_deleted",
  "stale_edit",
  "busy",
  "model_unavailable",
  "ungrounded",
  "invalid_request",
  "server_error",
] as const;
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

// The events of POST /api/chat, in the order a turn can send them.
export type ChatEvent =
  | { event: "turn.started"; data: { turnId: string; userMessageId: string } }
  | { event: "tool.started"; data: { turnId: string; callId: string; tool: string; label: string } }
  | { event: "tool.finished"; data: { turnId: string; callId: string; ok: boolean } }
  | { event: "card"; data: { turnId: string; card: Card } }
  | { event: "facts"; data: { turnId: string; chips: FactChip[] } }
  | { event: "text.delta"; data: { turnId: string; text: string } }
  | { event: "turn.error"; data: { turnId: string; code: ChatErrorCode; message: string } }
  | { event: "turn.done"; data: { turnId: string; assistantMessageId: string; chatVersion: number } };

// Fixed sentences. Code writes them, never the model.
export const UNGROUNDED_TEXT =
  "I could not check that answer against your case, so I left it out. The schedule panel shows each appointment with its source.";
export const MODEL_UNAVAILABLE_TEXT = "The assistant could not answer just now. Nothing in your case changed. Try again in a moment.";
export const TOOL_LIMIT_TEXT = "I stopped after the step limit for one answer. Nothing in your case changed. Ask again with one thing at a time.";
export const MALFORMED_TEXT = "I could not finish that request. Nothing in your case changed. Try asking another way.";
export const TOKEN_LIMIT_TEXT = "That answer grew too long, so I stopped. Nothing in your case changed. Ask again with one thing at a time.";
// A turn that stopped after a tool already wrote something, such as an
// imported message or a draft (finding 11).
export const PARTIAL_TEXT = "I stopped before finishing. Check the cards above.";
export const PARTIAL_ERROR_TEXT = "The assistant stopped before finishing. Check the cards above, then reload the chat.";
// Shown beside source fields of a pasted message that the assistant
// suggested (E1).
export const SOURCE_SUGGESTED_LABEL = "Source suggested by the assistant";
export const QUESTION_WITHHELD_NOTICE = "The question's wording did not pass the chat checks. Answer it in the schedule panel.";
export const DRAFT_OPEN_NOTICE = "A reply draft is already open. Finish or discard it before starting another.";
export const WITHHELD_USER_TEXT = "Not saved: this message asked about health, which this app does not handle.";
