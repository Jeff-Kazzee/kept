// The reply card as the user sees it: the readback, the edit label and the
// simulated-send label. Rendered to static markup with the server renderer.
// Moved from the old ReplyPanel tests in sprint 7B.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReplyView } from "../../src/reply/types.ts";
import type { AppState } from "../api.ts";
import { ReplyCard, ReplyPanel, readbackDone } from "./ReplyCard.tsx";
import { setCaseZone } from "../format.ts";

// These tests read times as the demo shows them, in the clinic's zone. The
// app's own default is UTC, as the server's.
setCaseZone("America/Denver");

const draft = {
  id: "d1",
  template: "accept_offer",
  title: "Accept an offered slot",
  asserts: "You accept the slot and ask the office to confirm it.",
  slotKey: "2026-11-16T13:00",
  slotLabel: "Monday 11/16 1:00 PM",
  origin: "choice",
  questionId: "q1",
  suggestionId: null,
  fields: [
    { name: "date", label: "Date", value: "2026-11-16", display: "Monday 11/16", sources: [{ kind: "slot", evidenceId: "m3-e3", text: "Monday 11/16 1:00 PM, Offered · office message" }] },
    { name: "location", label: "Place", value: null, display: null, sources: [] },
  ],
  renderedText: "Hello,\n\nI accept the appointment on Monday 11/16 at 1:00 PM. Please confirm it.\n\nThank you.",
  text: "Hello,\n\nI accept the appointment on Monday 11/16 at 1:00 PM. Please confirm it.\n\nThank you.",
  edited: false,
  claimConfirmation: null,
  valid: true,
  problems: [],
  invalidNotice: null,
  createdAt: "2026-11-05T09:00:00.000Z",
} satisfies ReplyView["draft"];

const base: ReplyView = { version: 1, options: [], withheld: [], draft, suggestion: null, sent: [] };
const render = (reply: ReplyView) => renderToStaticMarkup(createElement(ReplyPanel, { reply, run: async () => {} }));

describe("reply panel", () => {
  it("SP3.5: reads back each field with its source, and approval starts disabled", () => {
    const html = render(base);
    expect(html).toContain("Read back every field before you approve");
    expect(html).toContain("Monday 11/16");
    // 0016, M3: the source in words, without the evidence id.
    expect(html).toContain("<span>Monday 11/16 1:00 PM, Offered · office message</span>");
    expect(html).not.toContain("m3-e3");
    expect(html).toContain("Not in any accepted evidence. Left out of the reply.");
    expect(html).toContain('aria-label="I read Date"');
    expect(html).toMatch(/<button type="button" class="btn btn-primary" disabled="">Approve and send \(simulated\)<\/button>/);
    expect(html).not.toContain("Edited by you. Not checked.");
  });

  it("SP3.6: labels an edited draft", () => {
    expect(render({ ...base, draft: { ...draft, edited: true, text: "Changed." } })).toContain("Edited by you. Not checked.");
  });

  it("SP3.8: labels each approved reply as simulated", () => {
    const html = render({
      ...base,
      draft: null,
      sent: [{ draftId: "d1", template: "accept_offer", title: draft.title, slotKey: draft.slotKey, slotLabel: draft.slotLabel, text: draft.text, edited: false, evidenceIds: ["reply-d1-1"], claims: "recorded", approvedAt: "2026-11-05T09:00:00.000Z", simulated: true }],
    });
    expect(html).toMatch(/<span class="sent-label" role="status">.*Simulated. Nothing was sent.<\/span>/);
    // Times show in America/Denver with the zone.
    expect(html).toContain("Approved Thu, Nov 5, 2:00 AM MST");
  });

  it("S7: names the template withheld for a missing time", () => {
    const html = render({
      ...base,
      draft: null,
      withheld: [{ template: "ask_still_stands", title: "Ask whether a slot still stands", slotKey: "2026-11-16", slotLabel: "Monday 11/16, no time", missing: ["time"] }],
    });
    expect(html).toContain("Not offered: Ask whether a slot still stands for Monday 11/16, no time. The slot has no time.");
  });
});

describe("review round 1", () => {
  it("finding 3: ticks made before a saved edit do not count", () => {
    const names = new Set(draft.fields.map((f) => f.name));
    // Every field ticked at version 1. Saving an edit moved the stream to 2.
    expect(readbackDone({ at: 1, names }, draft, 1)).toBe(true);
    expect(readbackDone({ at: 1, names }, draft, 2)).toBe(false);
    expect(readbackDone({ at: 2, names: new Set(["date"]) }, draft, 2)).toBe(false);
  });

  it("finding 1: an edited draft shows the unticked claim statement, and a sent reply says no claim was recorded", () => {
    const edited = render({ ...base, draft: { ...draft, edited: true, text: "I can't take it.", claimConfirmation: "This reply still requests Monday 11/16 1:00 PM" } });
    expect(edited).toMatch(/<input [^>]*type="checkbox"[^>]*\/><span>This reply still requests Monday 11\/16 1:00 PM<\/span>/);
    expect(edited).toContain("If you leave it unticked, approval records no slot change.");
    const sent = render({
      ...base,
      draft: null,
      sent: [{ draftId: "d1", template: "accept_offer", title: draft.title, slotKey: draft.slotKey, slotLabel: draft.slotLabel, text: "I can't take it.", edited: true, evidenceIds: [], claims: "not_confirmed", approvedAt: "2026-11-05T09:00:00.000Z", simulated: true }],
    });
    expect(sent).toContain("No appointment change was recorded. You edited the text and did not confirm what it asserts.");
  });
});

describe("C1", () => {
  it("shows a no-fit answer with its reason and the manual options", () => {
    const html = render({
      ...base,
      draft: null,
      options: [{ template: "accept_offer", title: "Accept an offered slot", slotKey: "2026-11-10T14:00", slotLabel: "Tuesday 11/10 2:00 PM" }],
      suggestion: {
        id: "s1",
        intent: "Please accept Wednesday at 3:00 PM.",
        outcome: "no_fit",
        template: null,
        slotKey: null,
        noFitReason: "time_not_offered",
        model: "muse-spark-1.3",
        effort: "low",
        attempts: [{ attempt: 1, outcome: "valid", problems: [], detail: null, latency_ms: 1 }],
        outputs: [{ template: null, slot_id: null, no_fit_reason: "time_not_offered" }],
        caseChanged: [],
        recordedAt: "2026-11-05T09:00:00.000Z",
      },
    });
    expect(html).toContain("Model output: no template fits your note, because it names a date or time that no open slot has. Pick a template yourself below.");
    expect(html).toContain("Accept an offered slot: Tuesday 11/10 2:00 PM");
    // W8: the model's raw output is never on screen.
    expect(html).not.toContain("no_fit_reason");
    expect(html).not.toContain("slot_id");
  });
});

describe("reply card in the chat", () => {
  const state = (reply: ReplyView) => ({ case: { reply } }) as unknown as AppState;
  const card = (reply: ReplyView, draftId = "d1") => renderToStaticMarkup(createElement(ReplyCard, { draftId, state: state(reply), run: async () => {} }));

  it("shows the open draft, then its simulated send, from the live case", () => {
    expect(card(base)).toContain("Read back every field before you approve");
    const sent = card({
      ...base,
      draft: null,
      sent: [{ draftId: "d1", template: "accept_offer", title: draft.title, slotKey: draft.slotKey, slotLabel: draft.slotLabel, text: draft.text, edited: false, evidenceIds: ["reply-d1-1"], claims: "recorded", approvedAt: "2026-11-05T09:00:00.000Z", simulated: true }],
    });
    expect(sent).toContain("Simulated. Nothing was sent.");
    expect(sent).not.toContain("Approve and send");
    expect(card({ ...base, draft: null })).toContain("This reply draft was discarded or replaced. Nothing was sent.");
  });
});
