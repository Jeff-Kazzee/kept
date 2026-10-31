// Sprint 19 (0021, D7 and D8): Connections on the hosted site with the
// shared demo Gmail and Calendar. One quiet line, connected or needs
// reconnecting, never the shared account's address, no Connect or
// Disconnect for a judge, and the privacy sentence.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentContext, DEFAULT_AGENT, type AgentState } from "../agent/AgentContext.tsx";
import { GOOGLE_OFF } from "../contract.ts";
import { CASE_DELETED_PENDING_TEXT, CASE_DELETED_SHARED_TEXT, CASE_DELETED_TEXT, DEMO_GOOGLE_LINE, DEMO_GOOGLE_PRIVACY, GoogleSetting, SettingsPage, deletedSentence } from "./Settings.tsx";

const run = async () => {};
const withAgent = (agent: Partial<AgentState>, node: ReactNode) =>
  renderToStaticMarkup(createElement(AgentContext.Provider, { value: { ...DEFAULT_AGENT, ...agent } }, node)).replaceAll("&#x27;", "'");

// What GET /api/google answers for an account on the shared connection.
const shared = (connected: boolean, ownConnect: boolean) => ({ ...GOOGLE_OFF, configured: true, demo: { connected, ownConnect } });

describe("sprint 19: Connections with the shared demo Gmail and Calendar", () => {
  it("a judge sees one line and the privacy sentence, with no buttons", () => {
    expect(DEMO_GOOGLE_LINE).toBe("Demo Gmail and Calendar: a made-up account shared by judges");
    const on = withAgent({ google: shared(true, false) }, createElement(GoogleSetting, { run }));
    expect(on).toContain(DEMO_GOOGLE_LINE);
    expect(on).toContain('<span class="pill pill-accepted">Connected</span>');
    expect(on).toContain(DEMO_GOOGLE_PRIVACY);
    expect(on).not.toContain("<button");
    expect(on).not.toContain("@");
    const off = withAgent({ google: shared(false, false) }, createElement(GoogleSetting, { run }));
    expect(off).toContain('<span class="pill pill-pending">Needs reconnecting</span>');
    expect(off).not.toContain("<button");
  });

  it("an email account sees the line and may still connect its own Google", () => {
    const html = withAgent({ google: shared(true, true) }, createElement(GoogleSetting, { run }));
    expect(html).toContain(DEMO_GOOGLE_LINE);
    expect(html).toContain(" Connect Google</button>");
  });

  it("the case's connection line names the demo Gmail and Calendar, never an address", async () => {
    const { ConnectionStatus } = await import("../chat/ChatView.tsx");
    expect(withAgent({ google: shared(true, false) }, createElement(ConnectionStatus))).toContain("Demo Gmail and Calendar");
    expect(withAgent({ google: shared(false, false) }, createElement(ConnectionStatus))).toContain("Demo Gmail needs reconnecting");
    expect(withAgent({ google: { ...GOOGLE_OFF, configured: true } }, createElement(ConnectionStatus))).toContain("Google not connected");
  });

  it("Settings says the demo inbox is what the app reads, and Delete case says its events go", () => {
    const html = withAgent({ google: shared(true, false) }, createElement(SettingsPage, { version: 1, erasePending: false, run, caseDeleted: true }));
    expect(html).toContain("It reads only the demo Gmail inbox, a made-up person's shared by judges");
    expect(html).toContain(CASE_DELETED_SHARED_TEXT);
  });

  it("Delete case says whether the demo calendar's events went or wait for the sweep (round 2, finding 5)", () => {
    expect(deletedSentence(true, "removed")).toBe(CASE_DELETED_SHARED_TEXT);
    expect(deletedSentence(true, "pending")).toBe(CASE_DELETED_PENDING_TEXT);
    expect(deletedSentence(false, null)).toBe(CASE_DELETED_TEXT);
    expect(CASE_DELETED_PENDING_TEXT).toContain("within the hour");
  });
});
