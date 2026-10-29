// Sprint 13D, E1 and E2 (0017): a new case never inherits the calendar
// events of an earlier case, and the event's place is the slot's own place
// from accepted evidence, as the schedule and the reply show it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mcpContext } from "../mcp/tools.ts";
import { toolByName } from "../src/agent/tools.ts";
import { CaseService, DeleteBlockedError } from "../src/case/service.ts";
import { CALENDAR_CASE_STREAM, calendarCaseMark } from "../src/google/case-mark.ts";
import { CASE_PROPERTY, GoogleCalendar, eventIdFor } from "../src/google/calendar.ts";
import { GoogleConnection } from "../src/google/connection.ts";
import { GoogleCalendarEvents } from "../src/google/events.ts";
import { Gmail } from "../src/google/gmail.ts";
import type { GoogleServices } from "../src/google/tools.ts";
import { IntakeService } from "../src/intake/service.ts";
import { SecretsStore } from "../src/model/providers/secrets.ts";
import { RecordedModelClient, type Recording } from "../src/model/recorded.ts";
import { RecordsService } from "../src/records/service.ts";
import { slotFields } from "../src/reply/draft.ts";
import { officeOf } from "../src/reply/office.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { CLOCK } from "./agent-helpers.ts";
import { FAKE_ACCOUNT, FAKE_CLIENT, FakeGoogle, type FakeEvent } from "./google-fake.ts";
import { DEMO_ZONE, useZone } from "./helpers.ts";

const PLACE = "Lantern Hill Clinic, 400 Elm Street, Suite 2";
const claim = (over: Record<string, unknown>) => ({
  claim_type: "confirm",
  date: "2026-11-16",
  time: "13:00",
  location: null,
  quote: "This confirms your appointment on Monday, November 16 at 1:00 PM.",
  sender_kind: "person",
  event_time: null,
  request_item: null,
  ...over,
});
const recording = (id: string, claims: unknown[]): Recording => ({
  message_id: id,
  effort: "any",
  attempts: [{ output: { claims }, usage: { input: 1, cached_input: 0, output: 1, reasoning: 0 }, latency_ms: 1 }],
});
// One email that confirms Thursday at the clinic's address and Monday
// without a place, and a second that only confirms Monday.
const BOTH = "This confirms your appointment on Thursday, November 12 at 10:30 AM at Lantern Hill Clinic, 400 Elm Street, Suite 2. This confirms your appointment on Monday, November 16 at 1:00 PM.";
const MONDAY = "This confirms your appointment on Monday, November 16 at 1:00 PM.";
const RECORDINGS = [
  recording("m-both", [
    claim({ date: "2026-11-12", time: "10:30", location: PLACE, quote: "This confirms your appointment on Thursday, November 12 at 10:30 AM at Lantern Hill Clinic, 400 Elm Street, Suite 2." }),
    claim({}),
  ]),
  recording("m-monday", [claim({})]),
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function connected() {
  const dir = mkdtempSync(path.join(tmpdir(), "s13d-cal-"));
  dirs.push(dir);
  const fake = new FakeGoogle();
  const connection = new GoogleConnection({ client: FAKE_CLIENT, store: new SecretsStore(path.join(dir, "app-secrets.sqlite")), fetch: fake.fetch, now: () => fake.now });
  const flow = connection.startConnect({ expectedVersion: 0, features: { gmail: true, calendar: true }, calendarId: "primary", redirectUri: "http://127.0.0.1:5192/auth/google/callback" });
  const back = fake.consent(flow.authorizeUrl);
  await connection.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null, cookie: flow.cookie });
  const store = new EventStore(":memory:", CLOCK);
  useZone(store, DEMO_ZONE);
  const client = RecordedModelClient.withOverrides(RECORDINGS, RecordedModelClient.fromDirectory());
  const intake = new IntakeService(store, client, { now: CLOCK });
  let events: GoogleCalendarEvents | null = null;
  const kase = new CaseService(store, intake, client, { now: CLOCK, externalCalendar: () => events?.snapshot() ?? null });
  // As server/workspace.ts wires it.
  const calendar = new GoogleCalendar(connection, { timeZone: () => kase.timeZone(), caseMark: (o) => calendarCaseMark(store, o) });
  events = new GoogleCalendarEvents(calendar, { now: () => fake.now });
  const google: GoogleServices = { connection, gmail: new Gmail(connection), calendar, events };
  const app = { store, intake, kase, reply: new ReplyService(store, kase, client, { now: CLOCK }), records: new RecordsService(store, intake, kase), google };
  return { fake, app };
}

type App = Awaited<ReturnType<typeof connected>>["app"];

async function receive(app: App, id: string, text: string) {
  const m = app.intake.importMessage({ id, channel: "email", from: "Lantern Hill Clinic", received_at: "2026-10-31T09:12:00-06:00", text });
  await app.intake.extract(id, { effort: "minimal", expectedVersion: m.version });
  for (const e of app.intake.reviewQueue()) app.intake.accept(e.id, e.version);
}

async function call(app: App, name: string, input: Record<string, unknown>) {
  const tool = toolByName(name)!;
  return tool.run(mcpContext(app.store, app, CLOCK()), tool.input.parse(input));
}

const MONDAY_KEY = "2026-11-16T13:00";
const live = (fake: FakeGoogle) => [...fake.calendars.get("primary")!.values()].filter((e) => e.status !== "cancelled");
const props = (e: FakeEvent) => (e.extendedProperties as { private: Record<string, string> }).private;

describe("sprint 13D, E1: each case has its own calendar identity", () => {
  it("after the person removes the event in Google and deletes the case, the same slot in a new case is added", async () => {
    const { fake, app } = await connected();
    await receive(app, "m-monday", MONDAY);
    const first = await call(app, "calendar_sync_slot", { slot_key: MONDAY_KEY });
    expect(first.output.action).toBe("created");
    // The person deletes the event in Google Calendar. It stays in Google's
    // trash as a cancelled event under the same id.
    const [made] = live(fake);
    made!.status = "cancelled";
    // Within the case, a sync does not put it back.
    const again = await call(app, "calendar_sync_slot", { slot_key: MONDAY_KEY });
    expect([again.ok, again.code]).toEqual([false, "google_changed"]);

    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    await receive(app, "m-monday", MONDAY);
    const fresh = await call(app, "calendar_sync_slot", { slot_key: MONDAY_KEY });
    expect([fresh.ok, fresh.output.action]).toEqual([true, "created"]);
    const now = live(fake);
    expect(now).toHaveLength(1);
    expect(now[0]!.id).not.toBe(made!.id);
    expect(props(now[0]!)[CASE_PROPERTY]).toBe(calendarCaseMark(app.store, { create: false }));
  });

  it("an event of an earlier case that is still in Google is not the new case's, so the new case adds its own", async () => {
    const { fake, app } = await connected();
    await receive(app, "m-monday", MONDAY);
    await call(app, "calendar_sync_slot", { slot_key: MONDAY_KEY });
    const oldMark = calendarCaseMark(app.store, { create: false });
    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    expect(calendarCaseMark(app.store, { create: false })).toBeUndefined();
    await receive(app, "m-monday", MONDAY);
    const fresh = await call(app, "calendar_sync_slot", { slot_key: MONDAY_KEY });
    expect(fresh.output.action).toBe("created");
    const marks = live(fake).map((e) => props(e)[CASE_PROPERTY]);
    expect(marks).toHaveLength(2);
    expect(new Set(marks).size).toBe(2);
    expect(marks).toContain(oldMark);
  });

  it("a case whose calendar writes predate case marks keeps its events, and old undo records still work", async () => {
    const { fake, app } = await connected();
    await receive(app, "m-monday", MONDAY);
    // A write made before this change: no case mark on the event, the
    // intent or the undo record, logged as the tool logged it then.
    const actions = mcpContext(app.store, app, CLOCK()).actions;
    const slot = app.kase.view().slots.find((s) => s.key === MONDAY_KEY)!;
    const legacy = new GoogleCalendar(app.google.connection, { timeZone: () => app.kase.timeZone() });
    const planned = await legacy.plan(MONDAY_KEY, slot, { office: officeOf(slot, app.intake.evidence(), app.intake.messages()) });
    const write = planned.write!;
    expect(write.plan.mark).toBeUndefined();
    const summary = { kind: "calendar_event_added" as const, summary: "Added Monday 11/16 1:00 PM to Google Calendar as confirmed." };
    const made = await actions.googleWrite({ actor: "mcp" }, write.plan, summary, () => legacy.execute(write), () => summary);
    expect(made.outcome.action).toBe("created");
    expect(made.outcome.undo!.mark).toBeUndefined();
    const [event] = live(fake);
    expect(event!.id).toBe(eventIdFor(FAKE_ACCOUNT.sub, "primary", MONDAY_KEY));
    expect(props(event!)[CASE_PROPERTY]).toBeUndefined();
    // The case keeps the scheme it started with: the next sync finds the
    // same event, and nothing is doubled.
    const again = await call(app, "calendar_sync_slot", { slot_key: MONDAY_KEY });
    expect(again.output.action).toBe("unchanged");
    expect(calendarCaseMark(app.store, { create: false })).toBeNull();
    expect(live(fake)).toHaveLength(1);
    // The old entry's Undo still removes it.
    const entry = actions.activity().entries.find((e) => e.kind === "calendar_event_added")!;
    await actions.undoEntry({ actor: "you" }, entry.id, actions.activityVersion());
    expect(live(fake)).toHaveLength(0);
  });
});

describe("sprint 13D, E2: one place for the schedule, the reply and the event", () => {
  it("an appointment without its own place gets no location, even when the office's one place is known", async () => {
    const { fake, app } = await connected();
    await receive(app, "m-both", BOTH);
    const monday = app.kase.view().slots.find((s) => s.key === MONDAY_KEY)!;
    expect(monday.location).toBeNull();
    await call(app, "calendar_sync_slot", { slot_key: MONDAY_KEY });
    await call(app, "calendar_sync_slot", { slot_key: "2026-11-12T10:30" });
    const byKey = new Map(live(fake).map((e) => [props(e).apptSlotKey, e]));
    expect(byKey.get(MONDAY_KEY)!.location ?? "").toBe("");
    expect(byKey.get("2026-11-12T10:30")!.location).toBe(PLACE);
    // The reply for each leaves out or names the place as the schedule does.
    const view = app.kase.view();
    const ctx = { slots: view.slots, evidence: app.intake.evidence(), messages: app.intake.messages(), userName: null, timeZone: app.kase.timeZone() };
    const place = (key: string) => slotFields("ask_still_stands", view.slots.find((s) => s.key === key)!, ctx).fields.find((f) => f.name === "location")!.value;
    expect(place(MONDAY_KEY)).toBeNull();
    expect(place("2026-11-12T10:30")).toBe(PLACE);
    expect(view.slots.find((s) => s.key === "2026-11-12T10:30")!.location).toBe(PLACE);
  });
});

describe("sprint 13D fix round 1, R1: Delete case waits for a Google write and a chat turn", () => {
  it("is refused while a Google Calendar write is in flight, and the write is recorded with its undo", async () => {
    const { fake, app } = await connected();
    await receive(app, "m-monday", MONDAY);
    let refused: unknown = null;
    fake.beforeCalendarWrite = async () => {
      try {
        app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
      } catch (err) {
        refused = err;
      }
    };
    const made = await call(app, "calendar_sync_slot", { slot_key: MONDAY_KEY });
    expect(refused).toBeInstanceOf(DeleteBlockedError);
    expect((refused as Error).message).toBe("The assistant or a Google Calendar change is still working. Nothing was deleted. Wait a moment, then delete the case again.");
    expect([made.ok, made.output.action, made.output.undoable]).toEqual([true, "created", true]);
    // The case is whole: its appointment and the write's entry are there.
    expect(app.kase.view().slots.map((s) => s.key)).toContain(MONDAY_KEY);
    // Once the write is recorded, Delete case runs.
    expect(app.kase.deleteCase(app.kase.caseVersion(), "DELETE").erased).toBeGreaterThan(0);
  });

  it("is refused while a chat turn runs, and an intent a stopped process left long ago does not block it", () => {
    const store = new EventStore(":memory:", () => "2026-11-05T16:00:00.000Z");
    useZone(store, DEMO_ZONE);
    const intake = new IntakeService(store, RecordedModelClient.fromDirectory(), { now: CLOCK });
    const kase = new CaseService(store, intake, RecordedModelClient.fromDirectory(), { now: CLOCK });
    expect(() => kase.deleteCase(kase.caseVersion(), "DELETE", { turnRunning: () => true })).toThrow(DeleteBlockedError);
    // Opened an hour before the case's clock by another process that stopped.
    store.appendSystem("google_intents", [
      { type: "google_intent_opened", data: { intent_id: "gi-old", kind: "write", slot_key: MONDAY_KEY, actor: "agent", owner: "1:gone", plan: {}, entry_kind: "calendar_event_added", summary: "x" } },
    ]);
    expect(kase.deleteCase(kase.caseVersion(), "DELETE", { turnRunning: () => false })).toBeDefined();
  });
});

describe("sprint 13D fix round 1, R2: the mark is made only for a write that happens", () => {
  it("a sync or a removal that writes nothing leaves the case without a mark", async () => {
    const { fake, app } = await connected();
    await receive(app, "m-monday", MONDAY);
    // Nothing to remove: no write, no mark.
    const removed = await call(app, "calendar_remove_slot", { slot_key: MONDAY_KEY });
    expect(removed.output.action).toBe("none");
    // A slot the case does not hold gets no event: no write, no mark.
    const none = await call(app, "calendar_sync_slot", { slot_key: "2026-11-20T09:00" });
    expect(none.output.action).toBe("none");
    expect(app.store.readStream(CALENDAR_CASE_STREAM)).toHaveLength(0);
    expect(calendarCaseMark(app.store, { create: false })).toBeUndefined();
    // No lookup by property ran either: a case without a mark owns nothing.
    expect(fake.calls.filter((c) => c.url.searchParams.has("privateExtendedProperty"))).toHaveLength(0);
  });

  it("the first write makes the mark in the transaction that records its intent, and the intent carries it", async () => {
    const { fake, app } = await connected();
    await receive(app, "m-monday", MONDAY);
    let markDuringWrite: string | null | undefined = "unset";
    fake.beforeCalendarWrite = async () => {
      markDuringWrite = calendarCaseMark(app.store, { create: false });
    };
    await call(app, "calendar_sync_slot", { slot_key: MONDAY_KEY });
    const mark = calendarCaseMark(app.store, { create: false });
    expect(typeof mark).toBe("string");
    expect(markDuringWrite).toBe(mark);
    const opened = app.store.readStream("google_intents").find((e) => e.type === "google_intent_opened")!.data as { plan: { mark?: string; eventId: string } };
    expect(opened.plan.mark).toBe(mark);
    expect(opened.plan.eventId).toBe(eventIdFor(FAKE_ACCOUNT.sub, "primary", MONDAY_KEY, mark!));
    expect(live(fake)[0]!.id).toBe(opened.plan.eventId);
  });
});
