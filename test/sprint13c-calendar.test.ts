// Sprint 13C, H1 and H2 (0016): a clash check reads Google Calendar when
// its copy is old or does not cover the date, at most once a turn per
// window, and says so when Google cannot be read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGoogleRoutes } from "../server/google.ts";
import { toolByName } from "../src/agent/tools.ts";
import { mcpContext } from "../mcp/tools.ts";
import { GoogleCalendar } from "../src/google/calendar.ts";
import { GoogleConnection } from "../src/google/connection.ts";
import { CalendarTurn, FRESH_MS, GoogleCalendarEvents, TURN_READ_BUDGET } from "../src/google/events.ts";
import { Gmail } from "../src/google/gmail.ts";
import type { GoogleServices } from "../src/google/tools.ts";
import { SecretsStore } from "../src/model/providers/secrets.ts";
import { RecordedModelClient, type Recording } from "../src/model/recorded.ts";
import { EventStore } from "../src/store/event-log.ts";
import { CaseService } from "../src/case/service.ts";
import { IntakeService } from "../src/intake/service.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { CLOCK, agentFor, fnCall, message, reply, say, sequence, turnOutputs } from "./agent-helpers.ts";
import { DEMO_ZONE, useZone } from "./helpers.ts";
import { FAKE_CLIENT, FakeGoogle } from "./google-fake.ts";

const TEXT = "Hi,\n\nThis confirms your appointment on Thursday, November 12 at 10:30 AM at Lantern Hill Clinic, 400 Elm Street, Suite 2.\n\nFront Desk\nLantern Hill Clinic";
const CONFIRM = {
  claim_type: "confirm",
  date: "2026-11-12",
  time: "10:30",
  location: "Lantern Hill Clinic, 400 Elm Street, Suite 2",
  quote: "This confirms your appointment on Thursday, November 12 at 10:30 AM at Lantern Hill Clinic, 400 Elm Street, Suite 2.",
  sender_kind: "person",
  event_time: null,
  request_item: null,
};
const recording = (id: string): Recording => ({
  message_id: id,
  effort: "any",
  attempts: [{ output: { claims: [CONFIRM] }, usage: { input: 1, cached_input: 0, output: 1, reasoning: 0 }, latency_ms: 1 }],
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A connected account, a case with Thursday 11/12 10:30 confirmed, and the
// first read of the calendar, as Connect does.
async function connected(extra?: Recording) {
  const dir = mkdtempSync(path.join(tmpdir(), "s13c-cal-"));
  dirs.push(dir);
  const fake = new FakeGoogle();
  const connection = new GoogleConnection({ client: FAKE_CLIENT, store: new SecretsStore(path.join(dir, "app-secrets.sqlite")), fetch: fake.fetch, now: () => fake.now });
  const flow = connection.startConnect({ expectedVersion: 0, features: { gmail: true, calendar: true }, calendarId: "primary", redirectUri: "http://127.0.0.1:5192/auth/google/callback" });
  const back = fake.consent(flow.authorizeUrl);
  await connection.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null, cookie: flow.cookie });
  let events: GoogleCalendarEvents | null = null;
  const store = new EventStore(":memory:", CLOCK);
  useZone(store, DEMO_ZONE);
  const client = RecordedModelClient.withOverrides([recording("m-thu"), ...(extra ? [extra] : [])], RecordedModelClient.fromDirectory());
  const intake = new IntakeService(store, client, { now: CLOCK });
  const kase = new CaseService(store, intake, client, { now: CLOCK, externalCalendar: () => events?.snapshot() ?? null });
  const calendar = new GoogleCalendar(connection, { timeZone: () => kase.timeZone() });
  events = new GoogleCalendarEvents(calendar, { now: () => fake.now });
  const google: GoogleServices = { connection, gmail: new Gmail(connection), calendar, events };
  const app = { store, intake, kase, reply: new ReplyService(store, kase, client, { now: CLOCK }), records: new RecordsService(store, intake, kase), google };
  const m = app.intake.importMessage({ id: "m-thu", channel: "email", from: "Lantern Hill Clinic", received_at: "2026-10-31T09:12:00-06:00", text: TEXT });
  await app.intake.extract("m-thu", { effort: "minimal", expectedVersion: m.version });
  for (const e of app.intake.reviewQueue()) app.intake.accept(e.id, e.version);
  await events.refresh(app.kase.view().slots.map((s) => s.date), "2026-11-05");
  return { fake, app, events };
}

const lists = (fake: FakeGoogle) => fake.calls.filter((c) => c.method === "GET" && c.url.searchParams.has("timeMin"));
const clashNames = (out: Record<string, unknown>) => ((out.clashes_with_time as Array<{ summary: { untrusted_text: string } }> | undefined) ?? []).map((c) => c.summary.untrusted_text);

describe("sprint 13C, H1: clash checks read Google Calendar live enough", () => {
  it("an event added at Google after Connect, on a date outside the first window, is a clash in the chat", async () => {
    const { fake, app } = await connected();
    // The first window is 11/5 to 12/5. The person adds an event on 12/10.
    fake.addForeignEvent("primary", { summary: "Team standup", start: { dateTime: "2026-12-10T09:00:00-07:00" }, end: { dateTime: "2026-12-10T10:00:00-07:00" } });
    const model = sequence(
      reply(fnCall("check_calendar", { date: "2026-12-10", time: "09:15" })),
      reply(message("Yes. Your calendar has an event from Thursday 12/10 9:00 AM to 10:00 AM.")),
    );
    const r = await say(agentFor(app, model), app, "Does Thursday 12/10 at 9:15 clash with my calendar?");
    const out = turnOutputs(model.calls[1]!.body.input).find((o) => o.name === "check_calendar")!.output;
    expect(clashNames(out)).toEqual(["Team standup"]);
    expect([r.report.outcome, r.report.problems]).toEqual(["answered", [[]]]);
  });

  it("an event added inside the window is found once the copy is older than a minute, and checks within a minute read a window once", async () => {
    const { fake, app } = await connected();
    fake.addForeignEvent("primary", { summary: "Team standup", start: { dateTime: "2026-11-13T09:00:00-07:00" }, end: { dateTime: "2026-11-13T10:00:00-07:00" } });
    const tool = toolByName("check_calendar")!;
    const ctx = { ...mcpContext(app.store, app, CLOCK()), calendarTurn: new CalendarTurn() };
    // Read less than a minute ago: the copy stands.
    expect(clashNames((await tool.run(ctx, tool.input.parse({ date: "2026-11-13", time: "09:15" }))).output)).toEqual([]);
    fake.now += FRESH_MS + 1;
    const before = lists(fake).length;
    const first = await tool.run(ctx, tool.input.parse({ date: "2026-11-13", time: "09:15" }));
    expect(clashNames(first.output)).toEqual(["Team standup"]);
    // The same turn, within the minute: no second read, and the event is
    // still there (fix round 1, R8).
    const second = await tool.run(ctx, tool.input.parse({ date: "2026-11-13", time: "09:30" }));
    expect(clashNames(second.output)).toEqual(["Team standup"]);
    await tool.run(ctx, tool.input.parse({ date: "2026-11-16", time: "13:00" }));
    expect(lists(fake).length).toBe(before + 1);
    // A minute later, even in the same turn, the window is read again.
    fake.now += FRESH_MS + 1;
    expect(clashNames((await tool.run(ctx, tool.input.parse({ date: "2026-11-13", time: "09:15" }))).output)).toEqual(["Team standup"]);
    expect(lists(fake).length).toBe(before + 2);
    // The schedule view reads the same copy.
    expect(app.kase.view().calendar!.events.map((e) => e.summary)).toContain("Team standup");
  });

  it("when Google cannot be read, the check says so and never that the day is free", async () => {
    const { fake, app } = await connected();
    fake.now += FRESH_MS + 1;
    fake.apiStatus = 503;
    const tool = toolByName("check_calendar")!;
    const r = await tool.run({ ...mcpContext(app.store, app, CLOCK()), calendarTurn: new CalendarTurn() }, tool.input.parse({ date: "2026-11-13", time: "09:15" }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("google_unavailable");
    expect(r.output).not.toHaveProperty("clashes_with_time");
    expect(r.output).not.toHaveProperty("events_that_day");
    expect(String(r.output.message)).toContain("could not be read right now");
    expect(r.cards).toEqual([{ kind: "notice", text: expect.stringContaining("could not be read right now") }]);
    expect(JSON.stringify(r.output)).not.toMatch(/token|Bearer/i);
  });

  it("get_schedule reads the case window again when it is old, so a new event shows as a clash", async () => {
    const { fake, app } = await connected();
    fake.addForeignEvent("primary", { summary: "Work call", start: { dateTime: "2026-11-12T10:00:00-07:00" }, end: { dateTime: "2026-11-12T11:00:00-07:00" } });
    fake.now += FRESH_MS + 1;
    const tool = toolByName("get_schedule")!;
    const r = await tool.run({ ...mcpContext(app.store, app, CLOCK()), calendarTurn: new CalendarTurn() }, tool.input.parse({}));
    const thu = (r.output.appointments as Array<{ clashes: Array<{ summary: { untrusted_text: string } }> | null }>)[0]!;
    expect(thu.clashes!.map((c) => c.summary.untrusted_text)).toEqual(["Work call"]);
  });
});

describe("sprint 13C, H2: Read the calendar again reports when it read", () => {
  it("the refresh route and the status give the read time, the count and the window, and a failure gives its code", async () => {
    const { fake, app, events } = await connected();
    fake.addForeignEvent("primary", { summary: "Work call", start: { dateTime: "2026-11-12T10:00:00-07:00" }, end: { dateTime: "2026-11-12T11:00:00-07:00" } });
    const routes = createGoogleRoutes({
      connection: app.google.connection,
      generation: () => app.kase.generation(),
      port: 5192,
      extraHosts: [],
      events,
      caseDates: () => ({ dates: app.kase.view().slots.map((x) => x.date), today: "2026-11-05" }),
    });
    const ok = await routes.api({ method: "POST", path: "/api/google/calendar/refresh", body: {}, generation: app.kase.generation(), host: "127.0.0.1:5192", secure: false });
    expect(ok).toMatchObject({ status: 200, body: { events: 1, read: { readAt: new Date(fake.now).toISOString(), events: 1, from: "2026-11-05", to: "2026-12-05", days: 31, error: null } } });
    const status = await routes.api({ method: "GET", path: "/api/google", body: undefined, host: "127.0.0.1:5192", secure: false });
    expect(status.body).toMatchObject({ connected: true, calendarRead: { events: 1, from: "2026-11-05" } });
    fake.apiStatus = 503;
    const bad = await routes.api({ method: "POST", path: "/api/google/calendar/refresh", body: {}, generation: app.kase.generation(), host: "127.0.0.1:5192", secure: false });
    expect(bad).toMatchObject({ status: 503, body: { error: "google_unavailable" } });
    const after = await routes.api({ method: "GET", path: "/api/google", body: undefined, host: "127.0.0.1:5192", secure: false });
    // The last good read stays, with the failure after it.
    expect(after.body).toMatchObject({ calendarRead: { events: 1, error: { code: "google_unavailable" } } });
  });
});

describe("sprint 13C, H4: the event at Google", () => {
  it("is titled by the office and the state with the office's place, and a requested slot is tentative at Google", async () => {
    const { fake, app } = await connected();
    const { googleToolByName } = await import("../src/google/tools.ts");
    const sync = googleToolByName("calendar_sync_slot")!;
    const ctx = { ...mcpContext(app.store, app, CLOCK()), by: { actor: "agent" as const } };
    const done = await sync.run(ctx, sync.input.parse({ slot_key: "2026-11-12T10:30", restore_removed: null }));
    expect(done.ok).toBe(true);
    const event = [...fake.calendars.get("primary")!.values()][0]!;
    expect(event).toMatchObject({ summary: "Lantern Hill Clinic", status: "confirmed", location: "Lantern Hill Clinic, 400 Elm Street, Suite 2" });
    // The same event while requested: Google records it as tentative.
    const thu = { ...app.kase.view().slots[0]!, state: "requested" as const };
    await app.google.calendar.sync(thu.key, thu, { office: { name: "Lantern Hill Clinic", location: thu.location } });
    const sent = fake.calls.filter((c) => c.method === "PATCH").at(-1)!;
    expect(JSON.parse(sent.body)).toMatchObject({ status: "tentative", summary: "Lantern Hill Clinic (requested)" });
    expect(fake.calendars.get("primary")!.get(event.id)).toMatchObject({ status: "tentative", summary: "Lantern Hill Clinic (requested)" });
  });
});

describe("sprint 13C fix round 1", () => {
  const FAR = "Hi,\n\nWe can also offer December 20 at 9:00 AM. We can also offer January 30 at 9:00 AM. We can also offer March 10 at 9:00 AM. We can also offer April 20 at 9:00 AM.\n\nLantern Hill Clinic";
  const offer = (date: string, quote: string) => ({ claim_type: "offer", date, time: "09:00", location: null, quote, sender_kind: "person", event_time: null, request_item: null });
  const far: Recording = {
    message_id: "m-far",
    effort: "any",
    attempts: [
      {
        output: {
          claims: [
            offer("2026-12-20", "We can also offer December 20 at 9:00 AM."),
            offer("2027-01-30", "We can also offer January 30 at 9:00 AM."),
            offer("2027-03-10", "We can also offer March 10 at 9:00 AM."),
            offer("2027-04-20", "We can also offer April 20 at 9:00 AM."),
          ],
        },
        usage: { input: 1, cached_input: 0, output: 1, reasoning: 0 },
        latency_ms: 1,
      },
    ],
  };

  it("R1: five far-apart appointments keep every window a check read, so the first one's clash shows in get_schedule and check_calendar", async () => {
    const { fake, app } = await connected(far);
    const m = app.intake.importMessage({ id: "m-far", channel: "email", from: "Lantern Hill Clinic", received_at: "2026-10-31T09:20:00-06:00", text: FAR });
    await app.intake.extract("m-far", { effort: "minimal", expectedVersion: m.version });
    for (const e of app.intake.reviewQueue()) app.intake.accept(e.id, e.version);
    expect(app.kase.view().slots.map((s) => s.date)).toEqual(["2026-11-12", "2026-12-20", "2027-01-30", "2027-03-10", "2027-04-20"]);
    fake.addForeignEvent("primary", { summary: "Work call", start: { dateTime: "2026-11-12T10:00:00-07:00" }, end: { dateTime: "2026-11-12T11:00:00-07:00" } });
    fake.now += FRESH_MS + 1;
    const ctx = { ...mcpContext(app.store, app, CLOCK()), calendarTurn: new CalendarTurn() };
    const schedule = toolByName("get_schedule")!;
    const r = await schedule.run(ctx, schedule.input.parse({}));
    const thu = (r.output.appointments as Array<{ slot_key: string; clashes: Array<{ summary: { untrusted_text: string } }> | null }>).find((a) => a.slot_key === "2026-11-12T10:30")!;
    expect(thu.clashes!.map((c) => c.summary.untrusted_text)).toEqual(["Work call"]);
    // Five windows were read, one per far date and the case window.
    expect(lists(fake).length).toBeGreaterThanOrEqual(5);
    const check = toolByName("check_calendar")!;
    const c = await check.run(ctx, check.input.parse({ date: "2026-11-12", time: "10:30" }));
    expect(clashNames(c.output)).toEqual(["Work call"]);
  });

  it("R2: a refresh, a clash check and the poll at the same moment make one list call", async () => {
    const { fake, app, events } = await connected();
    fake.now += FRESH_MS + 1;
    let release!: () => void;
    fake.listGate = new Promise((r) => (release = r));
    const before = lists(fake).length;
    const dates = app.kase.view().slots.map((s) => s.date);
    const a = events.refresh(dates, "2026-11-05");
    const b = events.ensure("2026-11-12", { dates, today: "2026-11-05", turn: new CalendarTurn() });
    events.touch(() => ({ dates, today: "2026-11-05" }));
    await new Promise((r) => setImmediate(r));
    release();
    fake.listGate = null;
    await Promise.all([a, b]);
    expect(lists(fake).length).toBe(before + 1);
  });

  it("R3: after a failed read, get_schedule shows no stored clash and grounds none", async () => {
    const { fake, app } = await connected();
    fake.addForeignEvent("primary", { summary: "Work call", start: { dateTime: "2026-11-12T10:00:00-07:00" }, end: { dateTime: "2026-11-12T11:00:00-07:00" } });
    await app.google.events!.refresh(app.kase.view().slots.map((s) => s.date), "2026-11-05");
    expect(app.kase.view().slots[0]!.clashes!.map((c) => c.summary)).toEqual(["Work call"]);
    fake.now += FRESH_MS + 1;
    fake.apiStatus = 503;
    const schedule = toolByName("get_schedule")!;
    const r = await schedule.run({ ...mcpContext(app.store, app, CLOCK()), calendarTurn: new CalendarTurn() }, schedule.input.parse({}));
    expect((r.output.appointments as Array<{ clashes: unknown }>)[0]!.clashes).toBeNull();
    expect(r.output.google_calendar).toMatchObject({ read: false, error: "google_unavailable" });
    // The work call's times are not facts the answer may state.
    expect(r.facts.some((f) => f.date === "2026-11-12" && f.time === "10:00")).toBe(false);
  });

  it("R4: a newer read drops an all-day event removed at Google on the window's first day, in a zone behind UTC", async () => {
    const { fake, app, events } = await connected();
    const dates = app.kase.view().slots.map((s) => s.date);
    const allDay = fake.addForeignEvent("primary", { summary: "Office closed", start: { date: "2026-11-12" }, end: { date: "2026-11-13" } });
    // An older window that holds the day, then a newer one that starts on it.
    fake.now += FRESH_MS + 1;
    await events.ensure("2026-11-12", { dates: ["2026-11-01"], today: "2026-11-01" });
    expect(events.snapshot()!.events.map((e) => e.summary)).toContain("Office closed");
    allDay.status = "cancelled";
    fake.now += FRESH_MS + 1;
    await events.ensure("2026-11-12", { dates: ["2026-11-12"], today: "2026-11-12" });
    expect(app.kase.timeZone()).toBe("America/Denver");
    expect(events.snapshot()!.events.map((e) => e.summary)).not.toContain("Office closed");
    expect(dates).toEqual(["2026-11-12"]);
  });
});

describe("sprint 13C fix round 2", () => {
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // Sixteen far-apart offers, 40 days apart from December 20, so with
  // Thursday 11/12 the case has 17 dates, each in its own window.
  const farDates = Array.from({ length: 16 }, (_, i) => new Date(Date.UTC(2026, 11, 20 + 40 * i)).toISOString().slice(0, 10));
  const sentence = (d: string) => `We can also offer ${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)} at 9:00 AM.`;
  const TEXT17 = `Hi,\n\n${farDates.map(sentence).join(" ")}\n\nLantern Hill Clinic`;
  const many: Recording = {
    message_id: "m-many",
    effort: "any",
    attempts: [
      {
        output: { claims: farDates.map((d) => ({ claim_type: "offer", date: d, time: "09:00", location: null, quote: sentence(d), sender_kind: "person", event_time: null, request_item: null })) },
        usage: { input: 1, cached_input: 0, output: 1, reasoning: 0 },
        latency_ms: 1,
      },
    ],
  };
  type Appt = { slot_key: string; clashes: Array<{ summary: { untrusted_text: string } }> | null };

  it("N1 and N2: with 17 far-apart dates, the first one's clash is reported, the turn reads Google at most 8 times, and the dates past it are unread, never free", async () => {
    const { fake, app } = await connected(many);
    const m = app.intake.importMessage({ id: "m-many", channel: "email", from: "Lantern Hill Clinic", received_at: "2026-10-31T09:20:00-06:00", text: TEXT17 });
    await app.intake.extract("m-many", { effort: "minimal", expectedVersion: m.version });
    for (const e of app.intake.reviewQueue()) app.intake.accept(e.id, e.version);
    expect(new Set(app.kase.view().slots.map((s) => s.date)).size).toBe(17);
    fake.addForeignEvent("primary", { summary: "Work call", start: { dateTime: "2026-11-12T10:00:00-07:00" }, end: { dateTime: "2026-11-12T11:00:00-07:00" } });
    fake.now += FRESH_MS + 1;
    const before = lists(fake).length;
    const ctx = { ...mcpContext(app.store, app, CLOCK()), calendarTurn: new CalendarTurn() };
    const schedule = toolByName("get_schedule")!;
    const r = await schedule.run(ctx, schedule.input.parse({}));
    expect(lists(fake).length - before).toBe(TURN_READ_BUDGET);
    const appts = r.output.appointments as Appt[];
    expect(appts.find((a) => a.slot_key === "2026-11-12T10:30")!.clashes!.map((c) => c.summary.untrusted_text)).toEqual(["Work call"]);
    const unread = (r.output.google_calendar as { read: boolean; error: string; unread_dates: string[] });
    expect(unread).toMatchObject({ read: false, error: "google_read_limit" });
    // 18 dates with today. The first read covers today and 11/12, each other
    // read one far date.
    expect(unread.unread_dates.length).toBe(18 - (TURN_READ_BUDGET + 1));
    // Every appointment is either checked or marked unread: none past the
    // budget reads as free.
    for (const a of appts) {
      const date = a.slot_key.slice(0, 10);
      if (unread.unread_dates.includes(date)) expect(a.clashes).toBeNull();
      else expect(a.clashes).not.toBeNull();
    }
    // A later check in the same turn on the first date still finds the
    // clash, and reads nothing more.
    const check = toolByName("check_calendar")!;
    expect(clashNames((await check.run(ctx, check.input.parse({ date: "2026-11-12", time: "10:30" }))).output)).toEqual(["Work call"]);
    // A date past the budget is answered as unread.
    const last = await check.run(ctx, check.input.parse({ date: farDates.at(-1)!, time: "09:00" }));
    expect(last).toMatchObject({ ok: false, code: "google_read_limit" });
    expect(lists(fake).length - before).toBe(TURN_READ_BUDGET);
  });

  it("N2: calendar_list twice in a turn reads Google once", async () => {
    const { fake, app } = await connected();
    const { googleToolByName } = await import("../src/google/tools.ts");
    const list = googleToolByName("calendar_list")!;
    const ctx = { ...mcpContext(app.store, app, CLOCK()), calendarTurn: new CalendarTurn() };
    const before = lists(fake).length;
    const a = await list.run(ctx, list.input.parse({ from: "2026-11-12", to: "2026-11-13" }));
    const b = await list.run(ctx, list.input.parse({ from: "2026-11-12", to: "2026-11-13" }));
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(lists(fake).length - before).toBe(1);
    // A new turn reads again.
    await list.run({ ...ctx, calendarTurn: new CalendarTurn() }, list.input.parse({ from: "2026-11-12", to: "2026-11-13" }));
    expect(lists(fake).length - before).toBe(2);
  });

  it("R1: a window a turn found fresh is held for the turn, so later reads do not evict it", async () => {
    const { fake, app, events } = await connected();
    fake.addForeignEvent("primary", { summary: "Work call", start: { dateTime: "2026-11-12T10:00:00-07:00" }, end: { dateTime: "2026-11-12T11:00:00-07:00" } });
    const dates = app.kase.view().slots.map((s) => s.date);
    await events.refresh(dates, "2026-11-05");
    const turn = new CalendarTurn();
    const before = lists(fake).length;
    // Fresh: held, not read.
    await events.ensure("2026-11-12", { dates, today: "2026-11-05", turn });
    expect(lists(fake).length).toBe(before);
    // Five other windows, read by calls that hold nothing, would push the
    // case window out of the four kept.
    for (const d of ["2027-01-01", "2027-03-01", "2027-05-01", "2027-07-01", "2027-09-01"]) await events.ensure(d, { dates, today: "2026-11-05" });
    expect(events.snapshot()!.events.map((e) => e.summary)).toContain("Work call");
    events.release(turn);
    await events.ensure("2027-11-01", { dates, today: "2026-11-05" });
    expect(events.snapshot()!.events.map((e) => e.summary)).not.toContain("Work call");
  });

  it("N5: a read the connection outlived marks the date unread, never free", async () => {
    const { fake, app, events } = await connected();
    fake.addForeignEvent("primary", { summary: "Work call", start: { dateTime: "2026-11-12T10:00:00-07:00" }, end: { dateTime: "2026-11-12T11:00:00-07:00" } });
    fake.now += FRESH_MS + 1;
    let release!: () => void;
    fake.listGate = new Promise((r) => (release = r));
    const check = toolByName("check_calendar")!;
    const pending = check.run({ ...mcpContext(app.store, app, CLOCK()), calendarTurn: new CalendarTurn() }, check.input.parse({ date: "2026-11-12", time: "10:30" }));
    await new Promise((r) => setImmediate(r));
    // A connect starts while the read runs.
    events.clear();
    release();
    fake.listGate = null;
    const r = await pending;
    expect(r).toMatchObject({ ok: false, code: "google_stale" });
    expect(r.output).not.toHaveProperty("clashes_with_time");
  });
});
