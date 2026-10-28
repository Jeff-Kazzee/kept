// The chat as the page holds it: the stored messages, and the turn being
// streamed. The answer's text is held by the server until it passes the
// checks, so text.delta events can come in a burst at the end, after the
// tool and card events (0007, C1 and C4). The streamed turn is shown as it arrives. When it ends, the page
// reads the stored chat again, and the stored messages replace it. A turn
// the server did not store stays on screen with its error, so the user sees
// what happened and that nothing was saved.
import type { ActivityEntry } from "../contract.ts";
import type { Card, ChatEvent, ChatLog, ChatMessage, FactChip } from "./types.ts";

export type ToolLine = { callId: string; label: string; ok: boolean | null };

export type PendingTurn = {
  turnId: string | null;
  userMessageId: string | null;
  userText: string;
  createdAt: string;
  text: string;
  tools: ToolLine[];
  cards: Card[];
  chips: FactChip[];
  // What the agent did during the turn, as the action events said.
  actions: ActivityEntry[];
  assistantMessageId: string | null;
  status: "streaming" | "ended";
  error: { code: string; message: string } | null;
  // True once the page read the stored chat after the turn and found the
  // turn was not stored.
  unsaved: boolean;
};

export type ChatState = {
  status: "loading" | "ready" | "unavailable";
  chatVersion: number;
  messages: ChatMessage[];
  pending: PendingTurn | null;
  // The words of a message the chat declined, by user message id. The
  // server stores a fixed sentence in their place (0007, C2), so this page
  // keeps them, in memory only, for "Add this as an office message".
  declinedText: Record<string, string>;
  // The tool lines of each answer this page streamed, by assistant message
  // id, so a stored answer keeps its one-line summary. Memory only.
  toolsByMessage: Record<string, ToolLine[]>;
};

export type ChatAction =
  | { type: "loaded"; log: ChatLog | null }
  | { type: "start"; text: string; at: string }
  | { type: "event"; event: ChatEvent }
  | { type: "failed"; code: string; message: string }
  | { type: "settled"; log: ChatLog | null }
  | { type: "dismiss" };

export const initialChat: ChatState = { status: "loading", chatVersion: 0, messages: [], pending: null, declinedText: {}, toolsByMessage: {} };

// Codes whose turn still stores an answer: the text.delta events carry a
// fixed sentence written by code, and turn.done follows.
export const FIXED_TEXT_CODES = new Set(["out_of_scope", "ungrounded", "model_unavailable"]);

// A stream that ends with no turn.done and no turn.error.
export const STREAM_CUT = "The answer stopped before it finished. Nothing was saved.";

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "loaded":
      if (action.log === null) return { ...state, status: "unavailable", messages: [], chatVersion: 0 };
      // A load while a turn streams keeps the turn on screen.
      return { ...state, status: "ready", chatVersion: action.log.chatVersion, messages: action.log.messages };
    case "start":
      return {
        ...state,
        pending: { turnId: null, userMessageId: null, userText: action.text, createdAt: action.at, text: "", tools: [], cards: [], chips: [], actions: [], assistantMessageId: null, status: "streaming", error: null, unsaved: false },
      };
    case "event": {
      const p = state.pending;
      if (!p) return state;
      const e = action.event;
      // Events of another turn are not this page's.
      if (e.event !== "turn.started" && p.turnId !== null && e.data.turnId !== p.turnId) return state;
      switch (e.event) {
        case "turn.started":
          return { ...state, pending: { ...p, turnId: e.data.turnId, userMessageId: e.data.userMessageId } };
        case "text.delta":
          return { ...state, pending: { ...p, text: p.text + e.data.text } };
        case "tool.started":
          return { ...state, pending: { ...p, tools: [...p.tools, { callId: e.data.callId, label: e.data.label, ok: null }] } };
        case "tool.finished":
          return { ...state, pending: { ...p, tools: p.tools.map((t) => (t.callId === e.data.callId ? { ...t, ok: e.data.ok } : t)) } };
        case "card":
          return { ...state, pending: { ...p, cards: [...p.cards, e.data.card] } };
        case "facts":
          return { ...state, pending: { ...p, chips: [...p.chips, ...e.data.chips] } };
        case "action":
          return { ...state, pending: { ...p, actions: [...p.actions.filter((a) => a.id !== e.data.entry.id), e.data.entry] } };
        case "turn.done": {
          const toolsByMessage = p.tools.length > 0 ? { ...state.toolsByMessage, [e.data.assistantMessageId]: p.tools } : state.toolsByMessage;
          return { ...state, toolsByMessage, chatVersion: Math.max(state.chatVersion, e.data.chatVersion), pending: { ...p, status: "ended", assistantMessageId: e.data.assistantMessageId } };
        }
        case "turn.error": {
          const declinedText = e.data.code === "out_of_scope" && p.userMessageId !== null ? { ...state.declinedText, [p.userMessageId]: p.userText } : state.declinedText;
          // A code whose turn.done follows leaves the turn streaming until then.
          const status = FIXED_TEXT_CODES.has(e.data.code) ? p.status : "ended";
          return { ...state, declinedText, pending: { ...p, status, error: { code: e.data.code, message: e.data.message } } };
        }
      }
      return state;
    }
    case "failed":
      return state.pending ? { ...state, pending: { ...state.pending, status: "ended", error: { code: action.code, message: action.message } } } : state;
    case "settled": {
      const p = state.pending;
      const next = action.log === null ? state : { ...state, status: "ready" as const, chatVersion: action.log.chatVersion, messages: action.log.messages };
      if (!p) return next;
      const stored = p.userMessageId !== null && next.messages.some((m) => m.id === p.userMessageId);
      if (stored) return { ...next, pending: null };
      return { ...next, pending: { ...p, status: "ended", unsaved: true, error: p.error ?? { code: "stream_cut", message: STREAM_CUT } } };
    }
    case "dismiss":
      return { ...state, pending: null };
  }
}

// True when the turn was not stored and the user's text should go back into
// the composer. A decline is not lost: the import sheet takes its words.
export const turnLost = (p: PendingTurn | null) => p !== null && p.unsaved && p.error !== null && p.error.code !== "out_of_scope";
