// Sprint 19 (0021, D7 and D8): Connections on the hosted site with the
// shared demo Gmail and Calendar. One quiet line, connected or needs
// reconnecting, never the shared account's address, no Connect or
// Disconnect for a judge, and the privacy sentence.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentContext, DEFAULT_AGENT, type AgentState } from "../agent/AgentContext.tsx";
import { GOOGLE_OFF } from "../contract.ts";
import { CASE_DELETED_SHARED_TEXT, DEMO_GOOGLE_LINE, DEMO_GOOGLE_PRIVACY, GoogleSetting, SettingsPage } from "./Settings.tsx";

const run = async () => {};
const withAgent = (agent: Partial<AgentState>, node: ReactNode) =>
  renderToStaticMarkup(createElement(AgentContext.Provider, { value: { ...DEFAULT_AGENT, ...agent } }, node)).replaceAll("&#x27;", "'");

// What GET /api/google answers for an account on the shared connection.
const shared = (connected: boolean, ownConnect: boolean) => ({ ...GOOGLE_OFF, configured: true, demo: { connected, ownConnect } });

describe("sprint 19: Connections with the shared demo Gmail and Calendar", () => {
  it("a judge sees one line and the privacy sentence, with no buttons", () => {
    expect(DEMO_GOOGLE_LINE).toBe("Demo Gmail and Calendar: a made-up account shared by judges");
    const on = withAgent({ google: shared(true, false) }, createElement(GoogleSetting, { run }));
    expect(on).toContain(`${DEMO_GOOGLE_LINE}: connected.`);
    expect(on).toContain(DEMO_GOOGLE_PRIVACY);
    expect(on).not.toContain("<button");
    expect(on).not.toContain("@");
    const off = withAgent({ google: shared(false, false) }, createElement(GoogleSetting, { run }));
    expect(off).toContain(`${DEMO_GOOGLE_LINE}: needs reconnecting.`);
    expect(off).not.toContain("<button");
  });

  it("an email account sees the line and may still connect its own Google", () => {
    const html = withAgent({ google: shared(true, true) }, createElement(GoogleSetting, { run }));
    expect(html).toContain(`${DEMO_GOOGLE_LINE}: connected.`);
    expect(html).toContain(" Connect Google</button>");
  });

  it("Settings says the demo inbox is what the app reads, and Delete case says its events go", () => {
    const html = withAgent({ google: shared(true, false) }, createElement(SettingsPage, { version: 1, erasePending: false, run, caseDeleted: true }));
    expect(html).toContain("It reads only the demo Gmail inbox, a made-up person's shared by judges");
    expect(html).toContain(CASE_DELETED_SHARED_TEXT);
  });
});
