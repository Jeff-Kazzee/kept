// The app side of agent access (sprint 6, and 0009 for sprint 8). The app
// and an MCP server open one database file as two processes do, each with
// its own EventStore. The app talks to the local API as the page does. An
// external agent acts with no grant, every action is in the activity log
// with actor "mcp", and the person undoes it from the app.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../mcp/rate-limit.ts";
import { callTool, type McpDeps } from "../mcp/server.ts";
import { createApi, type ApiResponse } from "../server/api.ts";
import type { ActivityView } from "../src/activity/types.ts";
import { fixtureMessageIds } from "../src/agent/recorded.ts";
import { defaultMessageId } from "../src/agent/tools.ts";
import { CaseService } from "../src/case/service.ts";
import type { CaseView } from "../src/case/types.ts";
import { loadCaseProfile, readFixtureText } from "../src/fixtures/load.ts";
import type { EvidenceView } from "../src/intake/events.ts";
import { IntakeService } from "../src/intake/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import type { RecordView } from "../src/records/events.ts";
import { RecordsService } from "../src/records/service.ts";
import { buildDraft } from "../src/reply/draft.ts";
import { REPLY_STREAM, draftEvents } from "../src/reply/events.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { fixtureMessage } from "./helpers.ts";

const THU = "2026-11-12T10:30";
const MON = "2026-11-16T13:00";
const TUE = "2026-11-10T14:00";

type State = {
  evidence: EvidenceView[];
  case: CaseView;
  caseVersion: number;
  generation: number;
  history: Array<{ label: string }>;
  records: RecordView[];
  activity: ActivityView;
  live: { generation: number; seq: number };
};

const dirs: string[] = [];
const open: EventStore[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-app-"));
  dirs.push(dir);
  return path.join(dir, "app.sqlite");
}

// Services on one connection to the file, as one process has.
function services(store: EventStore) {
  open.push(store);
  const client = RecordedModelClient.fromDirectory();
  const intake = new IntakeService(store, client);
  const kase = new CaseService(store, intake, client, { userName: loadCaseProfile().user_name });
  return { store, intake, kase, reply: new ReplyService(store, kase, client), records: new RecordsService(store, intake, kase) };
}

// The app process: its API, called as the page calls it. Every write
// carries the generation of the page's latest read.
function appOn(store: EventStore) {
  const svc = services(store);
  const handle = createApi(svc.intake, svc.kase, { mode: "recorded" }, svc.reply, svc);
  let generation: number | undefined;
  // `gen` null sends no generation, as a page that never read the case.
  const raw = async (method: string, p: string, body?: unknown, gen: number | null = generation ?? null): Promise<ApiResponse> =>
    handle({ method, path: p, body, generation: method === "GET" || gen === null ? undefined : gen });
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await raw(method, p, body);
    if (res.status !== 200) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as any;
  };
  const state = async () => {
    const s = (await call("GET", "/api/state")) as State;
    generation = s.generation;
    return s;
  };
  return { ...svc, raw, call, state };
}

type App = ReturnType<typeof appOn>;

// An MCP server process on the same file, in recorded mode.
function mcpOn(file: string): McpDeps {
  const svc = services(new EventStore(file));
  return { store: svc.store, services: svc, limiter: new RateLimiter(), messageIdFor: fixtureMessageIds(defaultMessageId), now: () => "2026-11-06T17:00:00.000Z" };
}

async function addAndAccept(app: App, id: string) {
  await app.state();
  const imported = await app.call("POST", "/api/messages", fixtureMessage(id));
  await app.call("POST", `/api/messages/${id}/extract`, { expectedVersion: imported.version });
  for (const e of (await app.state()).evidence.filter((x) => x.status === "pending")) {
    await app.call("POST", `/api/evidence/${e.id}/accept`, { expectedVersion: e.version });
  }
}

// The demo story up to the question: m1 to m3 and the calendar, which sets
// the demo's zone.
async function demoToQuestion(app: App) {
  for (const id of ["m1", "m2", "m3"]) await addAndAccept(app, id);
  await app.call("POST", "/api/calendar", { name: "dana.ics", text: readFixtureText("calendar/dana.ics"), expectedVersion: 0 });
  const s = await app.state();
  return (await app.call("POST", "/api/questions/next", { expectedVersion: s.case.questionsVersion })) as CaseView;
}

const labels = (s: State) => Object.fromEntries(s.case.slots.map((x) => [x.key, x.stateLabel]));
const structured = (r: Awaited<ReturnType<typeof callTool>>) => {
  expect("structuredContent" in r).toBe(true);
  return (r as { structuredContent: Record<string, any> }).structuredContent;
};
const toolError = (r: Awaited<ReturnType<typeof callTool>>) => {
  expect("isError" in r && r.isError).toBe(true);
  return JSON.parse(r.content[0]!.text) as { error: string; message: string };
};

describe("SP6.3 and G-d: live refresh", () => {
  it("a note written over MCP moves the version the page polls, and the next read shows it with its activity entry", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    await addAndAccept(app, "m2");
    const agent = mcpOn(file);
    const before = (await app.call("GET", "/api/case/version")) as { generation: number; seq: number };
    const r = structured(await callTool(agent, "add_note", { slot_key: THU, text: "Parking is on Elm Street.", expected_version: 0 }));
    expect(r.activity).toMatchObject({ undoable: true });
    const after = (await app.call("GET", "/api/case/version")) as { generation: number; seq: number };
    expect(after.generation).toBe(before.generation);
    expect(after.seq).toBeGreaterThan(before.seq);
    const s = await app.state();
    expect(s.records.find((x) => x.id === THU)!.notes.map((n) => n.text)).toEqual(["Parking is on Elm Street."]);
    expect(s.activity.entries[0]).toMatchObject({ actor: "mcp", kind: "note_added", target: { type: "note", id: `${THU}#n1` } });
  });

  it("a Delete case moves the generation the page polls", async () => {
    const app = appOn(new EventStore(tempFile()));
    await addAndAccept(app, "m2");
    const s = await app.state();
    await app.call("POST", "/api/case/delete", { expectedVersion: s.caseVersion, confirmation: "DELETE" });
    expect(((await app.call("GET", "/api/case/version")) as { generation: number }).generation).toBe(s.generation + 1);
  });
});

describe("the demo beat over MCP: the agent works the case, and the person undoes and approves", () => {
  it("imports and accepts m3, reads that Monday is offered, archives Tuesday, and the person sees and undoes it", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    for (const id of ["m1", "m2"]) await addAndAccept(app, id);
    await app.call("POST", "/api/calendar", { name: "dana.ics", text: readFixtureText("calendar/dana.ics"), expectedVersion: 0 });
    const agent = mcpOn(file);

    // The agent adds the office's text and accepts its claims.
    const imported = structured(await callTool(agent, "import_message", { text: fixtureMessage("m3").text, channel: "sms", from: "Lantern Hill Clinic", received_at: fixtureMessage("m3").received_at }));
    expect(imported).toMatchObject({ message_id: "m3", source: { source_type: "office_message", suggested: ["channel", "from", "received_at"] } });
    const accepted = structured(
      await callTool(agent, "accept_claim", { claims: imported.claims.map((c: { evidence_id: string; version: number }) => ({ evidence_id: c.evidence_id, expected_version: c.version })) }),
    );
    expect(accepted).toMatchObject({ decided: 3, refused: 0 });
    let s = await app.state();
    expect(labels(s)).toMatchObject({ [THU]: "Confirmed · office message, change proposed", [MON]: "Offered · office message" });
    // The person sees where the message came from.
    expect(s.evidence.find((e) => e.id === "m3-e3")!.claim.source_note).toBe("Added by an external agent");

    const schedule = structured(await callTool(agent, "get_schedule", {}));
    const mon = schedule.appointments.find((a: { slot_key: string }) => a.slot_key === MON);
    expect(mon).toMatchObject({ state: "offered", state_meaning: "The office offered this time. You have not accepted it." });
    expect(schedule.time_zone).toMatchObject({ name: "America/Denver", set_by: "agent" });

    const archived = structured(await callTool(agent, "archive_appointment", { slot_key: TUE, expected_version: 0 }));
    expect(archived).toMatchObject({ archived: true, record_version: 1 });
    s = await app.state();
    expect(s.activity.entries.slice(0, 5).map((e) => [e.actor, e.kind, e.undoable])).toEqual([
      ["mcp", "appointment_archived", true],
      ["mcp", "claim_accepted", true],
      ["mcp", "claim_accepted", true],
      ["mcp", "claim_accepted", true],
      ["mcp", "message_imported", true],
    ]);

    // A page that read an older activity version is refused, then the
    // person undoes the archive.
    const entry = s.activity.entries[0]!;
    expect(await app.raw("POST", `/api/activity/${entry.id}/undo`, { expectedVersion: s.activity.activityVersion - 1 })).toMatchObject({ status: 409, body: { error: "stale_edit" } });
    const view = (await app.call("POST", `/api/activity/${entry.id}/undo`, { expectedVersion: s.activity.activityVersion })) as CaseView;
    expect(view.slots.map((x) => x.key)).toContain(TUE);
    s = await app.state();
    expect(s.records.find((x) => x.id === TUE)!.archived).toBe(false);
    expect(s.activity.entries[0]).toMatchObject({ actor: "you", kind: "undo", undoable: false, summary: "Undid: Archived Tuesday 11/10 2:00 PM." });
    expect(s.activity.entries[1]).toMatchObject({ id: entry.id, undone: true, undoable: false });
    // Undoing it twice says why not.
    expect(await app.raw("POST", `/api/activity/${entry.id}/undo`, { expectedVersion: s.activity.activityVersion })).toMatchObject({
      status: 409,
      body: { error: "undo_blocked", message: "This was already undone." },
    });
  });

  it("refuses to undo an agent's accepted fact once a reply that depends on it is approved, with a plain reason", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    for (const id of ["m1", "m2"]) await addAndAccept(app, id);
    const agent = mcpOn(file);
    const imported = structured(await callTool(agent, "import_message", { text: fixtureMessage("m3").text, channel: "sms", from: null, received_at: null }));
    structured(await callTool(agent, "accept_claim", { claims: imported.claims.map((c: { evidence_id: string; version: number }) => ({ evidence_id: c.evidence_id, expected_version: c.version })) }));

    // The agent opens the reply, and only the person approves it.
    let s = await app.state();
    const started = structured(await callTool(agent, "start_reply", { template: "accept_offer", slot_key: MON, expected_version: s.case.reply.version }));
    expect(toolError(await callTool(agent, "approve_reply", { draft_id: started.draft_id }).catch((e: Error) => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: "protocol", message: e.message }) }] })))).toMatchObject({ error: "protocol" });
    s = await app.state();
    const draft = s.case.reply.draft!;
    await app.call("POST", `/api/reply/drafts/${draft.id}/approve`, { expectedVersion: s.case.reply.version, confirmedFields: draft.fields.map((f) => f.name) });
    s = await app.state();
    expect(labels(s)[MON]).toBe("Requested · reported by you");

    // Undoing the agent's acceptance of the Monday offer is refused.
    const mondayOffer = s.activity.entries.find((e) => e.kind === "claim_accepted" && e.target?.id === "m3-e3")!;
    const refused = await app.raw("POST", `/api/activity/${mondayOffer.id}/undo`, { expectedVersion: s.activity.activityVersion });
    expect(refused).toMatchObject({
      status: 409,
      body: { error: "undo_blocked", message: "A reply for Monday 11/16 1:00 PM was approved after this and depends on it. A sent reply cannot be unsent, so this cannot be undone." },
    });
    // The Tuesday offer from m1 does not depend on it, and the person's own
    // acceptance of it undoes.
    const tuesdayOffer = s.activity.entries.find((e) => e.kind === "claim_accepted" && e.target?.id === "m1-e1")!;
    await app.call("POST", `/api/activity/${tuesdayOffer.id}/undo`, { expectedVersion: s.activity.activityVersion });
    s = await app.state();
    expect(s.evidence.find((e) => e.id === "m1-e1")!.status).toBe("pending");
    expect(labels(s)[TUE]).toBeUndefined();
  });
});

describe("G-f: archive in the app", () => {
  it("an archived slot leaves the question queue and the reply panel, and undo brings both back", async () => {
    const app = appOn(new EventStore(tempFile()));
    const asked = await demoToQuestion(app);
    expect(asked.question).not.toBeNull();
    let s = await app.state();
    const conflictSlots = s.case.conflicts[0]!.slotKeys;
    expect(conflictSlots).toContain(THU);
    expect(s.case.reply.options.some((o) => o.slotKey === THU)).toBe(true);

    await app.call("POST", `/api/records/${THU}/archive`, { expectedVersion: 0 });
    s = await app.state();
    const record = s.records.find((r) => r.id === THU)!;
    expect(record).toMatchObject({ archived: true, version: 1 });
    // Its state and its conflict stay. The question is not asked.
    expect(labels(s)[THU]).toBe("Confirmed · office message, change proposed");
    expect(s.case.conflicts[0]).toMatchObject({ archivedSlotKeys: [THU], status: "open" });
    expect(s.case.question).toBeNull();
    expect(s.case.waiting).toBe(0);
    expect((await app.raw("POST", "/api/questions/next", { expectedVersion: s.case.questionsVersion })).status).toBe(422);
    expect((await app.raw("POST", `/api/questions/${asked.question!.id}/answer`, { expectedVersion: s.case.questionsVersion, choiceId: asked.question!.choices[0]!.id, replyVersion: s.case.reply.version })).status).toBe(422);
    // The reply panel offers nothing for it, and a draft for it is refused.
    expect(s.case.reply.options.some((o) => o.slotKey === THU)).toBe(false);
    expect(s.case.reply.withheld.some((o) => o.slotKey === THU)).toBe(false);
    const started = await app.raw("POST", "/api/reply/drafts", { expectedVersion: s.case.reply.version, template: "keep_original", slotKey: THU });
    expect(started).toMatchObject({ status: 422, body: { message: expect.stringContaining("slot_archived") } });

    // Undo names the archive event by its version.
    await app.call("POST", `/api/records/${THU}/undo`, { expectedVersion: 1, version: 1 });
    s = await app.state();
    expect(s.records.find((r) => r.id === THU)).toMatchObject({ archived: false, version: 2 });
    expect(s.case.question?.id).toBe(asked.question!.id);
    expect(s.case.reply.options.some((o) => o.slotKey === THU)).toBe(true);
    expect(s.history.map((h) => h.label).slice(-2)).toEqual([`${THU} archived by you`, `Undo on ${THU} by you: reversed version 1`]);
    expect(s.activity.entries.slice(0, 2).map((e) => [e.actor, e.kind])).toEqual([
      ["you", "record_change_undone"],
      ["you", "appointment_archived"],
    ]);
    // A stale archive writes nothing.
    expect((await app.raw("POST", `/api/records/${THU}/archive`, { expectedVersion: 1 })).status).toBe(409);
  });

  it("finding 7: list_open_questions over MCP leaves out a conflict on an archived slot, as the app does", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    const asked = await demoToQuestion(app);
    const agent = mcpOn(file);
    let r = structured(await callTool(agent, "list_open_questions", {}));
    expect(r.conflicts.map((c: { appointment_ids: string[] }) => c.appointment_ids)).toEqual([expect.arrayContaining([THU])]);
    expect(r.question).toMatchObject({ question_id: asked.question!.id });

    await app.call("POST", `/api/records/${THU}/archive`, { expectedVersion: 0 });
    r = structured(await callTool(agent, "list_open_questions", {}));
    expect(r).toMatchObject({ conflicts: [], question: null });

    await app.call("POST", `/api/records/${THU}/undo`, { expectedVersion: 1, version: 1 });
    r = structured(await callTool(agent, "list_open_questions", {}));
    expect(r.conflicts).toHaveLength(1);
    expect(r.question).toMatchObject({ question_id: asked.question!.id });
  });

  it("an open draft for a slot the user archives cannot be approved, and an archive that commits after approval read the case stops it", async () => {
    const file = tempFile();
    // The app's approval reads the case, then another tab archives Monday
    // before the approval's transaction takes the lock.
    let other: App | null = null;
    let armed = false;
    class GapStore extends EventStore {
      override transaction<T>(fn: () => T): T {
        if (armed) {
          armed = false;
          void other!.records.archive(MON, other!.records.record(MON).version);
        }
        return super.transaction(fn);
      }
    }
    const app = appOn(new GapStore(file));
    other = appOn(new EventStore(file));
    const asked = await demoToQuestion(app);
    const monday = asked.question!.choices.find((c) => c.label === "Request Monday 11/16 1:00 PM")!;
    await app.call("POST", `/api/questions/${asked.question!.id}/answer`, { expectedVersion: asked.questionsVersion, choiceId: monday.id, replyVersion: asked.reply.version });
    let s = await app.state();
    const draft = s.case.reply.draft!;
    expect(draft).toMatchObject({ slotKey: MON, valid: true });
    const before = labels(s);

    armed = true;
    const approve = await app.raw("POST", `/api/reply/drafts/${draft.id}/approve`, { expectedVersion: s.case.reply.version, confirmedFields: draft.fields.map((f) => f.name) });
    // The approval and its checks run in one transaction, so the archive
    // that committed first stops it.
    expect(approve).toMatchObject({ status: 422, body: { message: expect.stringContaining("slot_archived") } });
    s = await app.state();
    expect(s.case.reply.sent).toEqual([]);
    expect(labels(s)).toEqual(before);
    // Now the stored draft shows as no longer fitting.
    expect(s.case.reply.draft).toMatchObject({ valid: false, problems: ["slot_archived"] });

    // After undo the same draft is valid again and approval works.
    const record = s.records.find((r) => r.id === MON)!;
    await app.call("POST", `/api/records/${MON}/undo`, { expectedVersion: record.version, version: record.version });
    s = await app.state();
    expect(s.case.reply.draft).toMatchObject({ valid: true });
    await app.call("POST", `/api/reply/drafts/${draft.id}/approve`, { expectedVersion: s.case.reply.version, confirmedFields: draft.fields.map((f) => f.name) });
    expect(labels(await app.state())[MON]).toBe("Requested · reported by you");
  });
});

describe("review round 2, B6: a stored draft's field sources and labels", () => {
  const MON_KEY = MON;
  // A place correction an old grant reported and the person confirmed,
  // written as a sprint 6 build wrote it.
  const agentPlace = (store: EventStore, id: string, key: string, location: string) => {
    const [date, time] = key.split("T");
    store.append(`evidence:${id}-1`, 0, [
      {
        type: "agent_report_confirmed",
        data: {
          proposal_id: id,
          grant_id: "g-1",
          claim: {
            claim_type: "clarify",
            slot: { date: date!, time: time ?? null, location },
            quote: "Dana says the place is this one.",
            source_type: "reported_by_user_via_agent",
            sender_kind: "person",
            evidence_time: "2026-11-06T17:00:00.000Z",
            event_time: null,
            request_item: null,
            agent_name: "Phone helper",
          },
        },
      },
    ]);
  };

  it("a draft stored before sources carried labels shows the current labels and is stale until made again", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    await demoToQuestion(app);
    // A place an old grant reported, which the person confirmed before
    // sprint 8.
    agentPlace(app.store, "p-1", MON_KEY, "Suite 9, 400 Elm Street");
    // The failing case: a draft written by the sprint 5 code, whose fields
    // carry no agent name and no label.
    const { context, log } = app.kase.replyState();
    const built = buildDraft("accept_offer", MON_KEY, context);
    if (!built.ok) throw new Error("draft not built");
    const old = built.content.fields.map(({ untrustedLabel: _l, ...f }) => ({ ...f, sources: f.sources.map(({ agentName: _a, untrustedLabel: _u, ...src }) => src) }));
    const events = draftEvents(log, {
      template: "accept_offer",
      slot_key: MON_KEY,
      slot_label: built.content.slot.label,
      origin: "manual",
      question_id: null,
      suggestion_id: null,
      fields: old,
      declines: [],
      text: built.content.text,
    });
    app.store.append(REPLY_STREAM, log.version, events.map((e) => ({ type: e.type, data: e.data })));

    let s = await app.state();
    const draft = s.case.reply.draft!;
    expect(draft).toMatchObject({ valid: false, problems: ["case_changed"] });
    // The readback shows the labels built from the case now.
    expect(draft.fields.find((f) => f.name === "location")).toMatchObject({
      untrustedLabel: "Reported only by Phone helper. Untrusted text, shown as data.",
      sources: [expect.objectContaining({ untrustedLabel: "Words from Phone helper. Untrusted text, shown as data." })],
    });
    const refused = await app.raw("POST", `/api/reply/drafts/${draft.id}/approve`, { expectedVersion: s.case.reply.version, confirmedFields: draft.fields.map((f) => f.name) });
    expect(refused).toMatchObject({ status: 422, body: { message: expect.stringContaining("case_changed") } });
    expect(s.case.reply.sent).toEqual([]);

    // Made again, the draft is valid.
    await app.call("POST", "/api/reply/drafts", { expectedVersion: s.case.reply.version, template: "accept_offer", slotKey: MON_KEY });
    s = await app.state();
    expect(s.case.reply.draft).toMatchObject({ valid: true });
  });

  it("a draft whose place gains an agent's source, with the same value, is stale", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    await addAndAccept(app, "m2");
    let s = await app.state();
    const thu = s.case.slots.find((x) => x.key === THU)!;
    await app.call("POST", "/api/reply/drafts", { expectedVersion: s.case.reply.version, template: "ask_still_stands", slotKey: THU });
    s = await app.state();
    expect(s.case.reply.draft).toMatchObject({ valid: true });
    agentPlace(app.store, "p-1", THU, thu.location!);
    const r = { proposal_id: "p-1" };
    s = await app.state();
    // The value did not change, but the sources did.
    expect(s.case.slots.find((x) => x.key === THU)!.location).toBe(thu.location);
    expect(s.case.reply.draft).toMatchObject({ valid: false, problems: ["case_changed"] });
    const place = s.case.reply.draft!.fields.find((f) => f.name === "location")!;
    expect(place.sources.map((x) => x.evidenceId)).toContain(`${r.proposal_id}-1`);
    // An office message also states the place, so the value is not labeled.
    expect(place.untrustedLabel ?? null).toBeNull();
  });
});
