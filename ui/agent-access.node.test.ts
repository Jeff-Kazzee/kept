// What an agent wrote, as the user sees it: agent notes and agent reports
// as untrusted text, the archived toggle and the live refresh check.
// Rendered to static markup with the server renderer, from state the real
// API returns. The grant screen, proposal cards and pairing screen are gone
// (sprint 9, 0011). The records service still takes a confirmed agent
// report, which is how an external agent's words reach the case here.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi } from "../server/api.ts";
import { CaseService } from "../src/case/service.ts";
import { GrantStore } from "../src/grants/grants.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, intake } from "../test/helpers.ts";
import { versionChanged, type AppState } from "./api.ts";
import { ReplyPanel } from "./case/ReplyCard.tsx";
import { stampTime } from "./format.ts";
import { Agenda, RecordNotes, activeArchive } from "./schedule/Agenda.tsx";
import { ChecklistPanel } from "./schedule/CaseTabs.tsx";

const run = async () => {};
const THU = "2026-11-12T10:30";

// A case with m2 accepted, a propose grant, an agent note on Thursday and a
// pending proposal, read through the API as the page reads it.
async function caseState(clock = () => "2026-11-06T17:00:00.000Z") {
  const store = new EventStore(":memory:", clock);
  const svc = intake(store);
  const client = RecordedModelClient.fromDirectory();
  const kase = new CaseService(store, svc, client);
  const records = new RecordsService(store, svc, kase);
  const grants = new GrantStore(store);
  await acceptMessages(svc, ["m2"]);
  const { grant } = grants.create("Phone helper", "propose");
  const agent = { kind: "agent" as const, grant_id: grant.id, grant_name: grant.name };
  records.addNote(THU, "Bring parking pass <b>now</b>", 0, agent);
  records.propose({ kind: "user_report", claim_type: "confirm", date: "2026-11-16", time: "13:00", statement: "Dana says the office confirmed Monday by phone." }, grant);
  const api = createApi(svc, kase, { mode: "recorded" }, new ReplyService(store, kase, client), { records, grants });
  const state = async () => (await api({ method: "GET", path: "/api/state", body: undefined })).body as AppState;
  return { store, records, grants, state };
}

describe("agent text in the case", () => {
  it("an agent's note is labeled with its grant and shown as untrusted text, never as markup", async () => {
    const { state } = await caseState();
    const html = renderToStaticMarkup(createElement(RecordNotes, { record: (await state()).records.find((r) => r.id === THU) }));
    expect(html).toContain("Note by Phone helper, 2026-11-06 10:00 MST. Untrusted text, shown as data.");
    expect(html).toContain("<pre>Bring parking pass &lt;b&gt;now&lt;/b&gt;</pre>");
  });

  it("G-f: an archived slot leaves the list, and Show archived lists it with Undo", async () => {
    const { state, records } = await caseState();
    records.archive(THU, 1);
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
    expect(activeArchive(s.records.find((r) => r.id === THU))).toBe(2);
  });

  it("a confirmed agent report shows its statement as untrusted text in the slot list", async () => {
    const { state, records } = await caseState();
    const p = records.proposals().find((x) => x.status === "pending")!;
    records.confirmProposal(p.id, p.version);
    const html = renderToStaticMarkup(createElement(Agenda, { state: await state(), run }));
    expect(html).toContain("Confirmed · reported by you through Phone helper");
    expect(html).toContain('<span class="badge badge-confirmed">Confirmed</span><span class="small muted">reported by you through Phone helper</span>');
    expect(html).toContain(
      `<div class="untrusted"><div class="label">${p.id}-1 · words from Phone helper. Untrusted text, shown as data.</div><pre>Dana says the office confirmed Monday by phone.</pre></div>`,
    );
    expect(html).not.toContain("“Dana says");
  });

  it("finding 2: an agent's office request is labeled untrusted in the checklist data and on screen", async () => {
    const { state, records, grants } = await caseState();
    const grant = grants.list()[0]!;
    const p = records.propose({ kind: "user_report", claim_type: "office_request", date: null, request_item: "Bring <i>the</i> parking pass", statement: "Dana says bring the pass." }, grant);
    records.confirmProposal(p.id, p.version);
    const item = (await state()).case.checklist.at(-1)!;
    expect(item).toMatchObject({ text: "Bring <i>the</i> parking pass", untrustedLabel: "Words from Phone helper. Untrusted text, shown as data." });
    expect(item.sources[0]).toMatchObject({ agentName: "Phone helper", untrustedLabel: "Words from Phone helper. Untrusted text, shown as data." });
    const html = renderToStaticMarkup(createElement(ChecklistPanel, { items: [item] }));
    expect(html).toContain(
      '<div class="untrusted"><div class="label">Words from Phone helper. Untrusted text, shown as data.</div><pre>Bring &lt;i&gt;the&lt;/i&gt; parking pass</pre></div>',
    );
    expect(html).toContain('<pre>Dana says bring the pass.</pre>');
    expect(html).not.toContain("<strong>Bring");
    expect(html).not.toContain("“Dana says");
  });

  it("finding 2: a place only an agent reported is labeled untrusted in the reply fields and the readback", async () => {
    const store = new EventStore(":memory:", () => "2026-11-06T17:00:00.000Z");
    const svc = intake(store);
    const client = RecordedModelClient.fromDirectory();
    const kase = new CaseService(store, svc, client, { userName: "Dana Reyes" });
    const records = new RecordsService(store, svc, kase);
    const reply = new ReplyService(store, kase, client);
    await acceptMessages(svc, ["m1", "m2", "m3"]);
    const { grant } = new GrantStore(store).create("Phone helper", "propose");
    const MON = "2026-11-16T13:00";
    // m3 offers Monday with no place. The agent reports one.
    const p = records.propose({ kind: "detail_edit", appointment_id: MON, expected_version: 0, location: "Suite 9, 400 Elm Street", statement: "Dana says Monday is in Suite 9." }, grant);
    records.confirmProposal(p.id, p.version, { recordVersion: 0 });
    const view = reply.start("accept_offer", MON, kase.view().reply.version);
    const place = view.reply.draft!.fields.find((f) => f.name === "location")!;
    expect(place).toMatchObject({
      value: "Suite 9, 400 Elm Street",
      untrustedLabel: "Reported only by Phone helper. Untrusted text, shown as data.",
      sources: [{ kind: "evidence", evidenceId: `${p.id}-1`, text: "Dana says Monday is in Suite 9.", agentName: "Phone helper", untrustedLabel: "Words from Phone helper. Untrusted text, shown as data." }],
    });
    // Fields from the office carry no label.
    expect(view.reply.draft!.fields.find((f) => f.name === "office_name")).not.toHaveProperty("untrustedLabel");
    const html = renderToStaticMarkup(createElement(ReplyPanel, { reply: view.reply, run }));
    expect(html).toContain('<p class="warn">Reported only by Phone helper. Untrusted text, shown as data.</p>');
    expect(html).toContain(`<code class="small muted">${p.id}-1</code><div class="untrusted"><div class="label">Words from Phone helper. Untrusted text, shown as data.</div><pre>Dana says Monday is in Suite 9.</pre></div>`);
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
