// The chat state: a streamed turn, then the stored chat replaces it. A turn
// the server did not store stays on screen with its error.
import { describe, expect, it } from "vitest";
import { STREAM_CUT, chatReducer, initialChat, turnLost, type ChatState } from "./state.ts";
import type { ChatEvent, ChatMessage } from "./types.ts";

const ev = (e: ChatEvent) => ({ type: "event" as const, event: e });
const user: ChatMessage = { id: "u1", role: "user", text: "What is confirmed?", createdAt: "2026-11-05T09:00:00Z", cards: [], chips: [] };
const assistant: ChatMessage = { id: "a1", role: "assistant", text: "Monday.", createdAt: "2026-11-05T09:00:01Z", cards: [], chips: [] };

function streamed(): ChatState {
  let s = chatReducer(initialChat, { type: "loaded", log: { chatVersion: 3, messages: [] } });
  s = chatReducer(s, { type: "start", text: "What is confirmed?", at: "2026-11-05T09:00:00Z" });
  s = chatReducer(s, ev({ event: "turn.started", data: { turnId: "t1", userMessageId: "u1" } }));
  s = chatReducer(s, ev({ event: "tool.started", data: { turnId: "t1", callId: "c1", tool: "list_appointments", label: "Reading your schedule" } }));
  s = chatReducer(s, ev({ event: "tool.finished", data: { turnId: "t1", callId: "c1", ok: true } }));
  s = chatReducer(s, ev({ event: "text.delta", data: { turnId: "t1", text: "Mon" } }));
  s = chatReducer(s, ev({ event: "text.delta", data: { turnId: "other", text: "IGNORED" } }));
  s = chatReducer(s, ev({ event: "text.delta", data: { turnId: "t1", text: "day." } }));
  s = chatReducer(s, ev({ event: "card", data: { turnId: "t1", card: { kind: "question", conflictId: "c-1" } } }));
  s = chatReducer(s, ev({ event: "facts", data: { turnId: "t1", chips: [{ slotKey: "2026-11-16T13:00", label: "Mon 11/16 1:00 PM", stateLabel: "Confirmed · office message", evidenceIds: ["m4-e1"] }] } }));
  return s;
}

describe("chat state", () => {
  it("builds the turn from its events and ignores another turn's", () => {
    const s = streamed();
    expect(s.pending).toMatchObject({
      turnId: "t1",
      userMessageId: "u1",
      text: "Monday.",
      tools: [{ callId: "c1", label: "Reading your schedule", ok: true }],
      cards: [{ kind: "question", conflictId: "c-1" }],
      status: "streaming",
    });
    expect(s.pending!.chips).toHaveLength(1);
  });

  it("replaces the streamed turn with the stored chat once it is stored", () => {
    let s = chatReducer(streamed(), ev({ event: "turn.done", data: { turnId: "t1", assistantMessageId: "a1", chatVersion: 4 } }));
    s = chatReducer(s, { type: "settled", log: { chatVersion: 4, messages: [user, assistant] } });
    expect(s.pending).toBeNull();
    expect(s.chatVersion).toBe(4);
    expect(s.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("keeps a turn that was not stored, with its error, and marks it lost", () => {
    let s = chatReducer(streamed(), ev({ event: "turn.error", data: { turnId: "t1", code: "model_unavailable", message: "The model did not answer. Nothing was saved." } }));
    s = chatReducer(s, { type: "settled", log: { chatVersion: 3, messages: [] } });
    expect(s.pending).toMatchObject({ status: "ended", error: { code: "model_unavailable" } });
    expect(turnLost(s.pending)).toBe(true);
  });

  it("says the answer stopped when the stream ends with no done or error", () => {
    const s = chatReducer(streamed(), { type: "settled", log: { chatVersion: 3, messages: [] } });
    expect(s.pending!.error).toEqual({ code: "stream_cut", message: STREAM_CUT });
  });

  it("a decline keeps the person's words in memory for the import sheet, and is not lost", () => {
    let s = chatReducer(streamed(), ev({ event: "turn.error", data: { turnId: "t1", code: "out_of_scope", message: "This app only handles appointment times." } }));
    // turn.done follows, so the turn is still streaming.
    expect(s.pending!.status).toBe("streaming");
    expect(s.declinedText).toEqual({ u1: "What is confirmed?" });
    s = chatReducer(s, ev({ event: "turn.done", data: { turnId: "t1", assistantMessageId: "a1", chatVersion: 4 } }));
    // Not lost before the stored chat is read, even though it has an error.
    expect(turnLost(s.pending)).toBe(false);
    s = chatReducer(s, { type: "settled", log: { chatVersion: 4, messages: [{ ...user, text: "Not saved: this message asked about health, which this app does not handle." }, { ...assistant, declined: true }] } });
    expect(s.pending).toBeNull();
    expect(s.declinedText.u1).toBe("What is confirmed?");
  });

  it("a server_error with no turn.done ends the turn, and it is lost", () => {
    const s = chatReducer(streamed(), ev({ event: "turn.error", data: { turnId: "t1", code: "server_error", message: "The app could not finish that answer." } }));
    expect(s.pending!.status).toBe("ended");
    expect(turnLost(chatReducer(s, { type: "settled", log: { chatVersion: 3, messages: [] } }).pending)).toBe(true);
  });

  it("marks the chat unavailable when the route is missing", () => {
    expect(chatReducer(initialChat, { type: "loaded", log: null }).status).toBe("unavailable");
  });
});
