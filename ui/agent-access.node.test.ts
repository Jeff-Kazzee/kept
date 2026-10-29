// What an agent wrote, as the person sees it: an external agent's note and
// its unconfirmed report as untrusted text, the archived toggle and the live
// refresh check. Rendered to static markup with the server renderer, from
// state the real API returns. Grants, proposals and pairing are gone (0009),
// so an external agent's words reach the case through the actions an MCP
// client calls, with the actor "mcp".
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi } from "../server/api.ts";
import { CaseActions, YOU } from "../src/actions/service.ts";
import { EXTERNAL_SOURCE_LABEL } from "../src/agent/types.ts";
import { CaseService } from "../src/case/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, fixtureMessage, intake, useZone } from "../test/helpers.ts";
import { versionChanged, type AppState } from "./api.ts";
import { ReplyPanel } from "./case/ReplyCard.tsx";
import { stampTime } from "./format.ts";
import { Agenda, RecordNotes, UNCONFIRMED_WORDS, activeArchive } from "./schedule/Agenda.tsx";
import { ChecklistPanel } from "./schedule/CaseTabs.tsx";
import { setCaseZone } from "./format.ts";

// These tests read times as the demo shows them, in the clinic's zone. The
// app's own default is UTC, as the server's.
setCaseZone("America/Denver");

const run = async () => {};
const THU = "2026-11-12T10:30";
const MCP = { actor: "mcp" as const };

// A case with m2 accepted and an external agent's note on Thursday, read
// through the API as the page reads it.
async function caseState(clock = () => "2026-11-06T17:00:00.000Z") {
  const store = new EventStore(":memory:", clock);
  useZone(store);
  const svc = intake(store);
  const client = RecordedModelClient.fromDirectory();
  const kase = new CaseService(store, svc, client);
  const records = new RecordsService(store, svc, kase);
  const reply = new ReplyService(store, kase, client);
  const actions = new CaseActions(store, { intake: svc, kase, reply, records });
  await acceptMessages(svc, ["m2"]);
  actions.addNote(MCP, THU, "Bring parking pass <b>now</b>", 0);
  const api = createApi(svc, kase, {}, reply, { store, records });
  const state = async () => (await api({ method: "GET", path: "/api/state", body: undefined })).body as AppState;
  return { store, svc, actions, state };
}

describe("agent text in the case", () => {
  it("an external agent's note is labeled with its name and shown as untrusted text, never as markup", async () => {
    const { state } = await caseState();
    const html = renderToStaticMarkup(createElement(RecordNotes, { record: (await state()).records.find((r) => r.id === THU) }));
    expect(html).toContain("Note by an external agent, 2026-11-06 10:00 MST. Untrusted text, shown as data.");
    expect(html).toContain("<pre>Bring parking pass &lt;b&gt;now&lt;/b&gt;</pre>");
  });

  it("G-f: an archived slot leaves the list, and Show archived lists it with Undo", async () => {
    const { state, actions } = await caseState();
    const record = (await state()).records.find((r) => r.id === THU)!;
    actions.archive(YOU, THU, record.version);
    const s = await state();
    const hidden = renderToStaticMarkup(createElement(Agenda, { state: s, run }));
    expect(hidden).toContain("Show archived (1)");
    expect(hidden).not.toContain("Thursday 11/12 10:30 AM");
    expect(hidden).toContain("Every appointment is archived.");
    const shown = renderToStaticMarkup(createElement(Agenda, { state: s, run, initialShowArchived: true }));
    // Review 1, finding 7: an appointment can take focus when a fact chip
    // opens the schedule at it.
    expect(shown).toMatch(/<article id="slot-20261112-1030" tabindex="-1"/i);
    expect(shown).toContain("Thursday 11/12 10:30 AM");
    expect(shown).toContain('<span class="badge">Archived</span>');
    expect(shown).toContain(" Undo archive</button>");
    expect(activeArchive(s.records.find((r) => r.id === THU))).not.toBeNull();
  });

  it("0009 D1: an external agent's report that the office never confirmed stays muted on the slot, as untrusted text, and sets no state", async () => {
    const { state, actions, svc } = await caseState();
    const report = fixtureMessage("s5-report");
    const m = actions.importMessage(MCP, { ...report, channel: "user_report" }, { suggested: [], note: EXTERNAL_SOURCE_LABEL, agentName: "an external agent" });
    await actions.extract(MCP, m.id, { effort: "minimal", expectedVersion: m.version });
    for (const e of svc.evidence().filter((x) => x.messageId === m.id && x.status === "pending")) actions.acceptClaim(MCP, e.id, e.version);
    const s = await state();
    const thursday = s.case.slots.find((x) => x.key === THU)!;
    expect(thursday.stateLabel).toBe("Confirmed · office message");
    expect(thursday.unconfirmedEvidenceIds.length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(createElement(Agenda, { state: s, run }));
    expect(html).toContain(UNCONFIRMED_WORDS);
    expect(html).toContain("Words from an external agent. Untrusted text, shown as data.");
  });

  it("an agent's office request is labeled untrusted in the checklist", () => {
    const html = renderToStaticMarkup(
      createElement(ChecklistPanel, {
        items: [
          {
            text: "Bring <i>the</i> parking pass",
            untrustedLabel: "Words from an external agent. Untrusted text, shown as data.",
            sources: [{ evidenceId: "x-e1", quote: "Dana says bring the pass.", sourceLabel: "reported through an external agent", sourceType: "reported_by_user_via_agent", agentName: "an external agent", untrustedLabel: "Words from an external agent. Untrusted text, shown as data." }],
          },
        ],
      }),
    );
    expect(html).toContain('<div class="untrusted"><div class="label">Words from an external agent. Untrusted text, shown as data.</div><pre>Bring &lt;i&gt;the&lt;/i&gt; parking pass</pre></div>');
    expect(html).toContain("<pre>Dana says bring the pass.</pre>");
    expect(html).not.toContain("<strong>Bring");
  });

  it("a place only an agent reported is labeled untrusted in the readback", () => {
    const html = renderToStaticMarkup(
      createElement(ReplyPanel, {
        run,
        reply: {
          version: 2,
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
            origin: "manual",
            questionId: null,
            suggestionId: null,
            fields: [
              {
                name: "location",
                label: "Place",
                value: "Suite 9, 400 Elm Street",
                display: "Suite 9, 400 Elm Street",
                untrustedLabel: "Reported only by an external agent. Untrusted text, shown as data.",
                sources: [{ kind: "evidence", evidenceId: "x-e2", text: "Dana says Monday is in Suite 9.", agentName: "an external agent", untrustedLabel: "Words from an external agent. Untrusted text, shown as data." }],
              },
            ],
            renderedText: "Hello",
            text: "Hello",
            edited: false,
            claimConfirmation: null,
            valid: true,
            problems: [],
            invalidNotice: null,
            createdAt: "2026-11-05T09:00:00.000Z",
          },
        } as never,
      }),
    );
    expect(html).toContain('<p class="warn">Reported only by an external agent. Untrusted text, shown as data.</p>');
    expect(html).toContain('<div class="stack-sm"><div class="untrusted"><div class="label">Words from an external agent. Untrusted text, shown as data.</div><pre>Dana says Monday is in Suite 9.</pre></div>');
  });

  it("times show in America/Denver across the 2026-11-01 change", () => {
    expect(stampTime("2026-11-01T07:30:00.000Z")).toBe("2026-11-01 01:30 MDT");
    expect(stampTime("2026-11-01T08:30:00.000Z")).toBe("2026-11-01 01:30 MST");
    expect(stampTime("2026-10-31T18:00:00.000Z")).toBe("2026-10-31 12:00 MDT");
  });

  it("G-d: the page reloads only when the generation or the event number moved", () => {
    expect(versionChanged({ generation: 0, seq: 5 }, { generation: 0, seq: 5 })).toBe(false);
    expect(versionChanged({ generation: 0, seq: 6 }, { generation: 0, seq: 5 })).toBe(true);
    expect(versionChanged({ generation: 1, seq: 5 }, { generation: 0, seq: 5 })).toBe(true);
  });
});
