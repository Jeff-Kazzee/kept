// Sprint 13E (0018): the email a turn found and did not add has a card with
// "Add it" (H2), an Added line for an event since removed in Google
// Calendar offers no Undo (H5), a deliberate refusal is not a failed step
// (H6), and a success line shows once (H7).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, api, type AppState } from "../api.ts";
import { AgentContext, DEFAULT_AGENT, removedInGoogle, type AgentState } from "../agent/AgentContext.tsx";
import type { ActivityEntry, ActivityLog } from "../contract.ts";
import { PartlyDoneError, errorSentence, setCaseZone } from "../format.ts";
import { setupLink } from "../shell/shell.ts";
import { installTestDom, type TestDocument } from "../test-dom.ts";
import { ChatView, newestOffers, toolSummaryText, waitingText, type ChatViewProps } from "./ChatView.tsx";
import type { ChatState } from "./state.ts";
import type { Card, ChatMessage } from "./types.ts";

beforeAll(() => {
  installTestDom();
  setCaseZone("America/Denver");
});
afterEach(() => {
  vi.restoreAllMocks();
});

const at = "2026-10-29T00:41:00.000Z";
const FIRST = "gmail-19a001";
const SECOND = "gmail-19a002";
const messageView = (id: string, from: string, received: string) => ({
  id,
  version: 2,
  status: "extracted",
  sourceType: "office_message",
  importedFrom: "gmail",
  ownReport: "none",
  sourceNote: null,
  sourceSuggested: [],
  evidenceIds: [`${id}-e1`],
  manualEvidenceIds: [],
  rejections: [],
  message: { id, channel: "email", from, received_at: received, text: "x" },
});
const evidence = (id: string, date: string) => ({
  id: `${id}-e1`,
  version: 1,
  status: "pending",
  messageId: id,
  claim: { claim_type: "offer", slot: { date, time: "13:00", location: null }, quote: "We can offer Monday.", source_type: "office_message" },
});
const stateWith = (ids: string[]) =>
  ({
    messages: ids.map((id) => messageView(id, "Lantern Hill Clinic <front@lanternhill.example>", id === FIRST ? at : "2026-10-29T00:43:00.000Z")),
    evidence: ids.map((id) => evidence(id, id === FIRST ? "2026-11-12" : "2026-11-16")),
    proposals: [],
    records: [],
    case: { slots: [], conflicts: [], question: null, staleEvidenceIds: [], reply: { draft: null, sent: [], options: [], withheld: [], suggestion: null, version: 0 } },
  }) as unknown as AppState;

const waitingCard = (gmailId: string, receivedAt: string, extra: Partial<Extract<Card, { kind: "gmail_waiting" }>> = {}): Card => ({
  kind: "gmail_waiting",
  gmailId,
  messageId: `gmail-${gmailId}`,
  receivedAt,
  office: "Lantern Hill Clinic",
  sameSenderAs: FIRST,
  ...extra,
});
const answer = (cards: Card[], actions: string[] = []): ChatMessage => ({ id: "a1", role: "assistant", text: "Imported one email.", createdAt: at, cards, chips: [], actions }) as ChatMessage;
const chatOf = (messages: ChatMessage[]): ChatState => ({ status: "ready", chatVersion: messages.length, messages, pending: null, declinedText: {}, toolsByMessage: {} });
const props = (state: AppState, chat: ChatState, run: ChatViewProps["run"] = async (a) => void (await a())): ChatViewProps => ({
  state,
  run,
  chat,
  streaming: false,
  scripted: false,
  send: async () => {},
  onShowSlot: () => {},
  onLoadCalendar: async () => {},
  onLoadDemo: async () => null,
  fixtures: [],
});
const html = (state: AppState, chat: ChatState, agent: Partial<AgentState> = {}) =>
  renderToStaticMarkup(createElement(AgentContext.Provider, { value: { ...DEFAULT_AGENT, ...agent } }, createElement(ChatView, props(state, chat)))).replaceAll("&#x27;", "'");

describe("sprint 13E, H2: an email the turn did not add", () => {
  it("names it by the office and when it arrived, with Add it", () => {
    const out = html(stateWith([FIRST]), chatOf([answer([waitingCard("19a002", "2026-10-29T00:43:00.000Z")])]));
    expect(out).toContain("1 more email from Lantern Hill Clinic, Oct 28, 6:43 PM, isn't in your case yet.");
    expect(out).toContain("Add it");
    expect(out).toContain("Written by code");
    expect(out).not.toContain("@");
  });

  it("without a message from the same sender in the case, uses the name code gave, or the office", () => {
    expect(html(stateWith([]), chatOf([answer([waitingCard("19a002", "2026-10-29T00:43:00.000Z", { sameSenderAs: null, office: null })])]))).toContain(
      "1 more email from the office, Oct 28, 6:43 PM, isn't in your case yet.",
    );
  });

  it("several emails are one card, each with its own Add it", () => {
    expect(waitingText([{ sender: "Lantern Hill Clinic", when: "Oct 28, 6:43 PM" }])).toBe("1 more email from Lantern Hill Clinic, Oct 28, 6:43 PM, isn't in your case yet.");
    expect(
      waitingText([
        { sender: "Lantern Hill Clinic", when: "Oct 28, 6:43 PM" },
        { sender: "Lantern Hill Clinic", when: "Oct 29, 8:00 AM" },
      ]),
    ).toBe("2 more emails from Lantern Hill Clinic aren't in your case yet.");
    const out = html(stateWith([]), chatOf([answer([waitingCard("19a001", at, { sameSenderAs: null }), waitingCard("19a002", "2026-10-29T00:43:00.000Z", { sameSenderAs: null })])]));
    expect(out).toContain("2 more emails from Lantern Hill Clinic aren't in your case yet.");
    expect(out.split(">Add it<").length - 1).toBe(0);
    expect(out.split("Add it</button>").length - 1).toBe(2);
  });

  it("once the email is in the case, the card is its facts card, with no Add it", () => {
    const out = html(stateWith([FIRST, SECOND]), chatOf([answer([waitingCard("19a002", "2026-10-29T00:43:00.000Z")])]));
    expect(out).not.toContain("isn't in your case yet");
    expect(out).not.toContain("Add it");
    expect(out).toContain("Monday 11/16");
  });

  it("Add it adds the email, then reads it through the extract route, with no chat turn", async () => {
    const add = vi.spyOn(api, "addGmail").mockResolvedValue({ ...messageView(SECOND, "x", at), version: 1, status: "imported" } as never);
    const extract = vi.spyOn(api, "extract").mockResolvedValue({} as never);
    const send = vi.fn(async () => {});
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const doc = document as unknown as TestDocument;
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const p = { ...props(stateWith([FIRST]), chatOf([answer([waitingCard("19a002", "2026-10-29T00:43:00.000Z")])])), send };
    await act(async () => root.render(createElement(ChatView, p)));
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add it"))!;
    expect(button.getAttribute("aria-label")).toBe("Add the email from Lantern Hill Clinic, Oct 28, 6:43 PM");
    await act(async () => {
      button.dispatchEvent(new (globalThis as unknown as { Event: new (t: string, i: object) => Event }).Event("click", { bubbles: true }) as never);
    });
    expect(add).toHaveBeenCalledWith("19a002");
    expect(extract).toHaveBeenCalledWith(SECOND, "minimal", 1);
    expect(send).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

const added: ActivityEntry = {
  id: "a7",
  at: "2026-11-05T10:00:00-07:00",
  actor: "agent",
  kind: "calendar_event_added",
  summary: "Added Monday 11/16 1:00 PM to Google Calendar as tentative.",
  target: { type: "slot", id: "2026-11-16T13:00" },
  undoable: true,
  undone: false,
} as ActivityEntry;
const log = (entries: ActivityEntry[]) => ({ activityVersion: entries.length, entries }) as unknown as ActivityLog;
const read = (readAt: string, slots: string[]) => [{ from: "2026-11-05", to: "2026-12-05", readAt, slots }];
const google = (slots: string[]) => ({ ...DEFAULT_AGENT.google, calendarOwn: read("2026-11-05T17:05:00.000Z", slots) }) as AgentState["google"];

describe("sprint 13E, H5: an Added line for an event since removed in Google Calendar", () => {
  it("is removed only for the slot's latest calendar action, by the read that drives Removed in Google Calendar", () => {
    expect(removedInGoogle(log([added]), read("2026-11-05T17:05:00.000Z", []), added)).toBe(true);
    expect(removedInGoogle(log([added]), read("2026-11-05T17:05:00.000Z", [added.target!.id]), added)).toBe(false);
    expect(removedInGoogle(log([added]), undefined, added)).toBe(false);
    // A later write for the slot (put back) is the one in effect.
    const back = { ...added, id: "a9" };
    expect(removedInGoogle(log([back, added]), read("2026-11-05T17:05:00.000Z", []), added)).toBe(false);
    expect(removedInGoogle(log([{ ...added, undone: true }]), read("2026-11-05T17:05:00.000Z", []), { ...added, undone: true })).toBe(false);
  });

  it("the chat line says so and offers no Undo", () => {
    const chat = chatOf([answer([], ["a7"])]);
    const gone = html(stateWith([]), chat, { activity: log([added]), google: google([]) });
    expect(gone).toContain("Added Monday 11/16 1:00 PM to Google Calendar as tentative.");
    expect(gone).toContain("Since removed in Google Calendar");
    expect(gone).not.toContain("Undo: Added");
    const there = html(stateWith([]), chat, { activity: log([added]), google: google([added.target!.id]) });
    expect(there).toContain("Undo: Added");
    expect(there).not.toContain("Since removed");
  });
});

describe("sprint 13E, H6: a deliberate refusal is not a failure", () => {
  it("counts it as a step that chose not to act", () => {
    const line = (ok: boolean | null, declined?: boolean) => ({ callId: String(Math.random()), label: "x", ok, ...(declined ? { declined } : {}) });
    expect(toolSummaryText([line(true), line(false, true)])).toBe("Worked through 2 steps, 1 chose not to act");
    expect(toolSummaryText([line(true), line(false)])).toBe("Worked through 2 steps, 1 did not finish");
    expect(toolSummaryText([line(false), line(false, true), line(true)])).toBe("Worked through 3 steps, 1 did not finish, 1 chose not to act");
    expect(toolSummaryText([line(true)])).toBe("Worked through 1 step");
  });
});

describe("sprint 13E, H7: the success line shows once", () => {
  it("a notice that states an action already in the receipts is not shown again", () => {
    const notice: Card = { kind: "notice", text: added.summary, activityId: "a7" };
    const shownAsNotice = (out: string) => out.split(`<p>${added.summary}</p>`).length - 1;
    const out = html(stateWith([]), chatOf([answer([notice], ["a7"])]), { activity: log([added]), google: google([added.target!.id]) });
    expect(shownAsNotice(out)).toBe(0);
    expect(out).toContain(`<span class="receipt-text">${added.summary}`);
    expect(out).toContain("Undo: Added");
    // A notice for an action this answer did not take still shows.
    const other = html(stateWith([]), chatOf([answer([notice], [])]), { activity: log([added]) });
    expect(shownAsNotice(other)).toBe(1);
  });
});

describe("sprint 13E fix round 1, R4: one Add it per email across answers", () => {
  const second = (id: string, cards: Card[]): ChatMessage => ({ ...answer(cards), id });
  it("shows only the newest card for an email, and after Undo of its import only the newest comes back", () => {
    const card = waitingCard("19a002", "2026-10-29T00:43:00.000Z");
    const twice = chatOf([second("a1", [card]), second("a2", [card])]);
    const once = chatOf([second("a2", [card])]);
    // The newest is the later answer's card.
    expect([...newestOffers(twice)]).toHaveLength(1);
    expect([...newestOffers(twice)][0]!.startsWith("a2")).toBe(true);
    // One Add it while the email is not in the case.
    expect(html(stateWith([FIRST]), twice).split("Add it</button>").length - 1).toBe(1);
    // Added: one facts card, as with a single offer, and no Add it.
    const added = html(stateWith([FIRST, SECOND]), twice);
    expect(added).not.toContain("Add it");
    expect(added).toContain("Facts from");
    expect(added.split("Facts from").length).toBe(html(stateWith([FIRST, SECOND]), once).split("Facts from").length);
    // The import undone: the email is out of the case again, and only the
    // newest card offers it.
    expect(html(stateWith([FIRST]), twice).split("Add it</button>").length - 1).toBe(1);
  });
});

describe("sprint 13E fix round 1, R2: Add it says when the read failed", () => {
  it("the email is added, and the person is told it was not read and where to read it", async () => {
    vi.spyOn(api, "addGmail").mockResolvedValue({ ...messageView(SECOND, "x", at), version: 1, status: "imported" } as never);
    vi.spyOn(api, "extract").mockRejectedValue(new ApiError(422, { error: "provider_not_ready", message: "Set up a model in Connections to read messages. Nothing in your case changed." }));
    const errors: unknown[] = [];
    const run: ChatViewProps["run"] = async (a) => {
      try {
        await a();
      } catch (e) {
        errors.push(e);
      }
    };
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const doc = document as unknown as TestDocument;
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(createElement(ChatView, props(stateWith([FIRST]), chatOf([answer([waitingCard("19a002", "2026-10-29T00:43:00.000Z")])]), run))));
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add it"))!;
    await act(async () => {
      button.dispatchEvent(new (globalThis as unknown as { Event: new (t: string, i: object) => Event }).Event("click", { bubbles: true }) as never);
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(PartlyDoneError);
    expect(errorSentence(errors[0])).toBe(
      "Added the email from Lantern Hill Clinic, Oct 28, 6:43 PM, but it was not read. Set up a model in Connections to read messages. Its card has Read this message.",
    );
    expect(errorSentence(errors[0])).not.toContain("Nothing");
    // The toast still links to Connections.
    expect(setupLink(errors[0])).toBe("connections");
    await act(async () => root.unmount());
  });
});

describe("sprint 13E fix round 2, F6: a refused Add it shows the server's sentence", () => {
  it("gmail_not_offered reads as the server wrote it, not as a stale edit", () => {
    const message =
      "That email was not offered in this case for the Google account connected now, so it was not added. Ask the assistant to check Gmail again. Nothing was saved.";
    expect(errorSentence(new ApiError(409, { error: "gmail_not_offered", message }))).toBe(message);
  });
});
