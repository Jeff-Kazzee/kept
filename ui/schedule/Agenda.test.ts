// Muse round 1, finding 12: a calendar event's title and a clash's title
// come from the calendar file, so they render as labeled data, never as
// markup or plain prose. The agenda row keeps the clash as a small marker.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppState } from "../api.ts";
import { Agenda, EVENT_LABEL } from "./Agenda.tsx";

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
