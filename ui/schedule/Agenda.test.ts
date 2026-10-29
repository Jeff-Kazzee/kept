// Muse round 1, finding 12: a calendar event's title and a clash's title
// come from the calendar file, so they render as labeled data, never as
// markup or plain prose. The agenda row keeps the clash as a small marker.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppState } from "../api.ts";
import { Agenda, EVENT_LABEL } from "./Agenda.tsx";
import { AgentContext, DEFAULT_AGENT, googleEventState } from "../agent/AgentContext.tsx";
import type { ActivityLog } from "../contract.ts";

const title = "Team <b>meeting</b>";
const state = {
  evidence: [],
  records: [],
  case: {
    slots: [
      {
        key: "2026-11-13T09:15",
        date: "2026-11-13",
        time: "09:15",
        label: "Friday 11/13 9:15 AM",
        state: "offered",
        stateLabel: "Offered · office message",
        sourceLabel: "office message",
        location: null,
        locationDisputed: false,
        stateEvidenceId: null,
        missing: [],
        staleEvidenceIds: [],
        evidenceIds: [],
        clashes: [{ summary: title, start: { date: "2026-11-13", time: "09:00", utc: false }, end: { date: "2026-11-13", time: "10:00", utc: false } }],
      },
    ],
    calendar: { name: "dana.ics", assumedSlotMinutes: 60, events: [{ uid: "e1", summary: title, start: { date: "2026-11-13", time: "09:00", utc: false }, end: { date: "2026-11-13", time: "10:00", utc: false }, recurring: false }] },
    reply: { options: [], draft: null, version: 0 },
  },
} as unknown as AppState;

describe("agenda", () => {
  it("shows calendar titles as labeled data, and a clash as a small marker", () => {
    const html = renderToStaticMarkup(createElement(Agenda, { state, run: async () => {} }));
    const inline = `<span class="untrusted-inline" title="${EVENT_LABEL}"><span class="sr-only">${EVENT_LABEL}: </span>Team &lt;b&gt;meeting&lt;/b&gt;</span>`;
    // Once on the calendar row, once in the clash under Details.
    expect(html.split(inline).length - 1).toBe(2);
    expect(html).not.toContain("<b>meeting</b>");
    expect(html).toContain('<span class="marker marker-clash"');
    expect(html).toContain("<span>Clash</span>");
  });
});

describe("sprint 13C fix round 2, N4: no evidence id on the schedule", () => {
  it("a stale reminder is named in words, without its evidence id", () => {
    const slot = { ...(state.case.slots[0] as object), staleEvidenceIds: ["gmail-18f0a1-e3", "m2-e4"] };
    const stale = { ...state, case: { ...state.case, slots: [slot] } } as unknown as AppState;
    const html = renderToStaticMarkup(createElement(Agenda, { state: stale, run: async () => {} }));
    expect(html).toContain("A reminder for this time may be out of date.</p>");
    expect(html).not.toMatch(/gmail-18f0a1-e3|m2-e4/);
  });
});

describe("sprint 13D fix round 1: an event the person removed in Google Calendar", () => {
  const slot = { key: "2026-11-13T09:15", date: "2026-11-13" };
  const added = { id: "a3", at: "2026-11-05T10:00:00-07:00", actor: "agent", kind: "calendar_event_added", summary: "Added", target: { type: "slot", id: slot.key }, undoable: true, undone: false };
  const log = { version: 3, entries: [added] } as unknown as ActivityLog;
  const read = (readAt: string, slots: string[]) => [{ from: "2026-11-05", to: "2026-12-05", readAt, slots }];

  it("reads as removed only when a read made after the write covers the date and no longer finds it", () => {
    expect(googleEventState(null, undefined, slot)).toBeNull();
    // No read since the write: the app's own write stands.
    expect(googleEventState(log, undefined, slot)).toBe("on");
    expect(googleEventState(log, read("2026-11-05T16:59:00.000Z", []), slot)).toBe("on");
    // A later read still finds it.
    expect(googleEventState(log, read("2026-11-05T17:05:00.000Z", [slot.key]), slot)).toBe("on");
    // A later read covering the date does not: removed in Google Calendar.
    expect(googleEventState(log, read("2026-11-05T17:05:00.000Z", []), slot)).toBe("removed");
    // A read of other days says nothing about it.
    expect(googleEventState(log, [{ from: "2026-12-06", to: "2027-01-05", readAt: "2026-11-05T17:05:00.000Z", slots: [] }], slot)).toBe("on");
    // An undo after that read counts as a newer write.
    const undone = { version: 4, entries: [{ ...added, undone: true, undoneAt: "2026-11-05T17:10:00.000Z" }] } as unknown as ActivityLog;
    expect(googleEventState(undone, read("2026-11-05T17:05:00.000Z", []), slot)).toBeNull();
  });

  it("the agenda row says Removed in Google Calendar instead of On Google Calendar", () => {
    const row = (google: unknown) =>
      renderToStaticMarkup(createElement(AgentContext.Provider, { value: { ...DEFAULT_AGENT, activity: log, google } as never }, createElement(Agenda, { state, run: async () => {} })));
    const on = row({ calendarOwn: read("2026-11-05T17:05:00.000Z", [slot.key]) });
    expect(on).toContain("On Google Calendar");
    expect(on).not.toContain("Removed in Google Calendar");
    const removed = row({ calendarOwn: read("2026-11-05T17:05:00.000Z", []) });
    expect(removed).toContain("<span>Removed in Google Calendar</span>");
    expect(removed).not.toContain("On Google Calendar");
  });
});
