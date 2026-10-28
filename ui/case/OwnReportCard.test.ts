// 0009, D1': "Record this as your own report?" One line with Yes and No
// while open, then a receipt with Undo. In the thread through the card, and
// in "Waiting for you", because the assistant waits on it. fetch is
// replaced for the route test, so nothing leaves the test.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWN_REPORT_QUESTION } from "../../src/agent/types.ts";
import { AgentContext, DEFAULT_AGENT } from "../agent/AgentContext.tsx";
import type { AppState, MessageView } from "../api.ts";
import { CardView } from "../chat/ChatView.tsx";
import { ScheduleTab, waitingCount } from "../schedule/SchedulePanel.tsx";
import { OWN_REPORT_NO, OWN_REPORT_YES, OwnReportCard, openOwnReports } from "./OwnReportCard.tsx";

const message = (ownReport: MessageView["ownReport"]) =>
  ({
    id: "s5-report",
    version: 3,
    message: { id: "s5-report", channel: "unknown", from: "Dana Reyes", received_at: "2026-11-05T12:10:00-07:00", text: "I called the clinic." },
    sourceType: "office_message",
    sourceSuggested: ["channel"],
    sourceNote: null,
    status: "claims_pending",
    attempts: [],
    rejections: [],
    evidenceIds: [],
    manualEvidenceIds: [],
    ownReport,
  }) as unknown as MessageView;

const stateWith = (ownReport: MessageView["ownReport"]) =>
  ({
    messages: [message(ownReport)],
    evidence: [],
    records: [],
    case: { slots: [], conflicts: [], question: null, staleEvidenceIds: [], calendar: null, checklist: [], reply: { draft: null, sent: [], options: [], withheld: [], suggestion: null, version: 0 } },
  }) as unknown as AppState;

const entry = { id: "a9", at: "2026-11-05T12:11:00-07:00", actor: "you" as const, kind: "own_report_recorded", summary: "Recorded message s5-report as your own report.", target: { type: "message" as const, id: "s5-report" }, undoable: true, undone: false };
const render = (node: ReturnType<typeof createElement>, activity = { activityVersion: 9, entries: [entry] }) =>
  renderToStaticMarkup(createElement(AgentContext.Provider, { value: { ...DEFAULT_AGENT, activity } }, node)).replaceAll("&#x27;", "'");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("own-report card", () => {
  it("while open: one line with the question, Yes and No, in the thread and in Waiting for you", () => {
    const st = stateWith("offered");
    const card = render(createElement(CardView, { card: { kind: "own_report", messageId: "s5-report" }, state: st, run: async () => {} }));
    expect(card).toContain(`<strong>${OWN_REPORT_QUESTION}</strong>`);
    expect(card).toContain(">Yes</button>");
    expect(card).toContain(">No</button>");
    expect(card).toContain('aria-label="Yes, record the message from Dana Reyes as your own report"');
    // The message's start, as labeled data, tells two questions apart.
    expect(card).toContain('Dana Reyes: <span class="untrusted-inline" title="Message text, shown as data"><span class="sr-only">Message text, shown as data: </span>I called the clinic.</span>');
    expect(openOwnReports(st).map((m) => m.id)).toEqual(["s5-report"]);
    expect(waitingCount(st)).toBe(1);
    const tab = render(createElement(ScheduleTab, { state: st, run: async () => {}, highlight: null }));
    expect(tab).toContain("Waiting for you");
    expect(tab).toContain(`<strong>${OWN_REPORT_QUESTION}</strong>`);
  });

  it("after Yes: a receipt with Undo through its activity entry, and nothing waits", () => {
    const st = stateWith("yes");
    const html = render(createElement(OwnReportCard, { messageId: "s5-report", state: st, run: async () => {} }));
    expect(html).toContain(OWN_REPORT_YES);
    expect(html).toContain(`aria-label="Undo: ${OWN_REPORT_YES}"`);
    expect(html).not.toContain(">Yes</button>");
    expect(waitingCount(st)).toBe(0);
  });

  it("after No: Not recorded, with Undo, and once undone no Undo", () => {
    const no = { ...entry, summary: "Kept message s5-report as a message, not your own report." };
    expect(render(createElement(OwnReportCard, { messageId: "s5-report", state: stateWith("no"), run: async () => {} }), { activityVersion: 9, entries: [no] })).toContain(`aria-label="Undo: ${OWN_REPORT_NO}"`);
    const undone = render(createElement(OwnReportCard, { messageId: "s5-report", state: stateWith("no"), run: async () => {} }), { activityVersion: 10, entries: [{ ...no, undone: true }] });
    expect(undone).toContain(OWN_REPORT_NO);
    expect(undone).not.toContain("Undo:");
  });

  it("answers through POST /api/messages/:id/own-report with the message's version and the write headers", async () => {
    const sent: Array<{ path: string; headers: Record<string, string>; body?: string }> = [];
    vi.stubGlobal("fetch", async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      sent.push({ path, headers: init.headers, body: init.body });
      return { ok: true, status: 200, json: async () => (path === "/api/state" ? { generation: 4 } : {}) };
    });
    const { api } = await import("../api.ts");
    await api.ownReport("s5-report", "yes", 3);
    const post = sent.find((s) => s.path === "/api/messages/s5-report/own-report")!;
    expect(JSON.parse(post.body!)).toEqual({ expectedVersion: 3, answer: "yes" });
    expect(post.headers).toMatchObject({ "X-Case-Generation": "4", "X-Appointments-App": "1" });
  });
});
