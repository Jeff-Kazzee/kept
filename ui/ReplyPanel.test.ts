// The reply panel as the user sees it: the readback, the edit label and the
// simulated-send label. Rendered to static markup with the server renderer.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReplyView } from "../src/reply/types.ts";
import { ReplyPanel } from "./ReplyPanel.tsx";

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
  valid: true,
  problems: [],
  createdAt: "2026-11-05T09:00:00.000Z",
} satisfies ReplyView["draft"];

const base: ReplyView = { version: 1, options: [], withheld: [], draft, suggestion: null, sent: [] };
const render = (reply: ReplyView) => renderToStaticMarkup(createElement(ReplyPanel, { reply, run: async () => {} }));

describe("reply panel", () => {
  it("SP3.5: reads back each field with its source, and approval starts disabled", () => {
    const html = render(base);
    expect(html).toContain("Read back every field before you approve");
    expect(html).toContain("Monday 11/16");
    expect(html).toContain("<code>m3-e3</code> Monday 11/16 1:00 PM, Offered · office message");
    expect(html).toContain("Not in any accepted evidence. Left out of the reply.");
    expect(html).toMatch(/<button disabled="">Approve and send \(simulated\)<\/button>/);
    expect(html).not.toContain("Edited by you. Not checked.");
  });

  it("SP3.6: labels an edited draft", () => {
    expect(render({ ...base, draft: { ...draft, edited: true, text: "Changed." } })).toContain("Edited by you. Not checked.");
  });

  it("SP3.8: labels each approved reply as simulated", () => {
    const html = render({
      ...base,
      draft: null,
      sent: [{ draftId: "d1", template: "accept_offer", title: draft.title, slotKey: draft.slotKey, slotLabel: draft.slotLabel, text: draft.text, edited: false, evidenceIds: ["reply-d1-1"], approvedAt: "2026-11-05T09:00:00.000Z", simulated: true }],
    });
    expect(html).toContain('<div class="simulated" role="status">Simulated. Nothing was sent.</div>');
    expect(html).toContain("approved <span class=\"nowrap\">2026-11-05 09:00 UTC</span>");
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
