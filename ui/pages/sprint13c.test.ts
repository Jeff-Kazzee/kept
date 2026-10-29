// Sprint 13C (0016): H2, the calendar read status on Connections, and H3,
// the time zone's source and the notice that offers this device's zone.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentContext, DEFAULT_AGENT, type AgentState } from "../agent/AgentContext.tsx";
import { DEFAULT_SETTINGS, GOOGLE_OFF, type Settings } from "../contract.ts";
import { setCaseZone } from "../format.ts";
import { GoogleSetting, ZoneNotice, calendarReadSentence, zoneMismatch, zoneSourceWords } from "./Settings.tsx";

const run = async () => {};
const withAgent = (agent: Partial<AgentState>, node: ReactNode) =>
  renderToStaticMarkup(createElement(AgentContext.Provider, { value: { ...DEFAULT_AGENT, ...agent } }, node)).replaceAll("&#x27;", "'");
const connected = { ...GOOGLE_OFF, configured: true, version: 2, connected: true, email: "sample.person@example.com", gmail: true, calendar: true, calendarId: "primary" };

describe("sprint 13C, H2: the calendar read on Connections", () => {
  it("says when it read, how many events and for which days, and a failure in plain words", () => {
    setCaseZone("America/Denver");
    const read = { readAt: "2026-10-30T00:52:00.000Z", events: 3, from: "2026-10-29", to: "2026-11-28", days: 31, error: null };
    expect(calendarReadSentence(read, "2026-10-29")).toBe("Read at 6:52 PM, 3 events in the next 31 days.");
    expect(calendarReadSentence({ ...read, events: 1 }, "2026-10-30")).toBe("Read at 6:52 PM, 1 event from Thursday 10/29 to Saturday 11/28.");
    const html = withAgent({ google: { ...connected, calendarRead: { ...read, error: { code: "google_unavailable", at: "2026-10-30T00:58:00.000Z" } } } }, createElement(GoogleSetting, { run }));
    expect(html).toContain("Read at 6:52 PM, 3 events");
    expect(html).toContain("The read at 6:58 PM failed. Google did not answer. Try again in a moment.");
    expect(html).toContain("Read the calendar again");
    // Never read yet, the line still shows.
    expect(withAgent({ google: connected }, createElement(GoogleSetting, { run }))).toContain("Google Calendar has not been read yet.");
  });
});

describe("sprint 13C, H3: the time zone's source", () => {
  const utc: Settings = { ...DEFAULT_SETTINGS, settingsVersion: 2, timezone: "UTC", timezoneSource: "browser" };
  it("says From this device only when this device's zone is the case's", () => {
    expect(zoneSourceWords("browser", "UTC", "America/Denver")).toBe("From the first browser that opened the app");
    expect(zoneSourceWords("browser", "America/Denver", "America/Denver")).toBe("From this device");
    expect(zoneSourceWords("you", "UTC", "America/Denver")).toBe("Set by you");
  });

  it("offers this device's zone with one button when a browser or the default set another, and never for a zone someone chose", () => {
    expect(zoneMismatch(utc, "America/Denver")).toBe("America/Denver");
    expect(zoneMismatch({ ...utc, timezoneSource: "default" }, "America/Denver")).toBe("America/Denver");
    expect(zoneMismatch({ ...utc, timezoneSource: "you" }, "America/Denver")).toBeNull();
    expect(zoneMismatch({ ...utc, timezoneSource: "agent" }, "America/Denver")).toBeNull();
    expect(zoneMismatch(utc, "UTC")).toBeNull();
    expect(zoneMismatch(utc, null)).toBeNull();
    const html = renderToStaticMarkup(createElement(ZoneNotice, { settings: utc, device: "America/Denver", run, save: async () => {} }));
    expect(html).toContain("Times show in UTC, set by the first browser that opened the app. This device uses America/Denver.");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Use America/Denver");
    expect(renderToStaticMarkup(createElement(ZoneNotice, { settings: { ...utc, timezoneSource: "you" }, device: "America/Denver", run, save: async () => {} }))).toBe("");
  });
});
