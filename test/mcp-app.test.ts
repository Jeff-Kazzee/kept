// D5 part 2 (sprint 6): the app side of agent access. The app and an MCP
// server open one database file as two processes do, each with its own
// EventStore. The app talks to the local API as the page does. Tokens are
// made at test time and never written to a file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../mcp/rate-limit.ts";
import { callTool, type McpDeps } from "../mcp/server.ts";
import { createApi, type ApiResponse } from "../server/api.ts";
import { Pairing } from "../server/guard.ts";
import { CaseService } from "../src/case/service.ts";
import type { CaseView } from "../src/case/types.ts";
import { loadCaseProfile, readFixtureText } from "../src/fixtures/load.ts";
import { GrantStore, TOKEN_PATTERN, hashToken, type GrantView } from "../src/grants/grants.ts";
import type { EvidenceView } from "../src/intake/events.ts";
import { IntakeService } from "../src/intake/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import type { ProposalView, RecordView } from "../src/records/events.ts";
import { RecordsService } from "../src/records/service.ts";
import { describeChange } from "../src/records/types.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { fixtureMessage } from "./helpers.ts";

const THU = "2026-11-12T10:30";
const MON = "2026-11-16T13:00";

type State = {
  evidence: EvidenceView[];
  case: CaseView;
  caseVersion: number;
  generation: number;
  history: Array<{ label: string }>;
  records: RecordView[];
  proposals: ProposalView[];
  grants: Array<GrantView & { lastUsedAt: string | null }>;
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
  return { store, intake, kase, reply: new ReplyService(store, kase, client), records: new RecordsService(store, intake, kase), grants: new GrantStore(store) };
}

// The app process: its API, called as the page calls it. Every write
// carries the generation of the page's latest read.
function appOn(store: EventStore) {
  const svc = services(store);
  const pairing = new Pairing();
  const handle = createApi(svc.intake, svc.kase, { mode: "recorded", pairing }, svc.reply, svc);
  let generation: number | undefined;
  // `gen` null sends no generation, as a page that never read the case.
  // The page sends the pairing code unless `code` says otherwise.
  const raw = async (method: string, p: string, body?: unknown, gen: number | null = generation ?? null, code: string | undefined = pairing.code): Promise<ApiResponse> =>
    handle({ method, path: p, body, generation: method === "GET" || gen === null ? undefined : gen, pairing: code });
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

// An MCP server process on the same file, with the token from its config.
function mcpOn(file: string, token: string): McpDeps {
  const svc = services(new EventStore(file));
  return { records: svc.records, grants: svc.grants, token, limiter: new RateLimiter(svc.store) };
}

async function addAndAccept(app: App, id: string) {
  await app.state();
  const imported = await app.call("POST", "/api/messages", fixtureMessage(id));
  await app.call("POST", `/api/messages/${id}/extract`, { expectedVersion: imported.version });
  for (const e of (await app.state()).evidence.filter((x) => x.status === "pending")) {
    await app.call("POST", `/api/evidence/${e.id}/accept`, { expectedVersion: e.version });
  }
}

// The demo story up to the question: m1 to m3 and the calendar.
async function demoToQuestion(app: App) {
  for (const id of ["m1", "m2", "m3"]) await addAndAccept(app, id);
  await app.call("POST", "/api/calendar", { name: "dana.ics", text: readFixtureText("calendar/dana.ics"), expectedVersion: 0 });
  const s = await app.state();
  return (await app.call("POST", "/api/questions/next", { expectedVersion: s.case.questionsVersion })) as CaseView;
}

// The demo story to the approved Monday reply.
async function demoToApprovedMonday(app: App) {
  const asked = await demoToQuestion(app);
  const monday = asked.question!.choices.find((c) => c.label === "Request Monday 11/16 1:00 PM")!;
  await app.call("POST", `/api/questions/${asked.question!.id}/answer`, { expectedVersion: asked.questionsVersion, choiceId: monday.id, replyVersion: asked.reply.version });
  const s = await app.state();
  const draft = s.case.reply.draft!;
  await app.call("POST", `/api/reply/drafts/${draft.id}/approve`, { expectedVersion: s.case.reply.version, confirmedFields: draft.fields.map((f) => f.name) });
  return app.state();
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

describe("SP6.1 and G-a: the grant screen's routes", () => {
  it("creates a grant with a name and tier, returns the token once, and lists it without the token or its hash", async () => {
    const app = appOn(new EventStore(tempFile()));
    await app.state();
    const created = (await app.call("POST", "/api/grants", { name: "Laptop assistant", tier: "annotate" })) as { grant: GrantView; token: string };
    expect(created.token).toMatch(TOKEN_PATTERN);
    expect(created.grant).toMatchObject({ name: "Laptop assistant", tier: "annotate", status: "active" });
    const s = await app.state();
    expect(s.grants).toEqual([expect.objectContaining({ id: created.grant.id, name: "Laptop assistant", tier: "annotate", status: "active", lastUsedAt: null })]);
    const text = JSON.stringify(s);
    expect(text).not.toContain(created.token);
    expect(text).not.toContain(hashToken(created.token));
    // The history leaves grants out.
    expect(s.history).toEqual([]);

    // A name must be 1 to 60 allowed characters and not taken by an active grant.
    expect((await app.raw("POST", "/api/grants", { name: "", tier: "read" })).status).toBe(422);
    expect((await app.raw("POST", "/api/grants", { name: "x".repeat(61), tier: "read" })).status).toBe(422);
    expect((await app.raw("POST", "/api/grants", { name: "laptop ASSISTANT", tier: "read" })).status).toBe(422);
    expect((await app.raw("POST", "/api/grants", { name: "Agent", tier: "admin" })).status).toBe(422);
    // Like every write, it needs the case generation.
    expect((await app.raw("POST", "/api/grants", { name: "Agent", tier: "read" }, null)).status).toBe(400);
    expect((await app.state()).grants).toHaveLength(1);
  });

  it("revokes with the expected version, and the agent's next call fails with no restart", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    await addAndAccept(app, "m2");
    const { grant, token } = (await app.call("POST", "/api/grants", { name: "Laptop assistant", tier: "read" })) as { grant: GrantView; token: string };
    const mcp = mcpOn(file, token);
    structured(await callTool(mcp, "list_appointments", {}));
    let s = await app.state();
    expect(s.grants[0]!.lastUsedAt).not.toBeNull();

    const stale = await app.raw("POST", `/api/grants/${grant.id}/revoke`, { expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect((await app.state()).grants[0]!.status).toBe("active");
    await app.call("POST", `/api/grants/${grant.id}/revoke`, { expectedVersion: grant.version });
    expect(toolError(await callTool(mcp, "list_appointments", {}))).toMatchObject({ error: "permission_denied" });
    s = await app.state();
    expect(s.grants[0]).toMatchObject({ status: "revoked" });
    expect(s.history.map((h) => h.label).slice(-2)).toEqual([
      "Agent call by Laptop assistant: list_appointments · ok",
      "Agent call by Laptop assistant: list_appointments · permission denied",
    ]);
  });

  it("grants survive Delete case, and their last use starts again", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    await addAndAccept(app, "m2");
    const { token } = (await app.call("POST", "/api/grants", { name: "Laptop assistant", tier: "read" })) as { token: string };
    structured(await callTool(mcpOn(file, token), "list_appointments", {}));
    const before = await app.state();
    await app.call("POST", "/api/case/delete", { expectedVersion: before.caseVersion, confirmation: "DELETE" });
    const after = await app.state();
    expect(after.grants).toEqual([expect.objectContaining({ name: "Laptop assistant", status: "active", lastUsedAt: null })]);
  });
});

describe("SP6.3 and G-d: live refresh", () => {
  it("a note written over MCP moves the version the page polls, and the next read shows it", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    const s0 = await demoToApprovedMonday(app);
    const { token } = (await app.call("POST", "/api/grants", { name: "Laptop assistant", tier: "annotate" })) as { token: string };
    const polled = await app.call("GET", "/api/case/version");
    expect(polled).toEqual((await app.state()).live);
    expect(s0.live.seq).toBeLessThan(polled.seq);

    // The agent's process, on the same file. No restart of either one.
    const mcp = mcpOn(file, token);
    const read = structured(await callTool(mcp, "get_appointment", { appointment_id: MON }));
    const afterRead = await app.call("GET", "/api/case/version");
    expect(afterRead.seq).toBeGreaterThan(polled.seq);
    structured(await callTool(mcp, "add_note", { appointment_id: MON, text: "Bring parking pass", expected_version: read.appointment.version }));
    const afterNote = await app.call("GET", "/api/case/version");
    expect(afterNote.seq).toBeGreaterThan(afterRead.seq);
    expect(afterNote.generation).toBe(polled.generation);

    const s = await app.state();
    expect(s.live).toEqual(afterNote);
    expect(s.records.find((r) => r.id === MON)!.notes).toEqual([
      expect.objectContaining({ text: "Bring parking pass", by: expect.objectContaining({ kind: "agent", grant_name: "Laptop assistant" }) }),
    ]);
    // A note changes no state.
    expect(labels(s)).toEqual(labels(s0));
    // A poll with no change returns the same version.
    expect(await app.call("GET", "/api/case/version")).toEqual(afterNote);
  });

  it("a Delete case moves the generation the page polls", async () => {
    const app = appOn(new EventStore(tempFile()));
    await addAndAccept(app, "m2");
    const s = await app.state();
    await app.call("POST", "/api/case/delete", { expectedVersion: s.caseVersion, confirmation: "DELETE" });
    expect((await app.call("GET", "/api/case/version")).generation).toBe(s.generation + 1);
  });
});

describe("the demo beat: the agent reads, annotates and proposes, and the app shows it", () => {
  it("Monday is requested and not confirmed, the note shows in the app, Thursday stays confirmed, and a proposal waits for review", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    await demoToApprovedMonday(app);
    const annotate = (await app.call("POST", "/api/grants", { name: "Laptop assistant", tier: "annotate" })) as { token: string };
    const propose = (await app.call("POST", "/api/grants", { name: "Phone helper", tier: "propose" })) as { grant: GrantView; token: string };
    const agent = mcpOn(file, annotate.token);

    // "Am I booked for Monday?"
    const listed = structured(await callTool(agent, "list_appointments", {}));
    const monday = listed.appointments.find((a: { appointment_id: string }) => a.appointment_id === MON);
    expect(monday).toMatchObject({
      state: "requested",
      state_label: "Requested · reported by you",
      state_meaning: "You asked the office for this time. The office has not confirmed it yet.",
    });
    // "Add a note to bring my parking pass."
    structured(await callTool(agent, "add_note", { appointment_id: MON, text: "Bring parking pass", expected_version: monday.version }));
    let s = await app.state();
    expect(s.records.find((r) => r.id === MON)!.notes.map((n) => n.text)).toEqual(["Bring parking pass"]);
    expect(labels(s)[THU]).toBe("Confirmed · office message, change proposed");
    expect(labels(s)[MON]).toBe("Requested · reported by you");

    // The propose grant reports the office confirmed Monday by phone. It
    // waits in the review queue and changes nothing.
    const proposer = mcpOn(file, propose.token);
    const proposed = structured(
      await callTool(proposer, "propose_change", {
        change: { kind: "user_report", claim_type: "confirm", date: "2026-11-16", time: "13:00", statement: "Dana says the office confirmed Monday by phone." },
      }),
    );
    s = await app.state();
    const pending = s.proposals.filter((p) => p.status === "pending");
    expect(pending).toEqual([expect.objectContaining({ id: proposed.proposal_id, grantName: "Phone helper" })]);
    expect(describeChange(pending[0]!.change)).toBe("The office confirmed Monday 11/16 1:00 PM.");
    expect(labels(s)[MON]).toBe("Requested · reported by you");

    // G-e: confirming states the proposal's version and the generation. A
    // stale version writes nothing.
    const stale = await app.raw("POST", `/api/proposals/${proposed.proposal_id}/confirm`, { expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect((await app.raw("POST", `/api/proposals/${proposed.proposal_id}/confirm`, { expectedVersion: 1 }, null)).status).toBe(400);
    expect(labels(await app.state())[MON]).toBe("Requested · reported by you");
    await app.call("POST", `/api/proposals/${proposed.proposal_id}/confirm`, { expectedVersion: pending[0]!.version });
    s = await app.state();
    // Rule 3 (S4): a confirmation of the replacement does not release
    // Thursday, because no evidence says Thursday moved. Both stay held and
    // the app asks which one stands.
    expect(labels(s)[MON]).toBe("Confirmed · reported by you through Phone helper, change proposed");
    expect(labels(s)[THU]).toBe("Confirmed · office message, change proposed");
    expect(s.case.conflicts.map((c) => [c.kind, c.slotKeys])).toContainEqual(["both_held", [THU, MON]]);
    expect(s.proposals[0]).toMatchObject({ status: "confirmed" });
    expect(s.history.map((h) => h.label)).toContain(
      `You confirmed a report from Phone helper as claim ${proposed.proposal_id}-1: confirmation for Monday 11/16 1:00 PM`,
    );
    // The agent cannot confirm: no tool for it exists, under any tier.
    await expect(callTool(proposer, "confirm_proposal", { proposal_id: proposed.proposal_id })).rejects.toThrow("Unknown tool.");
  });

  it("G-e: rejecting a proposal states its version and changes no state", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    await addAndAccept(app, "m2");
    const { token } = (await app.call("POST", "/api/grants", { name: "Phone helper", tier: "propose" })) as { token: string };
    const r = structured(
      await callTool(mcpOn(file, token), "propose_change", {
        change: { kind: "user_report", claim_type: "cancel", date: "2026-11-12", time: "10:30", statement: "Dana canceled Thursday." },
      }),
    );
    const before = await app.state();
    expect((await app.raw("POST", `/api/proposals/${r.proposal_id}/reject`, { expectedVersion: 2 })).status).toBe(409);
    await app.call("POST", `/api/proposals/${r.proposal_id}/reject`, { expectedVersion: 1 });
    const after = await app.state();
    expect(after.proposals[0]).toMatchObject({ status: "rejected" });
    expect(labels(after)).toEqual(labels(before));
    expect((await app.raw("POST", `/api/proposals/${r.proposal_id}/confirm`, { expectedVersion: 2 })).status).toBe(422);
  });

  it("G-e: confirming a proposed archive states the record version the user saw", async () => {
    const file = tempFile();
    const app = appOn(new EventStore(file));
    await addAndAccept(app, "m2");
    const { token } = (await app.call("POST", "/api/grants", { name: "Phone helper", tier: "propose" })) as { token: string };
    const mcp = mcpOn(file, token);
    const r = structured(await callTool(mcp, "propose_change", { change: { kind: "archive", appointment_id: THU, expected_version: 0, statement: "Dana no longer needs Thursday." } }));
    // Confirming an archive needs the record version.
    expect((await app.raw("POST", `/api/proposals/${r.proposal_id}/confirm`, { expectedVersion: 1 })).status).toBe(422);
    expect((await app.raw("POST", `/api/proposals/${r.proposal_id}/confirm`, { expectedVersion: 1, recordVersion: 3 })).status).toBe(409);
    await app.call("POST", `/api/proposals/${r.proposal_id}/confirm`, { expectedVersion: 1, recordVersion: 0 });
    expect((await app.state()).records.find((x) => x.id === THU)).toMatchObject({ archived: true });
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
    // A stale archive writes nothing.
    expect((await app.raw("POST", `/api/records/${THU}/archive`, { expectedVersion: 1 })).status).toBe(409);
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
    expect(approve).toMatchObject({ status: 422, body: { message: `Appointment ${MON} is archived. Undo the archive first.` } });
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
