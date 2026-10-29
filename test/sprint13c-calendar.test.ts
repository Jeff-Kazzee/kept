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
import { FRESH_MS, GoogleCalendarEvents } from "../src/google/events.ts";
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
async function connected() {
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
  const client = RecordedModelClient.withOverrides([recording("m-thu")], RecordedModelClient.fromDirectory());
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

  it("an event added inside the window is found once the copy is older than a minute, and one turn reads a window once", async () => {
    const { fake, app } = await connected();
    fake.addForeignEvent("primary", { summary: "Team standup", start: { dateTime: "2026-11-13T09:00:00-07:00" }, end: { dateTime: "2026-11-13T10:00:00-07:00" } });
    const tool = toolByName("check_calendar")!;
    const ctx = { ...mcpContext(app.store, app, CLOCK()), calendarReads: new Map() };
    // Read less than a minute ago: the copy stands.
    expect(clashNames((await tool.run(ctx, tool.input.parse({ date: "2026-11-13", time: "09:15" }))).output)).toEqual([]);
    fake.now += FRESH_MS + 1;
    const before = lists(fake).length;
    const first = await tool.run(ctx, tool.input.parse({ date: "2026-11-13", time: "09:15" }));
    expect(clashNames(first.output)).toEqual(["Team standup"]);
    fake.now += FRESH_MS + 1;
    // The same turn: the window is not read again.
    await tool.run(ctx, tool.input.parse({ date: "2026-11-16", time: "13:00" }));
    expect(lists(fake).length).toBe(before + 1);
    // The schedule view reads the same copy.
    expect(app.kase.view().calendar!.events.map((e) => e.summary)).toContain("Team standup");
  });

  it("when Google cannot be read, the check says so and never that the day is free", async () => {
    const { fake, app } = await connected();
    fake.now += FRESH_MS + 1;
    fake.apiStatus = 503;
    const tool = toolByName("check_calendar")!;
    const r = await tool.run({ ...mcpContext(app.store, app, CLOCK()), calendarReads: new Map() }, tool.input.parse({ date: "2026-11-13", time: "09:15" }));
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
    const r = await tool.run({ ...mcpContext(app.store, app, CLOCK()), calendarReads: new Map() }, tool.input.parse({}));
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
