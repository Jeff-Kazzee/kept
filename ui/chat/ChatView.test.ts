// The chat thread as the user sees it. Assistant text is labeled as model
// output, the decline has its own style, user and model text is never
// markup, cards render from the live case and errors say nothing was saved.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../api.ts";
import { ChatView, turnErrorText, type ChatViewProps } from "./ChatView.tsx";
import type { ChatState } from "./state.ts";

const state = {
  messages: [],
  evidence: [],
  proposals: [],
  records: [],
  case: { slots: [], conflicts: [], question: null, staleEvidenceIds: [], reply: { draft: null, sent: [], options: [], withheld: [], suggestion: null, version: 0 } },
} as unknown as AppState;

const render = (partial: Omit<ChatState, "declinedText"> & Partial<Pick<ChatState, "declinedText">>, extra: Partial<ChatViewProps> = {}) => {
  const chat: ChatState = { declinedText: {}, ...partial };
  return (
  renderToStaticMarkup(
    createElement(ChatView, {
      state,
      run: async () => {},
      chat,
      streaming: chat.pending?.status === "streaming",
      scripted: false,
      send: async () => {},
      onShowSlot: () => {},
      onLoadCalendar: async () => {},
      onLoadDemo: async () => null,
      fixtures: [],
      ...extra,
    }),
  ).replaceAll("&#x27;", "'"));
};

const at = "2026-11-01T08:30:00.000Z";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chat view", () => {
  it("an empty chat offers the three ways to start", () => {
    const html = render({ status: "ready", chatVersion: 0, messages: [], pending: null });
    for (const s of ["Paste a message from the office", "What is confirmed?", "Load the demo"]) expect(html).toContain(s);
    expect(html).toContain('id="chat-input"');
    expect(html).toContain('name="message"');
    expect(html).toContain('<label for="chat-input" class="sr-only">Message</label>');
  });

  it("says the chat is not available when the route is missing, and disables the composer", () => {
    const html = render({ status: "unavailable", chatVersion: 0, messages: [], pending: null });
    expect(html).toContain("The chat is not available in this build yet.");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });

  it("review 1, finding 1: a production build does not point to the scripted chat it does not have", () => {
    vi.stubEnv("DEV", false);
    const prod = render({ status: "unavailable", chatVersion: 0, messages: [], pending: null });
    expect(prod).toContain("The chat is not available in this build yet.");
    expect(prod).not.toContain("mockchat");
    vi.stubEnv("DEV", true);
    expect(render({ status: "unavailable", chatVersion: 0, messages: [], pending: null })).toContain("?mockchat=1");
  });

  it("labels assistant text as model output, shows the decline in its own style, and never renders text as markup", () => {
    const html = render({
      status: "ready",
      chatVersion: 2,
      pending: null,
      messages: [
        { id: "u1", role: "user", text: "Hi <img src=x onerror=alert(1)>\nsecond line", createdAt: at, cards: [], chips: [] },
        { id: "a1", role: "assistant", text: "Monday is <b>confirmed</b>.", createdAt: at, cards: [{ kind: "notice", text: "See the Checklist tab." }], chips: [{ slotKey: "2026-11-16T13:00", label: "Monday 11/16 1:00 PM", stateLabel: "Confirmed · office message", evidenceIds: ["m4-e1"] }] },
        { id: "u2", role: "user", text: "Which dose?", createdAt: at, cards: [], chips: [] },
        { id: "a2", role: "assistant", text: "This app only handles appointment times.", createdAt: at, cards: [], chips: [], declined: true },
      ],
    });
    expect(html).toContain('<span class="model-tag">Model output</span>');
    expect(html).toContain("Hi &lt;img src=x onerror=alert(1)&gt;\nsecond line");
    expect(html).toContain("Monday is &lt;b&gt;confirmed&lt;/b&gt;.");
    expect(html).not.toContain("<img");
    expect(html).toContain("Outside this app's scope");
    expect(html).toContain(" Add this as an office message</button>");
    // The slot is not in this case view, so the chip says it is gone.
    expect(html).toContain("No longer on your schedule");
    expect(html).toContain("At the time: Confirmed · office message");
    expect(html).toContain("See the Checklist tab.");
    // The 2026-11-01 08:30 UTC instant is 01:30 MST, after the change.
    expect(html).toContain("Sun, Nov 1, 1:30 AM MST");
  });

  it("the scripted chat labels its text as scripted, not a model", () => {
    const html = render({ status: "ready", chatVersion: 1, pending: null, messages: [{ id: "a1", role: "assistant", text: "Hello.", createdAt: at, cards: [], chips: [] }] }, { scripted: true });
    expect(html).toContain("Scripted demo reply, not a model");
    expect(html).not.toContain(">Model output<");
  });

  it("shows the tool line and typing while a turn streams, and a plain error when it fails", () => {
    const streaming = render({
      status: "ready",
      chatVersion: 1,
      messages: [],
      pending: { turnId: "t1", userMessageId: "u1", userText: "What is confirmed?", createdAt: at, text: "", tools: [{ callId: "c1", label: "Reading your schedule", ok: null }], cards: [], chips: [], status: "streaming", error: null, unsaved: false },
    });
    expect(streaming).toContain("Reading your schedule");
    expect(streaming).toContain('aria-label="The assistant is typing"');
    const failed = render({
      status: "ready",
      chatVersion: 1,
      messages: [],
      pending: { turnId: "t1", userMessageId: "u1", userText: "What is confirmed?", createdAt: at, text: "", tools: [], cards: [], chips: [], status: "ended", error: { code: "busy", message: "" }, unsaved: true },
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The app is busy. Nothing was saved. Try again in a moment.");
    expect(turnErrorText({ code: "model_unavailable", message: "The model did not answer." })).toBe("The model did not answer. Nothing was saved.");
    expect(turnErrorText({ code: "server_error", message: "" })).toBe("The app could not finish that answer. Nothing was saved.");
    expect(turnErrorText({ code: "ungrounded", message: "Check your schedule for the current state." })).toBe("Check your schedule for the current state.");
  });

  it("a pending decline shows its streamed text once, with the way to add it as an office message", () => {
    const html = render({
      status: "ready",
      chatVersion: 1,
      messages: [],
      pending: { turnId: "t1", userMessageId: "u1", userText: "Please bring your lab results.", createdAt: at, text: "This app only handles appointment times.", tools: [], cards: [], chips: [], status: "streaming", error: { code: "out_of_scope", message: "This app only handles appointment times." }, unsaved: false },
    });
    expect(html.split('<div class="sr-only" aria-live')[0]!.split("This app only handles appointment times.").length - 1).toBe(1);
    expect(html).toContain(" Add this as an office message</button>");
  });

  it("an ungrounded turn shows its fixed sentence once, as a notice", () => {
    const text = "I could not check that answer against your case, so I left it out.";
    const html = render({
      status: "ready",
      chatVersion: 1,
      messages: [],
      pending: { turnId: "t1", userMessageId: "u1", userText: "Is Monday on?", createdAt: at, text, tools: [], cards: [], chips: [], status: "ended", error: { code: "ungrounded", message: text }, unsaved: false },
    });
    const thread = html.split('<div class="sr-only" aria-live')[0]!;
    expect(thread.split(text).length - 1).toBe(1);
    expect(html).not.toContain('role="alert"');
  });

  it("the composer offers Add an office message at any time", () => {
    const html = render({ status: "ready", chatVersion: 0, messages: [], pending: null });
    expect(html).toContain('aria-label="Add an office message"');
  });

  it("review 1, finding 2: a fact chip shows the slot as it is now, and a gone or archived slot as no longer on the schedule", () => {
    const slot = (key: string, label: string, stateLabel: string) => ({ key, label, stateLabel });
    const live = {
      ...state,
      case: { ...state.case, slots: [slot("2026-11-12T10:30", "Thursday 11/12 10:30 AM", "Canceled · office message"), slot("2026-11-10T14:00", "Tuesday 11/10 2:00 PM", "Offered · office message")] },
      records: [{ id: "2026-11-10T14:00", archived: true }],
    } as unknown as AppState;
    const chip = (slotKey: string, stateLabel: string) => ({ slotKey, label: "old label", stateLabel, evidenceIds: [] });
    const html = render(
      {
        status: "ready",
        chatVersion: 1,
        pending: null,
        messages: [{ id: "a1", role: "assistant", text: "Here.", createdAt: at, cards: [], chips: [chip("2026-11-12T10:30", "Confirmed · office message"), chip("2026-11-10T14:00", "Offered · office message"), chip("2026-11-20T09:00", "Offered · office message")] }],
      },
      { state: live },
    );
    // Live label and state, with the old state as a muted line.
    expect(html).toContain('aria-label="Thursday 11/12 10:30 AM: Canceled · office message. Show in schedule."');
    expect(html).toContain('<small class="muted">At the time: Confirmed · office message</small>');
    expect(html).not.toContain(">Confirmed · office message</small><small");
    // Archived and missing slots: disabled, said plainly.
    expect(html.match(/<button type="button" class="chip fact-chip" disabled=""/g)).toHaveLength(2);
    expect(html.split("No longer on your schedule").length - 1).toBe(2);
  });
});
