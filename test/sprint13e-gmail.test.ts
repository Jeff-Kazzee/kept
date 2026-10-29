// Sprint 13E (0018): the opening Gmail step from live run 3. One ask
// imports every matching email (H1), code offers any found email the turn
// did not add (H2), the tools give the office's name as the page shows it
// and the time an email arrived (H3), a removed event's Undo does nothing
// harmful (H5) and a deliberate refusal is not a failed step (H6).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../server/api.ts";
import { loggedPath } from "../server/request-log.ts";
import { CaseActions, YOU } from "../src/actions/service.ts";
import { checkAnswer } from "../src/agent/grounding.ts";
import type { Card } from "../src/agent/types.ts";
import { GoogleCalendar } from "../src/google/calendar.ts";
import { GoogleConnection } from "../src/google/connection.ts";
import { GoogleCalendarEvents } from "../src/google/events.ts";
import { Gmail } from "../src/google/gmail.ts";
import { MAX_GMAIL_IMPORTS, googleToolByName, type GoogleServices } from "../src/google/tools.ts";
import { SecretsStore } from "../src/model/providers/secrets.ts";
import { RecordedModelClient, type Recording } from "../src/model/recorded.ts";
import { EventStore } from "../src/store/event-log.ts";
import { CLOCK, agentFor, fnCall, message, reply, say, sequence, services, turnOutputs } from "./agent-helpers.ts";
import { FAKE_CLIENT, FakeGoogle, gmailMessage } from "./google-fake.ts";

// Two emails from one office, as in run 3. The account's display name is
// "lantern hill", and the first email's place spells the office in full.
const FROM = "lantern hill <front@lanternhill.example>";
const FIRST = { id: "19a001", at: "2026-10-29T00:41:00Z", date: "Wed, 28 Oct 2026 18:41:00 -0600" };
const SECOND = { id: "19a002", at: "2026-10-29T00:43:00Z", date: "Wed, 28 Oct 2026 18:43:00 -0600" };
const OTHER = { id: "19b001", at: "2026-10-27T15:00:00Z", date: "Tue, 27 Oct 2026 09:00:00 -0600" };
const FIRST_TEXT = "Hi Dana,\n\nThis confirms your appointment on Thursday, November 12 at 10:30 AM at Lantern Hill Clinic, 400 Elm Street, Suite 2.\n\nFront Desk";
const SECOND_TEXT =
  "Dana, we need to move your Thursday, November 12 10:30 AM visit. We can offer Friday, November 13 at 9:15 AM or Monday, November 16 at 1:00 PM.\n\nFront Desk";
const OTHER_TEXT = "Reminder: your cleaning is on Tuesday, November 24 at 8:00 AM.\n\nPine Dental";

const claim = (c: Record<string, unknown>) => ({ location: null, sender_kind: "person", event_time: null, request_item: null, ...c });
const recordings: Recording[] = [
  {
    message_id: `gmail-${FIRST.id}`,
    effort: "any",
    attempts: [
      {
        output: {
          claims: [
            claim({
              claim_type: "confirm",
              date: "2026-11-12",
              time: "10:30",
              location: "Lantern Hill Clinic, 400 Elm Street, Suite 2",
              quote: "This confirms your appointment on Thursday, November 12 at 10:30 AM at Lantern Hill Clinic, 400 Elm Street, Suite 2.",
            }),
          ],
        },
        usage: { input: 1, cached_input: 0, output: 1, reasoning: 0 },
        latency_ms: 1,
      },
    ],
  },
  {
    message_id: `gmail-${SECOND.id}`,
    effort: "any",
    attempts: [
      {
        output: {
          claims: [
            claim({ claim_type: "offer", date: "2026-11-13", time: "09:15", quote: "We can offer Friday, November 13 at 9:15 AM or Monday, November 16 at 1:00 PM." }),
            claim({ claim_type: "offer", date: "2026-11-16", time: "13:00", quote: "We can offer Friday, November 13 at 9:15 AM or Monday, November 16 at 1:00 PM." }),
          ],
        },
        usage: { input: 1, cached_input: 0, output: 1, reasoning: 0 },
        latency_ms: 1,
      },
    ],
  },
  {
    message_id: `gmail-${OTHER.id}`,
    effort: "any",
    attempts: [
      {
        output: { claims: [claim({ claim_type: "reminder", date: "2026-11-24", time: "08:00", quote: "Reminder: your cleaning is on Tuesday, November 24 at 8:00 AM." })] },
        usage: { input: 1, cached_input: 0, output: 1, reasoning: 0 },
        latency_ms: 1,
      },
    ],
  },
];

// The same confirmation, pasted, for the calendar tests.
recordings.push({ ...recordings[0]!, message_id: "m-thu" });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const email = (fake: FakeGoogle, e: { id: string; at: string; date: string }, text: string, from = FROM, subject = "Your appointment") =>
  fake.messages.set(e.id, gmailMessage(e.id, { from, subject, date: e.date, internalDate: String(Date.parse(e.at)), plain: text }));

async function connected(options: { other?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sprint13e-"));
  dirs.push(dir);
  const fake = new FakeGoogle();
  const connection = new GoogleConnection({ client: FAKE_CLIENT, store: new SecretsStore(path.join(dir, "app-secrets.sqlite")), fetch: fake.fetch, now: () => fake.now });
  const flow = connection.startConnect({ expectedVersion: 0, features: { gmail: true, calendar: true }, calendarId: "primary", redirectUri: "http://127.0.0.1:5192/auth/google/callback" });
  const back = fake.consent(flow.authorizeUrl);
  await connection.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null, cookie: flow.cookie });
  email(fake, FIRST, FIRST_TEXT);
  email(fake, SECOND, SECOND_TEXT);
  if (options.other) email(fake, OTHER, OTHER_TEXT, "Pine Dental <desk@pinedental.example>", "Cleaning reminder");
  const models = RecordedModelClient.withOverrides(recordings, RecordedModelClient.fromDirectory());
  const app = services(new EventStore(":memory:", CLOCK), CLOCK, models);
  const calendar = new GoogleCalendar(connection, { timeZone: () => app.kase.timeZone() });
  const google: GoogleServices = { connection, gmail: new Gmail(connection), calendar, events: new GoogleCalendarEvents(calendar) };
  const full = { ...app, google };
  const api = createApi(app.intake, app.kase, {}, app.reply, { store: app.store, records: app.records, google });
  return { fake, app: full, google, api };
}

const waiting = (cards: Card[]) => cards.filter((c) => c.kind === "gmail_waiting");
const SEARCH = () => reply(fnCall("gmail_search", { days: null, senders: null }));

describe("sprint 13E, H1: one ask imports every matching email", () => {
  it("imports several emails in one call, each with its own entry, card and Undo", async () => {
    const { app } = await connected();
    const model = sequence(
      SEARCH(),
      reply(fnCall("gmail_import", { message_ids: [FIRST.id, SECOND.id, FIRST.id] })),
      reply(message("I imported both emails from the office.")),
    );
    const r = await say(agentFor(app, model), app, "Check my Gmail for messages from Lantern Hill Clinic and update my schedule.");
    expect(r.report.tools.map((t) => [t.tool, t.code])).toEqual([
      ["gmail_search", "ok"],
      ["gmail_import", "ok"],
    ]);
    // Once each, in the order given.
    expect(r.of("action").map((a) => [a.entry.kind, a.entry.target?.id])).toEqual([
      ["gmail_message_imported", `gmail-${FIRST.id}`],
      ["gmail_message_imported", `gmail-${SECOND.id}`],
    ]);
    expect(r.report.cards.filter((c) => c.kind === "claims").map((c) => (c as { messageId: string }).messageId)).toEqual([`gmail-${FIRST.id}`, `gmail-${SECOND.id}`]);
    expect(waiting(r.report.cards)).toEqual([]);
    const out = turnOutputs(model.calls[2]!.body.input).find((o) => o.name === "gmail_import")!.output;
    expect(out).toMatchObject({ imported: 2, already_imported: 0, refused: 0 });
    expect(out.results.map((x: { message_id: string; status: string }) => [x.message_id, x.status])).toEqual([
      [FIRST.id, "imported"],
      [SECOND.id, "imported"],
    ]);
    // Undo of one leaves the other.
    const actions = new CaseActions(app.store, app);
    await actions.undoEntry(YOU, r.of("action")[0]!.entry.id, actions.activityVersion());
    expect(app.intake.messages().map((m) => m.id)).toEqual([`gmail-${SECOND.id}`]);
  });

  it("one email that cannot be imported does not stop the others", async () => {
    const { app, fake } = await connected();
    fake.messages.set("19a00e", gmailMessage("19a00e", { from: FROM, subject: "", internalDate: String(Date.parse(FIRST.at)), plain: "" }));
    const run = googleToolByName("gmail_import")!;
    const ctx = {
      ...app,
      actions: new CaseActions(app.store, app),
      by: { actor: "agent" as const },
      userText: "Import them.",
      sentAt: CLOCK(),
      zone: app.kase.timeZone(),
      today: "2026-11-05",
      messageIdFor: () => "x",
      turn: { paste: false, imported: [], gmailImported: [], gmailFound: [], gmailRefused: [] },
    };
    const r = await run.run(ctx as never, run.input.parse({ message_ids: ["19a00e", FIRST.id] }));
    expect([r.ok, r.code]).toEqual([true, "partial"]);
    expect((r.output as { results: Array<{ error?: string }> }).results.map((x) => x.error ?? "ok")).toEqual(["empty_message", "ok"]);
    expect(ctx.turn.gmailRefused).toEqual(["19a00e"]);
    expect(app.intake.messages().map((m) => m.id)).toEqual([`gmail-${FIRST.id}`]);
    // At most MAX_GMAIL_IMPORTS ids, and at least one.
    expect(run.input.safeParse({ message_ids: Array.from({ length: MAX_GMAIL_IMPORTS + 1 }, (_, i) => `a${i}`) }).success).toBe(false);
    expect(run.input.safeParse({ message_ids: [] }).success).toBe(false);
    expect(run.input.safeParse({ message_ids: Array.from({ length: MAX_GMAIL_IMPORTS }, (_, i) => `a${i}`) }).success).toBe(true);
  });
});

describe("sprint 13E, H2: code offers the found emails the turn did not add", () => {
  it("adds a card for the matching email the model left out, as in run 3, and the model's next turn sees it", async () => {
    const { app } = await connected();
    const model = sequence(
      SEARCH(),
      reply(fnCall("gmail_import", { message_ids: [FIRST.id] })),
      reply(fnCall("accept_claim", { claims: [{ evidence_id: `gmail-${FIRST.id}-e1`, expected_version: 1 }] })),
      reply(message("I imported the email from Lantern Hill Clinic sent Wednesday 10/28 6:41 PM. Thursday 11/12 10:30 AM is confirmed.")),
      reply(message("Hello.")),
    );
    const agent = agentFor(app, model);
    const r = await say(agent, app, "Check my Gmail for messages from Lantern Hill Clinic and update my schedule.");
    expect(r.report.outcome).toBe("answered");
    const cards = waiting(r.report.cards);
    expect(cards).toEqual([
      { kind: "gmail_waiting", gmailId: SECOND.id, messageId: `gmail-${SECOND.id}`, receivedAt: "2026-10-29T00:43:00.000Z", office: "Lantern Hill Clinic", sameSenderAs: `gmail-${FIRST.id}` },
    ]);
    // It reached the page as a card event and is stored with the answer.
    expect(r.of("card").map((c) => c.card.kind)).toContain("gmail_waiting");
    expect(agent.chat().messages.at(-1)!.cards).toContainEqual(cards[0]);
    // No email address or body text on the card.
    expect(JSON.stringify(cards)).not.toMatch(/@|Dana, we need/);
    // The next turn's history names it with its id, for "import the other one".
    await say(agent, app, "Hi");
    expect(JSON.stringify(model.calls[4]!.body.input)).toContain(`Gmail message_id ${SECOND.id} found and not in the case`);
  });

  it("offers nothing once every match is in the case, and nothing from another sender when the turn imported some", async () => {
    const { app } = await connected({ other: true });
    const model = sequence(SEARCH(), reply(fnCall("gmail_import", { message_ids: [FIRST.id, SECOND.id] })), reply(message("Both are in.")));
    const r = await say(agentFor(app, model), app, "Check my Gmail for messages from Lantern Hill Clinic.");
    expect(waiting(r.report.cards)).toEqual([]);
  });

  it("offers every new email when the turn imported none, and none that is already in the case", async () => {
    const { app } = await connected({ other: true });
    const first = sequence(reply(fnCall("gmail_import", { message_ids: [FIRST.id] })), reply(message("Done.")));
    await say(agentFor(app, first), app, "Import the clinic email.");
    const model = sequence(SEARCH(), reply(message("I found your emails.")));
    const r = await say(agentFor(app, model), app, "What is in my Gmail?");
    expect(waiting(r.report.cards).map((c) => (c as { gmailId: string }).gmailId)).toEqual([SECOND.id, OTHER.id]);
    // The other office is named as the page would name one unread email
    // of its own: held back, so "the office" on the page.
    expect(waiting(r.report.cards)[1]).toMatchObject({ office: null, sameSenderAs: null });
  });

  it("a search limited to senders offers each of its emails, and an email refused for its content is not offered", async () => {
    const { app, fake } = await connected();
    fake.messages.set("19a00e", gmailMessage("19a00e", { from: FROM, subject: "", internalDate: String(Date.parse(FIRST.at)), plain: "" }));
    const model = sequence(
      reply(fnCall("gmail_search", { days: null, senders: ["front@lanternhill.example"] })),
      reply(fnCall("gmail_import", { message_ids: ["19a00e"] })),
      reply(message("One email could not be read.")),
    );
    const r = await say(agentFor(app, model), app, "Check my Gmail for the clinic.");
    expect(waiting(r.report.cards).map((c) => (c as { gmailId: string }).gmailId)).toEqual([FIRST.id, SECOND.id]);
  });

  it("a stopped turn still offers them", async () => {
    const { app } = await connected();
    const model = sequence(SEARCH(), reply(fnCall("gmail_search", { days: 7, senders: null })), reply(fnCall("gmail_search", { days: 8, senders: null })));
    const r = await say(agentFor(app, model, { limits: { maxToolCalls: 2 } }), app, "Check my Gmail.");
    expect(r.report.outcome).toBe("stopped");
    expect(waiting(r.report.cards)).toHaveLength(2);
  });

  it("Add it is the person's import: logged, undoable, no model call, and the page reads it afterwards", async () => {
    const { app, api } = await connected();
    const generation = app.kase.generation();
    const res = await api({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {}, generation });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: `gmail-${SECOND.id}`, status: "imported", importedFrom: "gmail", sourceType: "office_message" });
    // Not read yet: no model call was made.
    expect(app.intake.evidence()).toEqual([]);
    const activity = (await api({ method: "GET", path: "/api/activity", body: undefined })).body as { activityVersion: number; entries: Array<{ id: string; kind: string; actor: string; undoable: boolean }> };
    expect(activity.entries.map((e) => [e.kind, e.actor, e.undoable])).toEqual([["gmail_message_imported", "you", true]]);
    // A second Add finds the same message and logs nothing.
    expect((await api({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {}, generation })).status).toBe(200);
    expect(((await api({ method: "GET", path: "/api/activity", body: undefined })).body as typeof activity).entries).toHaveLength(1);
    // The page then reads it through the extract route, as for a paste.
    const m = app.intake.message(`gmail-${SECOND.id}`);
    expect((await api({ method: "POST", path: `/api/messages/gmail-${SECOND.id}/extract`, body: { expectedVersion: m.version }, generation })).status).toBe(200);
    expect(app.intake.evidence().map((e) => [e.claim.slot.date, e.status])).toEqual([
      ["2026-11-13", "pending"],
      ["2026-11-16", "pending"],
    ]);
    // Undo removes it.
    const now = (await api({ method: "GET", path: "/api/activity", body: undefined })).body as typeof activity;
    const undone = await api({ method: "POST", path: `/api/activity/${now.entries.at(-1)!.id}/undo`, body: { expectedVersion: now.activityVersion }, generation });
    expect(undone.status).toBe(200);
    expect(app.intake.messages()).toEqual([]);
  });

  it("the request log writes the route's words and never the Gmail id", () => {
    expect(loggedPath(`/api/gmail/${SECOND.id}/add`)).toBe("/api/gmail/*/add");
  });

  it("Add it refuses a bad id, a write with no generation and an app without Google", async () => {
    const { app, api } = await connected();
    expect((await api({ method: "POST", path: "/api/gmail/a%2Fb/add", body: {}, generation: app.kase.generation() })).status).toBe(400);
    expect((await api({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {} })).body).toMatchObject({ error: "generation_required" });
    const bare = createApi(app.intake, app.kase, {}, app.reply, { store: app.store, records: app.records });
    expect(await bare({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {}, generation: app.kase.generation() })).toMatchObject({ status: 503, body: { error: "google_not_configured" } });
    expect(app.intake.messages()).toEqual([]);
  });
});

describe("sprint 13E, H3: names and times in the tool outputs", () => {
  it("names the office as the page does, never by an address, and its sent time grounds the answer", async () => {
    const { app } = await connected();
    const model = sequence(
      SEARCH(),
      reply(fnCall("gmail_import", { message_ids: [FIRST.id] })),
      reply(fnCall("accept_claim", { claims: [{ evidence_id: `gmail-${FIRST.id}-e1`, expected_version: 1 }] })),
      reply(fnCall("gmail_search", { days: null, senders: null })),
      reply(message("Done.")),
    );
    await say(agentFor(app, model), app, "Check my Gmail.");
    const outputs = turnOutputs(model.calls[4]!.body.input);
    const [before, , accepted, after] = outputs.map((o) => o.output);
    // A lone unread email: held back, so null ("the office").
    expect(before.messages.map((m: { office: unknown }) => m.office)).toEqual([null, null]);
    expect(before.messages[0].sent_label).toBe("Wednesday 10/28 6:41 PM");
    // After its place was accepted, the fuller name the page shows.
    expect(accepted.offices).toEqual([{ message_id: `gmail-${FIRST.id}`, office: { untrusted_text: "Lantern Hill Clinic" } }]);
    expect(after.messages.map((m: { office: unknown }) => m.office)).toEqual([{ untrusted_text: "Lantern Hill Clinic" }, { untrusted_text: "Lantern Hill Clinic" }]);
    expect(JSON.stringify([before.messages.map((m: { office: unknown }) => m.office), accepted.offices])).not.toContain("@");
    // The import gives the received label too.
    expect(outputs[1]!.output.results[0].source).toMatchObject({ office: null, received_label: "Wednesday 10/28 6:41 PM" });
  });

  it("an answer that names an email by its sender and sent time passes the checks", async () => {
    const { app } = await connected();
    const model = sequence(SEARCH(), reply(message("The email from Lantern Hill Clinic sent Wednesday 10/28 6:43 PM is not in your case yet.")));
    const r = await say(agentFor(app, model), app, "What is in my Gmail?");
    expect([r.report.outcome, r.report.problems]).toEqual(["answered", [[]]]);
    // Without the search the same time is not grounded.
    expect(checkAnswer("The email sent Wednesday 10/28 6:43 PM.", { facts: [], statuses: new Set(), today: "2026-11-05" })).toContain("ungrounded");
  });
});

describe("sprint 13E, H5 and H6: an event removed in Google Calendar", () => {
  async function removed() {
    const { app, api, fake } = await connected();
    const m = app.intake.importMessage({ id: "m-thu", channel: "email", from: "Front Desk", received_at: "2026-10-31T09:12:00-06:00", text: FIRST_TEXT });
    await app.intake.extract("m-thu", { effort: "minimal", expectedVersion: m.version });
    for (const e of app.intake.reviewQueue()) app.intake.accept(e.id, e.version);
    const add = sequence(reply(fnCall("calendar_sync_slot", { slot_key: "2026-11-12T10:30", restore_removed: null })), reply(message("Added.")));
    const done = await say(agentFor(app, add), app, "Put it on my calendar.");
    const entry = done.of("action")[0]!.entry;
    // The person deletes it in Google Calendar.
    const [event] = [...fake.calendars.get("primary")!.values()];
    event!.status = "cancelled";
    return { app, api, fake, entry };
  }

  it("H5: Undo of the earlier add writes nothing at Google and says the event was already gone", async () => {
    const { app, api, fake, entry } = await removed();
    const writes = fake.calls.filter((c) => c.url.pathname.startsWith("/calendar/") && c.method !== "GET").length;
    const log = (await api({ method: "GET", path: "/api/activity", body: undefined })).body as { activityVersion: number; entries: Array<{ kind: string; summary: string }> };
    const res = await api({ method: "POST", path: `/api/activity/${entry.id}/undo`, body: { expectedVersion: log.activityVersion }, generation: app.kase.generation() });
    expect(res.status).toBe(200);
    expect(fake.calls.filter((c) => c.url.pathname.startsWith("/calendar/") && c.method !== "GET")).toHaveLength(writes);
    const after = (await api({ method: "GET", path: "/api/activity", body: undefined })).body as typeof log;
    expect(after.entries[0]!.summary).toContain("was already gone");
  });

  it("H6: the refusal to add it back is a step that chose not to act, not one that failed", async () => {
    const { app } = await removed();
    const model = sequence(reply(fnCall("calendar_sync_slot", { slot_key: "2026-11-12T10:30", restore_removed: null })), reply(message("It was removed in Google Calendar, so I left it.")));
    const r = await say(agentFor(app, model), app, "Put the Thursday appointment on my Google Calendar.");
    expect(r.report.tools).toEqual([{ tool: "calendar_sync_slot", ok: false, code: "google_changed" }]);
    expect(r.of("tool.finished")).toMatchObject([{ ok: false, declined: true }]);
    // A failure for another reason is not marked.
    const bad = sequence(reply(fnCall("calendar_sync_slot", { slot_key: "2026-11-12T10:30", restore_removed: null })), reply(message("That did not work.")));
    const { fake: _f, ...rest } = await connected();
    const r2 = await say(agentFor({ ...rest.app, google: undefined } as never, bad), rest.app, "Put it on my calendar.");
    expect(r2.of("tool.finished")[0]).not.toHaveProperty("declined");
  });
});
