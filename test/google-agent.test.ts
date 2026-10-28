// Sprint 11 integration: the in-app agent uses the Google tools from sprint
// 8's shared registry, with the recorded chat client and the fake of
// Google's endpoints. Each change is an activity entry with sprint 9's
// kind, and Undo of a calendar write goes through sprint 8's undo route and
// reverses it at Google.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mcpContext, toolByName as mcpTool } from "../mcp/tools.ts";
import { createApi } from "../server/api.ts";
import { GoogleCalendar } from "../src/google/calendar.ts";
import { GoogleConnection } from "../src/google/connection.ts";
import { GoogleCalendarEvents } from "../src/google/events.ts";
import { Gmail } from "../src/google/gmail.ts";
import type { GoogleServices } from "../src/google/tools.ts";
import { SecretsStore } from "../src/model/providers/secrets.ts";
import { RecordedModelClient, type Recording } from "../src/model/recorded.ts";
import { EventStore } from "../src/store/event-log.ts";
import { CLOCK, agentFor, fnCall, message, reply, say, sequence, services, turnOutputs } from "./agent-helpers.ts";
import { FAKE_CLIENT, FakeGoogle, gmailMessage } from "./google-fake.ts";

const THU = "2026-11-12T10:30";
const TEXT =
  "Hi Dana,\n\nThis confirms your appointment on Thursday, November 12 at 10:30 AM at Lantern Hill Clinic, 400 Elm Street, Suite 2.\n\nFront Desk\nLantern Hill Clinic";
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

// The case services with a connected Google account and one clinic email.
async function connected() {
  const dir = mkdtempSync(path.join(tmpdir(), "google-agent-"));
  dirs.push(dir);
  const fake = new FakeGoogle();
  const connection = new GoogleConnection({ client: FAKE_CLIENT, store: new SecretsStore(path.join(dir, "app-secrets.sqlite")), fetch: fake.fetch, now: () => fake.now });
  const flow = connection.startConnect({ expectedVersion: 0, features: { gmail: true, calendar: true }, calendarId: "primary", redirectUri: "http://127.0.0.1:5192/auth/google/callback" });
  const back = fake.consent(flow.authorizeUrl);
  await connection.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null, cookie: flow.cookie });
  fake.messages.set(
    "18f0a1",
    gmailMessage("18f0a1", {
      from: "Front Desk, Lantern Hill Clinic <front@lanternhill.example>",
      subject: "Appointment confirmation",
      date: "Sat, 31 Oct 2026 09:12:00 -0600",
      internalDate: String(Date.parse("2026-10-31T15:12:05Z")),
      plain: TEXT,
    }),
  );
  const app = services(new EventStore(":memory:", CLOCK), CLOCK, RecordedModelClient.withOverrides([recording("gmail-18f0a1"), recording("m-thu")], RecordedModelClient.fromDirectory()));
  const calendar = new GoogleCalendar(connection, { timeZone: () => app.kase.timeZone() });
  const google: GoogleServices = { connection, gmail: new Gmail(connection), calendar, events: new GoogleCalendarEvents(calendar) };
  return { fake, app: { ...app, google }, google };
}

describe("sprint 11: the in-app agent with Gmail and Google Calendar", () => {
  it("searches Gmail, imports and accepts in one turn, adds the event in the next, and Undo goes through the undo route", async () => {
    const { fake, app, google } = await connected();
    const model = sequence(
      // Turn 1.
      reply(fnCall("gmail_search", { days: null, senders: null })),
      reply(fnCall("gmail_import", { message_id: "18f0a1" })),
      reply(fnCall("accept_claim", { claims: [{ evidence_id: "gmail-18f0a1-e1", expected_version: 1 }] })),
      reply(message("I imported the email from the clinic. I accepted the confirmation for Thursday 11/12 10:30 AM. You can undo either step.")),
      // Turn 2.
      reply(fnCall("calendar_sync_slot", { slot_key: THU, restore_removed: null })),
      reply(message("Thursday 11/12 10:30 AM is on your Google Calendar now. You can undo it in the activity list.")),
    );
    const agent = agentFor(app, model);

    const first = await say(agent, app, "Find my appointment emails in Gmail and add them.");
    expect([first.report.outcome, first.report.problems]).toEqual(["answered", [[]]]);
    expect(first.report.tools.map((t) => [t.tool, t.code])).toEqual([
      ["gmail_search", "ok"],
      ["gmail_import", "ok"],
      ["accept_claim", "ok"],
    ]);
    const search = turnOutputs(model.calls[1]!.body.input).find((o) => o.name === "gmail_search")!.output;
    expect(search.messages[0]).toMatchObject({ message_id: "18f0a1", from: { untrusted_text: "Front Desk, Lantern Hill Clinic <front@lanternhill.example>" } });
    expect(first.of("action").map((a) => [a.entry.kind, a.entry.actor, a.entry.target?.id])).toEqual([
      ["gmail_message_imported", "agent", "gmail-18f0a1"],
      ["claim_accepted", "agent", "gmail-18f0a1-e1"],
    ]);
    // D1': an office message with the email's own sender and sent time,
    // never the person's own report.
    const m = app.intake.message("gmail-18f0a1");
    expect(m).toMatchObject({ importedFrom: "gmail", sourceType: "office_message", ownReport: null, sourceSuggested: [] });
    expect(m.message).toMatchObject({ channel: "email", from: "Front Desk, Lantern Hill Clinic <front@lanternhill.example>", received_at: "2026-10-31T15:12:00.000Z" });
    expect(app.kase.view().slots.map((s) => [s.key, s.state])).toEqual([[THU, "confirmed"]]);

    const second = await say(agent, app, "Put it on my Google Calendar.");
    expect(second.report.outcome).toBe("answered");
    expect(second.report.tools.map((t) => [t.tool, t.code])).toEqual([["calendar_sync_slot", "ok"]]);
    const added = second.of("action").map((a) => a.entry);
    expect(added.map((e) => [e.kind, e.actor, e.target?.id, e.undoable])).toEqual([["calendar_event_added", "agent", THU, true]]);
    const event = [...fake.calendars.get("primary")!.values()][0]!;
    // The case's time zone: 10:30 in America/Denver.
    expect(event).toMatchObject({ status: "confirmed", summary: "Appointment", start: { dateTime: "2026-11-12T17:30:00.000Z", timeZone: "America/Denver" } });

    // The person undoes the calendar write in the app.
    const api = createApi(app.intake, app.kase, { mode: "recorded" }, app.reply, { store: app.store, records: app.records, google });
    const activity = (await api({ method: "GET", path: "/api/activity", body: undefined })).body as { activityVersion: number; entries: Array<{ id: string; kind: string; undone: boolean; summary: string }> };
    const res = await api({ method: "POST", path: `/api/activity/${added[0]!.id}/undo`, body: { expectedVersion: activity.activityVersion }, generation: app.kase.generation() });
    expect(res.status).toBe(200);
    expect(fake.calendars.get("primary")!.get(event.id)!.status).toBe("cancelled");
    const after = (await api({ method: "GET", path: "/api/activity", body: undefined })).body as typeof activity;
    expect(after.entries.find((e) => e.id === added[0]!.id)).toMatchObject({ kind: "calendar_event_added", undone: true });
    expect(after.entries[0]).toMatchObject({ kind: "undo" });
    expect(after.entries[0]!.summary).toContain("Removed the Google Calendar event the app added for Thursday 11/12 10:30 AM.");
    // A second undo of the same entry is refused, and Google is not called.
    const calls = fake.calls.length;
    const again = await api({ method: "POST", path: `/api/activity/${added[0]!.id}/undo`, body: { expectedVersion: after.activityVersion }, generation: app.kase.generation() });
    expect(again).toMatchObject({ status: 409, body: { error: "undo_blocked" } });
    expect(fake.calls.length).toBe(calls);
  });

  it("D2': in a paste turn gmail_import counts as an import, and calendar writes are refused", async () => {
    const { fake, app } = await connected();
    const model = sequence(
      reply(fnCall("gmail_import", { message_id: "18f0a1" })),
      reply(fnCall("accept_claim", { claims: [{ evidence_id: "gmail-18f0a1-e1", expected_version: 1 }] })),
      reply(fnCall("calendar_sync_slot", { slot_key: THU, restore_removed: null })),
      reply(message("I accepted the confirmation for Thursday 11/12 10:30 AM from the email. Adding it to your calendar waits for your next message.")),
    );
    const agent = agentFor(app, model);
    // A line break makes this a turn that may contain a paste.
    const r = await say(agent, app, "Use the clinic email in Gmail.\nAlso add it to my calendar.");
    expect(r.report.tools.map((t) => [t.tool, t.code])).toEqual([
      ["gmail_import", "ok"],
      ["accept_claim", "ok"],
      ["calendar_sync_slot", "waits_for_person"],
    ]);
    expect(r.of("action").map((a) => a.entry.kind)).toEqual(["gmail_message_imported", "claim_accepted"]);
    expect(fake.calls.some((c) => c.url.pathname.startsWith("/calendar/") && c.method !== "GET")).toBe(false);
  });

  it("without the Google services the tools answer google_not_configured and write nothing", async () => {
    const { app } = await connected();
    const { google: _g, ...plain } = app;
    const model = sequence(reply(fnCall("gmail_search", { days: null, senders: null })), reply(message("Google is not set up in this app.")));
    const r = await say(agentFor(plain, model), plain, "Search my Gmail.");
    expect(r.report.tools.map((t) => [t.tool, t.code])).toEqual([["gmail_search", "google_not_configured"]]);
    expect(r.of("action")).toEqual([]);
  });

  it("over MCP an external agent gets the same tools, logged as mcp, and the shared undo tool reverses the write at Google", async () => {
    const { fake, app } = await connected();
    const m = app.intake.importMessage({ id: "m-thu", channel: "email", from: "Front Desk", received_at: "2026-10-31T09:12:00-06:00", text: TEXT });
    await app.intake.extract("m-thu", { effort: "minimal", expectedVersion: m.version });
    for (const e of app.intake.reviewQueue()) app.intake.accept(e.id, e.version);
    const ctx = mcpContext(app.store, app, CLOCK());
    const sync = mcpTool("calendar_sync_slot")!;
    const done = await sync.run(ctx, sync.input.parse({ slot_key: THU, restore_removed: null }));
    expect(done.output).toMatchObject({ action: "created", activity: { undoable: true } });
    const activity = done.output.activity as { activity_id: string; activity_version: number };
    expect(ctx.actions.activity().entries[0]).toMatchObject({ kind: "calendar_event_added", actor: "mcp" });
    const undo = mcpTool("undo")!;
    const undone = await undo.run(ctx, undo.input.parse({ activity_id: activity.activity_id, expected_version: activity.activity_version }));
    expect(undone.ok).toBe(true);
    expect([...fake.calendars.get("primary")!.values()][0]!.status).toBe("cancelled");
  });
});
