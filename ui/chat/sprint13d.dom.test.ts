// Sprint 13D, E3 (0017): a finished answer is in view, and a facts card
// already in the chat is not shown again in full.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState } from "../api.ts";
import { installTestDom, TestElement, type TestDocument } from "../test-dom.ts";
import { ChatView, factsCards, followTop, type ChatViewProps } from "./ChatView.tsx";
import type { ChatState } from "./state.ts";
import type { ChatMessage } from "./types.ts";
import { PARTIAL_TEXT } from "../../src/agent/types.ts";

beforeAll(() => {
  installTestDom();
});

const at = "2026-11-01T08:30:00.000Z";
const MSG = "gmail-1";
const state = {
  messages: [
    {
      id: MSG,
      version: 2,
      status: "extracted",
      sourceType: "office_message",
      importedFrom: "gmail",
      ownReport: "none",
      sourceNote: null,
      sourceSuggested: [],
      evidenceIds: ["gmail-1-e1"],
      manualEvidenceIds: [],
      rejections: [],
      message: { id: MSG, channel: "email", from: "Lantern Hill Clinic <front@lanternhill.example>", received_at: at, text: "x" },
    },
  ],
  evidence: [
    {
      id: "gmail-1-e1",
      version: 1,
      status: "pending",
      messageId: MSG,
      claim: { claim_type: "offer", slot: { date: "2026-11-16", time: "13:00", location: null }, quote: "We can offer Monday.", source_type: "office_message" },
    },
  ],
  proposals: [],
  records: [],
  case: { slots: [], conflicts: [], question: null, staleEvidenceIds: [], reply: { draft: null, sent: [], options: [], withheld: [], suggestion: null, version: 0 } },
} as unknown as AppState;

const answer = (id: string, text: string, cards: ChatMessage["cards"] = []): ChatMessage => ({ id, actions: [], role: "assistant", text, createdAt: at, cards, chips: [] }) as ChatMessage;
const question = (id: string, text: string): ChatMessage => ({ id, actions: [], role: "user", text, createdAt: at, cards: [], chips: [] }) as ChatMessage;
const claims = { kind: "claims" as const, messageId: MSG, evidenceIds: ["gmail-1-e1"] };

const props = (chat: ChatState): ChatViewProps => ({
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
});

const chatOf = (messages: ChatMessage[], pending: ChatState["pending"] = null): ChatState => ({ status: "ready", chatVersion: messages.length, messages, pending, declinedText: {}, toolsByMessage: {} });

// A layout for the test DOM: the thread is 600 px tall and holds 2000 px,
// and the last assistant answer starts 900 px into it.
const layout = { height: 2000, answerAt: 900 };
const rect = (top: number) => ({ top, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
const proto = TestElement.prototype as unknown as Record<string, unknown>;
const saved = Object.getOwnPropertyDescriptor(TestElement.prototype, "getBoundingClientRect")!;

function installLayout() {
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => layout.height });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value(this: TestElement) {
      const thread = this.closest(".thread");
      if (this.getAttribute("class") === "thread") return rect(0);
      // Positions are relative to the thread's top, less its scroll.
      return rect(this.localName === "article" && thread ? layout.answerAt - (thread as unknown as { scrollTop: number }).scrollTop : 0);
    },
  });
}

afterEach(() => {
  layout.answerAt = 900;
  delete proto.scrollHeight;
  delete proto.clientHeight;
  Object.defineProperty(TestElement.prototype, "getBoundingClientRect", saved);
});

async function mountChat(chat: ChatState) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const doc = document as unknown as TestDocument;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(ChatView, props(chat))));
  const thread = container.querySelector(".thread")! as unknown as TestElement & { scrollTop: number };
  return {
    container,
    thread,
    async rerender(next: ChatState) {
      await act(async () => root.render(createElement(ChatView, props(next))));
    },
    async scroll(top: number) {
      await act(async () => {
        thread.scrollTop = top;
        thread.dispatchEvent(new (globalThis as unknown as { Event: new (t: string, i: object) => Event }).Event("scroll", { bubbles: false }) as never);
      });
    },
    async unmount() {
      await act(async () => root.unmount());
      container.parentNode?.removeChild(container);
    },
  };
}

const streaming = (text: string): ChatState["pending"] => ({
  turnId: "t1",
  userMessageId: null,
  userText: "Does Monday clash?",
  createdAt: at,
  text,
  tools: [],
  cards: [],
  chips: [],
  actions: [],
  assistantMessageId: null,
  status: "streaming",
  error: null,
  unsaved: false,
});

describe("sprint 13D, E3: a finished answer is in view", () => {
  it("follows the end while the turn streams, and when it ends stops where the answer starts", async () => {
    installLayout();
    const before = [question("u1", "Hi"), answer("a1", "Hello.")];
    const view = await mountChat(chatOf(before, streaming("Yes. Monday")));
    expect(view.thread.scrollTop).toBe(1400);
    // The turn ends with a tall card after the words.
    await view.rerender(chatOf([...before, question("u2", "Does Monday clash?"), answer("a2", "Yes. Monday clashes with Team standup.", [claims])]));
    expect(view.thread.scrollTop).toBe(900 - 12);
    await view.unmount();
  });

  it("a short answer that fits stays at the end", async () => {
    installLayout();
    layout.answerAt = 1700;
    const view = await mountChat(chatOf([question("u1", "Hi"), answer("a1", "Hello.")]));
    expect(view.thread.scrollTop).toBe(1400);
    await view.unmount();
  });

  it("when the person scrolled away while it streamed, the view stays and offers the new messages", async () => {
    installLayout();
    const before = [question("u1", "Hi"), answer("a1", "Hello.")];
    const view = await mountChat(chatOf(before, streaming("Yes")));
    await view.scroll(200);
    await view.rerender(chatOf([...before, question("u2", "Does Monday clash?"), answer("a2", "Yes.", [claims])]));
    expect(view.thread.scrollTop).toBe(200);
    expect(view.container.textContent).toContain("New messages");
    await view.unmount();
  });

  it("the stop point is the end while streaming, and never past the answer's start after", () => {
    installLayout();
    const doc = document as unknown as TestDocument;
    const thread = doc.createElement("div");
    thread.setAttribute("class", "thread");
    const article = doc.createElement("article");
    article.setAttribute("class", "msg msg-assistant");
    thread.appendChild(article);
    doc.body.appendChild(thread);
    expect(followTop(thread as unknown as HTMLElement, true)).toBe(1400);
    expect(followTop(thread as unknown as HTMLElement, false)).toBe(888);
    thread.parentNode?.removeChild(thread);
  });
});

describe("sprint 13D, E3: one full facts card per office message", () => {
  it("a later answer with the same facts card shows a line that points to the first", async () => {
    const messages = [
      question("u1", "Import the email"),
      answer("a1", "I added the email.", [claims]),
      question("u2", "Does Monday clash?"),
      answer("a2", "Yes. Monday clashes with Team standup.", [claims]),
      question("u3", "Does Monday clash?"),
      answer("a3", "Yes, it still does.", [claims]),
    ];
    const view = await mountChat(chatOf(messages));
    const text = view.container.textContent;
    expect(view.container.querySelectorAll("section.claims")).toHaveLength(1);
    expect(text.match(/The facts from Lantern Hill Clinic are in the card above\./g)).toHaveLength(2);
    expect(text).toContain("1 waits for you there.");
    // Accept and Reject show once, on the first card.
    expect(view.container.querySelectorAll("button").filter((b) => b.textContent.trim() === "Accept")).toHaveLength(1);
    // Fix round 1, R6: the card's heading carries the anchor.
    const heading = view.container.querySelector("section.claims .card-title")!;
    expect([heading.getAttribute("id"), heading.getAttribute("tabindex")]).toEqual(["facts-1", "-1"]);
    await view.unmount();
  });

  it("Show the card scrolls to the first card's heading and moves focus there (fix round 1, R6)", async () => {
    const scrolled: string[] = [];
    const spy = vi.spyOn(TestElement.prototype, "scrollIntoView").mockImplementation(function (this: TestElement) {
      scrolled.push(this.getAttribute("id") ?? "");
    });
    const view = await mountChat(chatOf([answer("a1", "Added.", [claims]), question("u2", "Does Monday clash?"), answer("a2", "Yes.", [claims])]));
    const show = view.container.querySelectorAll("button").find((b) => b.textContent.trim() === "Show the card")!;
    const { act } = await import("react");
    await act(async () => show.click());
    const heading = view.container.querySelector("#facts-1")!;
    expect(scrolled).toEqual(["facts-1"]);
    expect(document.activeElement).toBe(heading);
    expect(heading.textContent).toBe("Facts from Lantern Hill Clinic");
    spy.mockRestore();
    await view.unmount();
  });

  it("the same office message added twice through the import sheet keeps one card, and the pointer finds it (fix round 1, R5)", () => {
    const plan = factsCards(
      [
        { messageId: MSG, after: 0 },
        { messageId: MSG, after: 0 },
      ],
      { messages: [answer("a1", "x", [claims])], pending: null },
    );
    expect(plan.get(`import:${MSG}`)).toEqual({ anchor: "facts-1", repeat: false });
    expect(plan.get("a1:0")).toEqual({ anchor: "facts-1", repeat: true });
  });

  it("the first card of each message keeps its place, the streamed turn included", () => {
    const other = { kind: "claims" as const, messageId: "gmail-2", evidenceIds: [] };
    const plan = factsCards([{ messageId: "gmail-2", after: 1 }], {
      messages: [answer("a1", "x", [claims]), answer("a2", "y", [other, claims])],
      pending: { ...streaming(""), cards: [other] } as ChatState["pending"],
    });
    expect([...plan.entries()]).toEqual([
      ["a1:0", { anchor: "facts-1", repeat: false }],
      ["import:gmail-2", { anchor: "facts-2", repeat: false }],
      ["a2:0", { anchor: "facts-2", repeat: true }],
      ["a2:1", { anchor: "facts-1", repeat: true }],
      ["pending:0", { anchor: "facts-2", repeat: true }],
    ]);
  });
});

describe("sprint 13D, E6: the page shows each thing once and never the account's name for a moment", () => {
  it("a stopped turn's sentence shows once, stored or streamed", async () => {
    const stored = answer("a1", PARTIAL_TEXT, [{ kind: "notice", text: PARTIAL_TEXT }]);
    const view = await mountChat(chatOf([question("u1", "Accept the facts"), stored]));
    expect(view.container.textContent.split(PARTIAL_TEXT)).toHaveLength(2);
    await view.rerender(chatOf([question("u1", "Accept the facts")], { ...streaming(PARTIAL_TEXT)!, status: "ended", cards: [{ kind: "notice", text: PARTIAL_TEXT }] }));
    expect(view.container.textContent.split(PARTIAL_TEXT)).toHaveLength(2);
    await view.unmount();
  });

  it("another notice of the same turn still shows", async () => {
    const stored = answer("a1", PARTIAL_TEXT, [{ kind: "notice", text: "Added Monday 11/16 1:00 PM to Google Calendar as tentative." }]);
    const view = await mountChat(chatOf([stored]));
    expect(view.container.textContent).toContain("Added Monday 11/16 1:00 PM to Google Calendar as tentative.");
    await view.unmount();
  });

  it("an email whose place waits for review is from the office, not from its account's name", async () => {
    const lower = { ...state, messages: [{ ...state.messages[0]!, message: { ...state.messages[0]!.message, from: "lantern hill <front@lanternhill.example>" } }] } as AppState;
    const withPlace = { ...lower, evidence: [{ ...lower.evidence[0]!, claim: { ...lower.evidence[0]!.claim, slot: { date: "2026-11-16", time: "13:00", location: "Lantern Hill Clinic, 400 Elm Street" } } }] } as AppState;
    const html = (st: AppState) => renderToStaticMarkup(createElement(ChatView, { ...props(chatOf([answer("a1", "Added.", [claims])])), state: st }));
    expect(html(withPlace)).toContain("Facts from the office");
    // Only the sender line under "Show the whole message" gives the account's
    // name, as the message has it (0016, C1).
    expect(html(withPlace).split("lantern hill")).toHaveLength(2);
    expect(html(withPlace)).toContain("<pre>lantern hill &lt;front@lanternhill.example&gt;</pre>");
    const accepted = { ...withPlace, evidence: [{ ...withPlace.evidence[0]!, status: "accepted" }] } as AppState;
    expect(html(accepted)).toContain("Facts from Lantern Hill Clinic");
  });
});
