// The sprint 6 panels as the user sees them: the grant screen, an agent
// proposal in the review queue, agent notes, the archived toggle and the
// live refresh check. Rendered to static markup with the server renderer,
// from state the real API returns.
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
import { GrantPanel, PROVIDER_NOTICE, ProposalCard, RecordNotes, TOKEN_NOTICE, denverTime } from "./AgentPanels.tsx";
import { SlotsPanel, activeArchive } from "./App.tsx";

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

describe("sprint 6 panels", () => {
  it("G-a: the grant screen states what the provider may receive and lists name, tier, created, last used and status", async () => {
    const { state } = await caseState();
    const html = renderToStaticMarkup(createElement(GrantPanel, { grants: (await state()).grants, run })).replaceAll("&#x27;", "'");
    expect(html).toContain(PROVIDER_NOTICE);
    expect(PROVIDER_NOTICE).toBe("Your agent's model provider may receive the case data it reads.");
    expect(TOKEN_NOTICE).toBe(
      "Shown once. Anyone with this token can use the access you chose. Your agent's model provider may receive the case data it reads.",
    );
    for (const h of ["Name", "Tier", "Created", "Last used", "Status"]) expect(html).toContain(`<th>${h}</th>`);
    expect(html).toContain("<td>Phone helper</td><td>propose</td>");
    expect(html).toContain("2026-11-06 10:00 MST");
    expect(html).toContain("not in this case");
    expect(html).toContain('maxLength="60"');
    expect(html).toContain("<button>Revoke</button>");
    // Nothing secret is on the list.
    expect(html).not.toMatch(/appt_|[0-9a-f]{64}/);
  });

  it("G-e: a proposal shows the grant name, the change in plain words and the statement as untrusted text", async () => {
    const { state, records } = await caseState();
    const s = await state();
    const html = renderToStaticMarkup(createElement(ProposalCard, { proposal: s.proposals[0]!, records: s.records, run }));
    expect(html).toContain("Proposed by Phone helper");
    expect(html).toContain("<strong>The office confirmed Monday 11/16 1:00 PM.</strong>");
    expect(html).toContain(
      '<div class="untrusted"><div class="label">What Phone helper says you told it. Untrusted text, shown as data.</div><pre>Dana says the office confirmed Monday by phone.</pre></div>',
    );
    expect(html).toContain("Confirming records this as reported by you through Phone helper.");
    expect(html).toContain("<button>Confirm</button><button>Reject</button>");

    records.confirmProposal(s.proposals[0]!.id, s.proposals[0]!.version);
    const after = await state();
    const done = renderToStaticMarkup(createElement(ProposalCard, { proposal: after.proposals[0]!, records: after.records, run }));
    expect(done).toContain("confirmed");
    expect(done).not.toContain("<button>");
  });

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
    const hidden = renderToStaticMarkup(createElement(SlotsPanel, { state: s, run }));
    expect(hidden).toContain("Show archived (1)");
    expect(hidden).not.toContain("Thursday 11/12 10:30 AM");
    expect(hidden).toContain("Every slot is archived.");
    const shown = renderToStaticMarkup(createElement(SlotsPanel, { state: s, run, initialShowArchived: true }));
    expect(shown).toContain("Thursday 11/12 10:30 AM");
    expect(shown).toContain('<div class="warn">Archived</div>');
    expect(shown).toContain("<button>Undo archive</button>");
    expect(activeArchive(s.records.find((r) => r.id === THU))).toBe(2);
  });

  it("a confirmed agent report shows its statement as untrusted text in the slot list", async () => {
    const { state, records } = await caseState();
    const p = (await state()).proposals[0]!;
    records.confirmProposal(p.id, p.version);
    const html = renderToStaticMarkup(createElement(SlotsPanel, { state: await state(), run }));
    expect(html).toContain("Confirmed · reported by you through Phone helper");
    expect(html).toContain(
      `<div class="untrusted"><div class="label">${p.id}-1 · words from Phone helper. Untrusted text, shown as data.</div><pre>Dana says the office confirmed Monday by phone.</pre></div>`,
    );
    expect(html).not.toContain("“Dana says");
  });

  it("times show in America/Denver across the 2026-11-01 change", () => {
    expect(denverTime("2026-11-01T07:30:00.000Z")).toBe("2026-11-01 01:30 MDT");
    expect(denverTime("2026-11-01T08:30:00.000Z")).toBe("2026-11-01 01:30 MST");
    expect(denverTime("2026-10-31T18:00:00.000Z")).toBe("2026-10-31 12:00 MDT");
  });

  it("G-d: the page reloads only when the generation or the event number moved", () => {
    expect(versionChanged({ generation: 0, seq: 5 }, { generation: 0, seq: 5 })).toBe(false);
    expect(versionChanged({ generation: 0, seq: 6 }, { generation: 0, seq: 5 })).toBe(true);
    expect(versionChanged({ generation: 1, seq: 5 }, { generation: 0, seq: 5 })).toBe(true);
  });
});
