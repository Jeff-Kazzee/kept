// The demo story end to end through the local API on a database file: m1,
// m2 and m3, the calendar, extraction and review, the explanation and the
// question, Monday picked, the app closed with the draft open (S10), the
// reply approved, the app closed again, the late office reply m4 reviewed,
// Monday confirmed and Thursday canceled with the quote, the checklist with
// both items and their sources, and Delete case. Each reopen is a new
// EventStore on the same file, as a restart of the app is.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../server/api.ts";
import { CaseService } from "../src/case/service.ts";
import type { CaseView } from "../src/case/types.ts";
import { loadCaseProfile, readFixtureText } from "../src/fixtures/load.ts";
import type { EvidenceView, MessageView } from "../src/intake/events.ts";
import { IntakeService } from "../src/intake/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { ReplyService } from "../src/reply/service.ts";
import { OFFICE_REPLIED_NOTICE } from "../src/reply/view.ts";
import { EventStore } from "../src/store/event-log.ts";
import type { HistoryEntry } from "../src/case/history.ts";
import { asFreshPage, fixtureMessage } from "./helpers.ts";

const THU = "2026-11-12T10:30";
const MON = "2026-11-16T13:00";
const FRI = "2026-11-13T09:15";
const TUE = "2026-11-10T14:00";

type State = { messages: MessageView[]; evidence: EvidenceView[]; case: CaseView; caseVersion: number; history: HistoryEntry[] };

const dirs: string[] = [];
const open: EventStore[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// One app process on the file.
function start(file: string) {
  const store = new EventStore(file);
  open.push(store);
  const client = RecordedModelClient.fromDirectory();
  const intake = new IntakeService(store, client);
  const kase = new CaseService(store, intake, client, { userName: loadCaseProfile().user_name });
  const handle = asFreshPage(createApi(intake, kase, { mode: "recorded" }, new ReplyService(store, kase, client)), kase);
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await handle({ method, path: p, body });
    if (res.status !== 200) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as any;
  };
  return {
    store,
    call,
    raw: handle,
    state: () => call("GET", "/api/state") as Promise<State>,
    close: () => {
      open.splice(open.indexOf(store), 1);
      store.close();
    },
  };
}

type App = ReturnType<typeof start>;

async function addAndAccept(app: App, id: string) {
  const imported = await app.call("POST", "/api/messages", fixtureMessage(id));
  await app.call("POST", `/api/messages/${id}/extract`, { expectedVersion: imported.version });
  await acceptPending(app);
}

async function acceptPending(app: App) {
  for (const e of (await app.state()).evidence.filter((x) => x.status === "pending")) {
    await app.call("POST", `/api/evidence/${e.id}/accept`, { expectedVersion: e.version });
  }
}

const labels = (s: State) => Object.fromEntries(s.case.slots.map((x) => [x.key, x.stateLabel]));
const checklist = (s: State) => s.case.checklist.map((i) => ({ text: i.text, sources: i.sources.map((x) => [x.sourceLabel, x.quote]) }));
const filesWith = (dir: string, text: string) => readdirSync(dir).filter((f) => readFileSync(path.join(dir, f)).includes(Buffer.from(text, "utf8")));

describe("demo story", () => {
  it("runs from the first message to Delete case, across two restarts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "demo-story-"));
    dirs.push(dir);
    const file = path.join(dir, "app.sqlite");
    let app = start(file);

    // m1, m2, m3 and the calendar.
    for (const id of ["m1", "m2", "m3"]) await addAndAccept(app, id);
    await app.call("POST", "/api/calendar", { name: "dana.ics", text: readFixtureText("calendar/dana.ics"), expectedVersion: 0 });
    let s = await app.state();
    expect(labels(s)).toEqual({
      [TUE]: "Offered · office message",
      [THU]: "Confirmed · office message, change proposed",
      [FRI]: "Offered · office message",
      [MON]: "Offered · office message",
    });
    expect(s.case.slots.find((x) => x.key === FRI)!.clashes!.map((c) => c.summary)).toEqual(["Team meeting"]);

    // The explanation and the question. Dana picks Monday, which opens the
    // accept draft and changes no slot.
    const conflict = s.case.conflicts[0]!;
    expect(conflict.kind).toBe("change_proposed");
    await app.call("POST", `/api/conflicts/${conflict.id}/explain`, { expectedVersion: conflict.version });
    const asked: CaseView = await app.call("POST", "/api/questions/next", { expectedVersion: s.case.questionsVersion });
    const monday = asked.question!.choices.find((c) => c.label === "Request Monday 11/16 1:00 PM")!;
    await app.call("POST", `/api/questions/${asked.question!.id}/answer`, {
      expectedVersion: asked.questionsVersion,
      choiceId: monday.id,
      replyVersion: asked.reply.version,
    });
    s = await app.state();
    expect(s.case.reply.draft).toMatchObject({ template: "accept_offer", slotKey: MON, origin: "choice", edited: false, valid: true });
    expect(labels(s)[MON]).toBe("Offered · office message");
    expect(s.case.conflicts[0]!.explanation?.outcome).toBe("valid");

    // S10: the app closes with the draft open and before approval. The
    // reopened app shows exactly the same case.
    const beforeClose = s;
    app.close();
    app = start(file);
    s = await app.state();
    expect(s).toEqual(beforeClose);

    // Dana reads back every field and approves. The send is simulated.
    const draft = s.case.reply.draft!;
    await app.call("POST", `/api/reply/drafts/${draft.id}/approve`, {
      expectedVersion: s.case.reply.version,
      confirmedFields: draft.fields.map((f) => f.name),
    });
    s = await app.state();
    expect(s.case.reply.sent).toMatchObject([{ slotKey: MON, simulated: true, claims: "recorded" }]);
    expect(labels(s)[MON]).toBe("Requested · reported by you");

    // Closed again, then the office's reply arrives.
    const afterApproval = s;
    app.close();
    app = start(file);
    expect(await app.state()).toEqual(afterApproval);

    const m4 = await app.call("POST", "/api/messages", fixtureMessage("m4"));
    await app.call("POST", "/api/messages/m4/extract", { expectedVersion: m4.version });
    s = await app.state();
    // Extracted claims change nothing until Dana reviews them.
    expect(s.evidence.filter((e) => e.status === "pending").map((e) => [e.id, e.claim.claim_type])).toEqual([
      ["m4-e1", "confirm"],
      ["m4-e2", "cancel"],
    ]);
    expect(labels(s)).toEqual(labels(afterApproval));
    await acceptPending(app);
    s = await app.state();
    expect(labels(s)).toEqual({
      [TUE]: "Offered · office message",
      [THU]: "Canceled · office message",
      [FRI]: "Offered · office message",
      [MON]: "Confirmed · office message",
    });
    // The quote behind each new state is on screen.
    const quoteOf = (key: string) => s.evidence.find((e) => e.id === s.case.slots.find((x) => x.key === key)!.stateEvidenceId)!.claim.quote;
    expect(quoteOf(MON)).toContain("This confirms your appointment on Monday, November 16 at 1:00 PM");
    expect(quoteOf(THU)).toBe("Your Thursday, November 12 appointment is canceled.");

    // The checklist: what the office asked, each with its quote and source.
    expect(checklist(s)).toEqual([
      { text: "Bring new insurance card", sources: [["office message", "Please bring your new insurance card"]] },
      { text: "Arrive 15 minutes early", sources: [["office message", "arrive 15 minutes early"]] },
    ]);

    // The history lists the story in order, with the reply in plain words.
    const history = s.history.map((h) => h.label);
    const at = (label: string) => {
      const i = history.indexOf(label);
      expect(i, label).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at("Draft d1 started: Accept an offered slot, Monday 11/16 1:00 PM")).toBeGreaterThan(at("Question q1 answered (choice request:2026-11-16T13:00)"));
    expect(at("Draft d1 approved. Simulated send. Claims recorded.")).toBeGreaterThan(at("Draft d1 started: Accept an offered slot, Monday 11/16 1:00 PM"));
    expect(at("You accepted claim m4-e2")).toBe(history.length - 1);
    expect(s.history.map((h) => h.seq)).toEqual([...s.history.map((h) => h.seq)].sort((a, b) => a - b));

    // Delete case, with the typed confirmation. The app is empty and the
    // text is gone from the file.
    const refused = await app.raw({ method: "POST", path: "/api/case/delete", body: { expectedVersion: s.caseVersion, confirmation: "yes" } });
    expect(refused.status).toBe(422);
    const stale = await app.raw({ method: "POST", path: "/api/case/delete", body: { expectedVersion: s.caseVersion - 1, confirmation: "DELETE" } });
    expect(stale.status).toBe(409);
    await app.call("POST", "/api/case/delete", { expectedVersion: s.caseVersion, confirmation: "DELETE" });
    s = await app.state();
    expect(s).toMatchObject({ messages: [], evidence: [], caseVersion: 0, history: [] });
    expect(s.case).toMatchObject({ slots: [], conflicts: [], question: null, calendar: null, checklist: [], reply: { draft: null, sent: [] } });
    for (const text of ["Lantern Hill", "insurance card", "Dana"]) expect(filesWith(dir, text), text).toEqual([]);
  });

  it("a draft the office's reply overtakes says so in plain words, and approval stays blocked", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "demo-story-"));
    dirs.push(dir);
    const app = start(path.join(dir, "app.sqlite"));
    for (const id of ["m1", "m2", "m3"]) await addAndAccept(app, id);
    let s = await app.state();
    const asked: CaseView = await app.call("POST", "/api/questions/next", { expectedVersion: s.case.questionsVersion });
    const monday = asked.question!.choices.find((c) => c.label === "Request Monday 11/16 1:00 PM")!;
    await app.call("POST", `/api/questions/${asked.question!.id}/answer`, {
      expectedVersion: asked.questionsVersion,
      choiceId: monday.id,
      replyVersion: asked.reply.version,
    });
    expect((await app.state()).case.reply.draft).toMatchObject({ valid: true, invalidNotice: null });

    // m4 arrives before Dana approves. Extraction alone changes nothing.
    await addAndAccept(app, "m4");
    s = await app.state();
    const draft = s.case.reply.draft!;
    expect(draft).toMatchObject({ valid: false, problems: ["template_not_valid_for_state"], invalidNotice: OFFICE_REPLIED_NOTICE });
    expect(OFFICE_REPLIED_NOTICE).toMatch(/^The office replied\. This draft no longer fits\./);
    const approve = await app.raw({
      method: "POST",
      path: `/api/reply/drafts/${draft.id}/approve`,
      body: { expectedVersion: s.case.reply.version, confirmedFields: draft.fields.map((f) => f.name) },
    });
    expect(approve).toMatchObject({ status: 422, body: { error: "invalid_request" } });
    expect((await app.state()).case.reply.sent).toEqual([]);
  });
});
