// The sprint 5 panels as the user sees them: the checklist with quotes and
// sources, the case history, Delete case and the notice on a draft the
// office's reply overtook. Rendered to static markup with the server
// renderer.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OFFICE_REPLIED_NOTICE } from "../src/reply/templates.ts";
import type { ReplyView } from "../src/reply/types.ts";
import { ChecklistPanel, DeleteCasePanel, HistoryPanel } from "./App.tsx";
import { ReplyPanel } from "./ReplyPanel.tsx";

const run = async () => {};

describe("sprint 5 panels", () => {
  it("SP5.3: each checklist item shows its quote and source, with no model label", () => {
    const html = renderToStaticMarkup(
      createElement(ChecklistPanel, {
        items: [
          { text: "Bring new insurance card", sources: [{ evidenceId: "m2-e2", quote: "Please bring your new insurance card", sourceLabel: "office message" }] },
          { text: "Bring the parking pass", sources: [{ evidenceId: "p-1-1", quote: null, sourceLabel: "reported by you through Laptop assistant" }] },
        ],
      }),
    );
    expect(html).toContain("<strong>Bring new insurance card</strong>");
    expect(html).toContain("“Please bring your new insurance card” · office message · <code>m2-e2</code>");
    expect(html).toContain("No quote. · reported by you through Laptop assistant");
    expect(html).not.toMatch(/model output/i);
    expect(renderToStaticMarkup(createElement(ChecklistPanel, { items: [] }))).toContain("Nothing yet.");
  });

  it("SP5.5: the history lists events in order and marks an undone event", () => {
    const html = renderToStaticMarkup(
      createElement(HistoryPanel, {
        entries: [
          { seq: 7, at: "2026-11-05T09:00:00.000Z", streamId: "record:2026-11-12T10:30", label: "2026-11-12T10:30 archived by you", undone: true },
          { seq: 8, at: "2026-11-05T09:01:00.000Z", streamId: "record:2026-11-12T10:30", label: "Undo on 2026-11-12T10:30 by you: reversed version 2", undone: false },
        ],
      }),
    );
    expect(html).toContain("Show all 2 events, oldest first");
    expect(html.indexOf("archived by you")).toBeLessThan(html.indexOf("Undo on"));
    expect(html).toContain('<td class="undone">2026-11-12T10:30 archived by you (undone)</td>');
  });

  it("SP5.4: Delete case says what it erases and that it cannot be undone, and starts disabled", () => {
    const html = renderToStaticMarkup(createElement(DeleteCasePanel, { version: 12, run }));
    expect(html).toContain("erases every message, claim, review, slot, question, explanation, reply, note, tag and proposal");
    expect(html).toContain("Grants stay");
    expect(html).toContain("Type DELETE to confirm");
    expect(html).toContain('<button disabled="">Delete this case and all its data permanently. This cannot be undone.</button>');
  });

  it("a draft the office's reply overtook says so, and approval stays disabled", () => {
    const reply: ReplyView = {
      version: 3,
      options: [],
      withheld: [],
      suggestion: null,
      sent: [],
      draft: {
        id: "d1",
        template: "accept_offer",
        title: "Accept an offered slot",
        asserts: "You accept the slot and ask the office to confirm it.",
        slotKey: "2026-11-16T13:00",
        slotLabel: "Monday 11/16 1:00 PM",
        origin: "choice",
        questionId: "q1",
        suggestionId: null,
        fields: [],
        renderedText: "Hello",
        text: "Hello",
        edited: false,
        claimConfirmation: null,
        valid: false,
        problems: ["template_not_valid_for_state"],
        invalidNotice: OFFICE_REPLIED_NOTICE,
        createdAt: "2026-11-05T09:00:00.000Z",
      },
    };
    const html = renderToStaticMarkup(createElement(ReplyPanel, { reply, run }));
    expect(html).toContain(`<p class="warn" role="status">${OFFICE_REPLIED_NOTICE} (template_not_valid_for_state)</p>`);
    expect(html).toContain("The office replied. This draft no longer fits.");
    expect(html).toMatch(/<button disabled="">Approve and send \(simulated\)<\/button>/);
    // O-h: readback ticks are not saved across a reopen, and the panel says so.
    expect(html).toContain("Your ticks are not saved. If you close and reopen the app, the draft and your edit are kept, and you read each field again.");
  });
});
