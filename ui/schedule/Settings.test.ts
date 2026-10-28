// Settings as the user sees them: Meta first and the default, ChatGPT as
// the alternative, the key field that never holds a key, the model choice,
// Google with its permissions, and the time zone. Rendered to static markup
// with the server renderer.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentContext, DEFAULT_AGENT, type AgentState } from "../agent/AgentContext.tsx";
import { DEFAULT_SETTINGS, GOOGLE_OFF, type Settings as SettingsView } from "../contract.ts";
import { GoogleSetting, PROVIDERS, SettingsPanel, TimeZoneSetting } from "./Settings.tsx";

const run = async () => {};
const withAgent = (agent: Partial<AgentState>, node: ReactNode) =>
  renderToStaticMarkup(createElement(AgentContext.Provider, { value: { ...DEFAULT_AGENT, ...agent } }, node)).replaceAll("&#x27;", "'");

const meta: SettingsView = {
  ...DEFAULT_SETTINGS,
  settingsVersion: 4,
  timezone: "Europe/Berlin",
  timezoneSource: "agent",
  provider: "meta",
  model: "muse-spark-1.3",
  models: [
    { id: "muse-spark-1.3", label: "Muse Spark 1.3", costHint: "lower" },
    { id: "muse-wonder", label: "Muse Wonder", costHint: "higher" },
  ],
  meta: { keySet: true, source: "you" },
};

describe("settings", () => {
  it("lists Meta first as the default and ChatGPT under its own line, with what each receives", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(["meta", "chatgpt"]);
    const html = withAgent({ settings: { ...DEFAULT_SETTINGS, settingsVersion: 1 }, settingsAvailable: true }, createElement(SettingsPanel, { mode: "recorded", modelClient: "recorded", version: 1, erasePending: false, run }));
    const metaAt = html.indexOf("Meta Model API");
    const altAt = html.indexOf("Or use your ChatGPT plan");
    expect(metaAt).toBeGreaterThan(-1);
    expect(altAt).toBeGreaterThan(metaAt);
    expect(html.indexOf('<span class="model-tag">Default</span>')).toBeGreaterThan(metaAt);
    expect(html).toContain("Meta receives what the assistant reads to answer you");
    expect(html).toContain("OpenAI receives the same case text through your ChatGPT account");
    // No provider is ready, so neither can be picked yet.
    const radios = html.match(/<input[^>]*name="provider"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => r.includes('disabled=""'))).toBe(true);
    // The key field is a password field with no value and no autocomplete.
    expect(html).toMatch(/<input[^>]*name="meta-key"[^>]*type="password"[^>]*value=""|<input[^>]*type="password"[^>]*name="meta-key"/);
    expect(html).toMatch(/name="meta-key"[^>]*autoComplete="off"|autoComplete="off"[^>]*name="meta-key"/);
    expect(html).toContain(">Sign in with ChatGPT</button>");
  });

  it("with a key saved, says so without the key, offers the models with their cost, and shows the zone with its source", () => {
    const html = withAgent({ settings: meta, settingsAvailable: true }, createElement(SettingsPanel, { mode: "recorded", modelClient: "recorded", version: 1, erasePending: false, run }));
    expect(html).toContain("Your key is saved on the server.");
    expect(html).toContain(">Remove the key</button>");
    expect(html).toContain('<option value="muse-spark-1.3" selected="">Muse Spark 1.3 (lower cost)</option>');
    expect(html).toContain("Muse Wonder (higher cost)");
    expect(html).toMatch(/<strong>Europe\/Berlin \(GMT\+[12]\)<\/strong>/);
    expect(html).toContain("Set by the assistant");
    expect(html).toContain('<input id="');
    expect(html).toContain('name="timezone"');
    expect(html).toMatch(/<datalist[^>]*>.*<option value="America\/Denver"/);
  });

  it("sprint 10: a provider that lost its key stays the provider and says it needs setup, and the model notice shows under the choice", () => {
    const lost = { ...meta, meta: { keySet: false, source: null }, modelNotice: "Muse Wonder 1.0 could not use tools in the last call. Pick another model." } as SettingsView;
    const html = withAgent({ settings: lost, settingsAvailable: true }, createElement(SettingsPanel, { mode: "recorded", modelClient: "recorded", version: 1, erasePending: false, run }));
    expect(html).toContain('<span class="pill pill-pending">Needs setup</span>');
    expect(html).toContain("Meta is still the provider, but it has no key. Add a key, or pick another provider.");
    expect(html).not.toContain(">In use</span>");
    expect(html).toContain("Muse Wonder 1.0 could not use tools in the last call. Pick another model.");
    expect(html).toContain('name="meta-key"');
  });

  it("without the routes, says what is not available in this build yet", () => {
    const zone = withAgent({}, createElement(TimeZoneSetting, { run }));
    // The app's default zone is UTC, the server's.
    expect(zone).toContain("<strong>UTC</strong>");
    expect(zone).toContain("Changing the zone is not available in this build yet.");
    expect(withAgent({}, createElement(GoogleSetting, { run }))).toContain("Connecting Google is not available in this build yet.");
  });

  it("Google with no client on the server says so and points to docs/google.md, with no Connect", () => {
    const html = withAgent({ google: GOOGLE_OFF }, createElement(GoogleSetting, { run }));
    expect(html).toContain("This server has no Google client yet, so Google cannot be connected. <code>docs/google.md</code> says how to set one up.");
    expect(html).not.toContain("<button");
  });

  it("Google shows Connect with both permissions checked, then the account and each permission with Disconnect", () => {
    const off = withAgent({ google: { ...GOOGLE_OFF, configured: true } }, createElement(GoogleSetting, { run }));
    expect(off).toContain(" Connect Google</button>");
    expect(off.match(/<input[^>]*type="checkbox"[^>]*checked=""/g)).toHaveLength(2);
    expect(off).toContain('name="google-gmail"');
    expect(off).toContain('name="google-calendar"');
    const on = withAgent({ google: { ...GOOGLE_OFF, configured: true, version: 1, connected: true, email: "sample.person@example.com", gmail: true, calendar: false } }, createElement(GoogleSetting, { run }));
    expect(on).toContain("Connected as sample.person@example.com");
    expect(on).toContain("Gmail, read-only: search for messages about appointments<span class=\"sr-only\">: granted</span>");
    expect(on).toContain("<span class=\"sr-only\">: not granted</span>");
    expect(on).toContain(">Disconnect</button>");
    expect(on).toContain(">Connect again with both</button>");
    // No calendar permission, so nothing to read again.
    expect(on).not.toContain("Read the calendar again");
    // The server keeps the calendar id, but without the permission the
    // page does not name it.
    expect(withAgent({ google: { ...GOOGLE_OFF, configured: true, version: 1, connected: true, email: "sample.person@example.com", gmail: true, calendar: false, calendarId: "primary" } }, createElement(GoogleSetting, { run }))).not.toContain("(calendar primary)");
    const both = withAgent({ google: { ...GOOGLE_OFF, configured: true, version: 2, connected: true, email: "sample.person@example.com", gmail: true, calendar: true, calendarId: "primary" } }, createElement(GoogleSetting, { run }));
    expect(both).toContain(">Read the calendar again</button>");
    expect(both).toContain("(calendar primary)");
    expect(both).not.toContain("Connect again with both");
  });

  it("Google that needs a reconnect says so, keeps what was connected, and offers Reconnect and Disconnect", () => {
    const html = withAgent({ google: { ...GOOGLE_OFF, configured: true, version: 3, connected: false, needsReconnect: true, email: "sample.person@example.com", gmail: true, calendar: true, calendarId: "primary" } }, createElement(GoogleSetting, { run }));
    expect(html).toContain("Google needs you to sign in again. The assistant cannot read Gmail or Google Calendar until you reconnect.");
    expect(html).toContain("Last connected as sample.person@example.com");
    expect(html).toContain('aria-label="Permissions last granted"');
    expect(html).toContain(" Reconnect Google</button>");
    expect(html).toContain(">Disconnect</button>");
    expect(html).not.toContain(" Connect Google</button>");
  });});
