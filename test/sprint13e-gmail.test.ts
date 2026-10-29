// Sprint 13E (0018): the opening Gmail step from live run 3. One ask
// imports every matching email (H1), code offers any found email the turn
// did not add (H2), the tools give the office's name as the page shows it
// and the time an email arrived (H3), a removed event's Undo does nothing
// harmful (H5) and a deliberate refusal is not a failed step (H6).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutOfScopeError } from "../src/domain/scope.ts";
import { createApi } from "../server/api.ts";
import { createWorkspace } from "../server/workspace.ts";
import { gmailOffers, recordGmailOffers } from "../src/google/offers.ts";
import { BudgetError } from "../src/model/meter.ts";
import { loggedPath } from "../server/request-log.ts";
import { CaseActions, YOU } from "../src/actions/service.ts";
import { checkAnswer } from "../src/agent/grounding.ts";
import type { Card } from "../src/agent/types.ts";
import { GoogleCalendar } from "../src/google/calendar.ts";
import { GoogleConnection } from "../src/google/connection.ts";
import { GoogleCalendarEvents } from "../src/google/events.ts";
import { Gmail } from "../src/google/gmail.ts";
import { MAX_GMAIL_IMPORTS, addGmailMessage, googleToolByName, type GoogleServices } from "../src/google/tools.ts";
import { SecretsStore } from "../src/model/providers/secrets.ts";
import { RecordedModelClient, type Recording } from "../src/model/recorded.ts";
import { EventStore } from "../src/store/event-log.ts";
import { CLOCK, agentFor, fixtureMessage, fnCall, message, reply, say, sequence, services, turnOutputs } from "./agent-helpers.ts";
import { FAKE_CLIENT, FakeGoogle, gmailMessage } from "./google-fake.ts";

// Two emails from one office, as in run 3. The account's display name is
// "lantern hill", and the first email's place spells the office in full.
const FROM = "lantern hill <front@lanternhill.example>";
const FIRST = { id: "19a001", at: "2026-10-29T00:41:00Z", date: "Wed, 28 Oct 2026 18:41:00 -0600" };
const SECOND = { id: "19a002", at: "2026-10-29T00:43:00Z", date: "Wed, 28 Oct 2026 18:43:00 -0600" };
const OTHER = { id: "19b001", at: "2026-10-27T15:00:00Z", date: "Tue, 27 Oct 2026 09:00:00 -0600" };
const FIRST_TEXT = "Hi Dana,\n\nThis confirms your appointment on Thursday, November 12 at 10:30 AM at Lantern Hill Clinic, 400 Elm Street, Suite 2.\n\nFront Desk";
const SECOND_TEXT =
  "Dana, we need to move your Thursday, November 12 10:30 AM visit. We can offer Friday, November 13 at 9:15 AM or Monday, November 16 at 1:00 PM.\n\nFront Desk, Lantern Hill Clinic";
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
  vi.restoreAllMocks();
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

// A turn that imports the first email and leaves the second, so code
// offers the second with "Add it".
async function offerSecond(app: Awaited<ReturnType<typeof connected>>["app"]) {
  const model = sequence(SEARCH(), reply(fnCall("gmail_import", { message_ids: [FIRST.id] })), reply(message("I imported one email from the office.")));
  const r = await say(agentFor(app, model), app, "Check my Gmail.");
  expect(waiting(r.report.cards).map((c) => (c as { gmailId: string }).gmailId)).toEqual([SECOND.id]);
  return r;
}
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
    await offerSecond(app);
    // The turn's own import is undone, so the activity holds only Add it.
    const turnActions = new CaseActions(app.store, app);
    await turnActions.undoEntry(YOU, turnActions.activity().entries.find((e) => e.kind === "gmail_message_imported")!.id, turnActions.activityVersion());
    const before = turnActions.activity().entries.length;
    const generation = app.kase.generation();
    const res = await api({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {}, generation });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: `gmail-${SECOND.id}`, status: "imported", importedFrom: "gmail", sourceType: "office_message" });
    // Not read yet: no model call was made.
    expect(app.intake.evidence()).toEqual([]);
    const activity = (await api({ method: "GET", path: "/api/activity", body: undefined })).body as { activityVersion: number; entries: Array<{ id: string; kind: string; actor: string; undoable: boolean }> };
    expect(activity.entries).toHaveLength(before + 1);
    expect(activity.entries.slice(0, 1).map((e) => [e.kind, e.actor, e.undoable])).toEqual([["gmail_message_imported", "you", true]]);
    // Fix round 2, F3: the add used the offer, so a second Add is refused
    // and logs nothing.
    expect(await api({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {}, generation })).toMatchObject({ status: 409, body: { error: "gmail_not_offered" } });
    expect(((await api({ method: "GET", path: "/api/activity", body: undefined })).body as typeof activity).entries).toHaveLength(before + 1);
    // The page then reads it through the extract route, as for a paste.
    const m = app.intake.message(`gmail-${SECOND.id}`);
    expect((await api({ method: "POST", path: `/api/messages/gmail-${SECOND.id}/extract`, body: { expectedVersion: m.version }, generation })).status).toBe(200);
    expect(app.intake.evidence().map((e) => [e.claim.slot.date, e.status])).toEqual([
      ["2026-11-13", "pending"],
      ["2026-11-16", "pending"],
    ]);
    // Undo removes it.
    const now = (await api({ method: "GET", path: "/api/activity", body: undefined })).body as typeof activity;
    const added = now.entries.find((e) => e.kind === "gmail_message_imported" && e.actor === "you")!;
    const undone = await api({ method: "POST", path: `/api/activity/${added.id}/undo`, body: { expectedVersion: now.activityVersion }, generation });
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
    expect(outputs[1]!.output.results[0].source).toMatchObject({ office: null, sender_domain: "lanternhill.example", received_label: "Wednesday 10/28 6:41 PM" });
    expect(outputs[1]!.output.results[0].source).not.toHaveProperty("from");
  });

  it("an answer that names an email by its sender and sent time passes the checks", async () => {
    const { app } = await connected();
    // Fix round 1, R3: while office is null the page says "the office", and
    // the search gives no sender name to copy.
    const model = sequence(SEARCH(), reply(message("The email from the office sent Wednesday 10/28 6:43 PM is not in your case yet.")));
    const r = await say(agentFor(app, model), app, "What is in my Gmail?");
    expect([r.report.outcome, r.report.problems]).toEqual(["answered", [[]]]);
    const output = turnOutputs(model.calls[1]!.body.input)[0]!.output;
    const found = output.messages as Array<Record<string, unknown>>;
    expect(found.map((m) => Object.keys(m))).toEqual(
      found.map(() => ["message_id", "office", "sender_domain", "subject", "sent_at", "sent_label", "body", "body_truncated", "already_imported"]),
    );
    expect(found.map((m) => [m.office, m.sender_domain])).toEqual([
      [null, "lanternhill.example"],
      [null, "lanternhill.example"],
    ]);
    // Fix round 2, F5: the whole output, body included. No address and no
    // sender line anywhere. The office's name appears only where the email
    // itself signs it, inside the body, which is labeled message text.
    const all = JSON.stringify(output);
    expect(all).not.toMatch(/front@|lantern hill </i);
    expect(found.map((m) => (m.body as { untrusted_text: string }).untrusted_text.includes("Lantern Hill Clinic"))).toEqual([true, true]);
    const withoutBodies = JSON.stringify({ ...output, messages: found.map(({ body: _b, ...rest }) => rest) });
    expect(withoutBodies).not.toMatch(/lantern hill/i);
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
    // The answer may name the appointment it left out.
    expect(r.report.outcome).toBe("answered");
    const named = sequence(reply(fnCall("calendar_sync_slot", { slot_key: "2026-11-12T10:30", restore_removed: null })), reply(message("Thursday 11/12 10:30 AM was removed in Google Calendar, so I did not add it back.")));
    expect((await say(agentFor(app, named), app, "Put it on my Google Calendar.")).report.problems).toEqual([[]]);
    // A failure for another reason is not marked.
    const bad = sequence(reply(fnCall("calendar_sync_slot", { slot_key: "2026-11-12T10:30", restore_removed: null })), reply(message("That did not work.")));
    const { fake: _f, ...rest } = await connected();
    const r2 = await say(agentFor({ ...rest.app, google: undefined } as never, bad), rest.app, "Put it on my calendar.");
    expect(r2.of("tool.finished")[0]).not.toHaveProperty("declined");
  });
});

describe("sprint 13E fix round 1, R1: Add it imports only what code offered", () => {
  it("refuses an id no turn offered, and imports nothing", async () => {
    const { app, api } = await connected();
    const res = await api({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {}, generation: app.kase.generation() });
    expect(res).toMatchObject({ status: 409, body: { error: "gmail_not_offered" } });
    expect(app.intake.messages()).toEqual([]);
    expect(new CaseActions(app.store, app).activity().entries).toEqual([]);
    // Found by a search but not offered: the turn imported it.
    await offerSecond(app);
    await new CaseActions(app.store, app).undoEntry(YOU, new CaseActions(app.store, app).activity().entries.find((e) => e.kind === "gmail_message_imported")!.id, new CaseActions(app.store, app).activityVersion());
    expect((await api({ method: "POST", path: `/api/gmail/${FIRST.id}/add`, body: {}, generation: app.kase.generation() })).status).toBe(409);
    expect((await api({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {}, generation: app.kase.generation() })).status).toBe(200);
  });

  it("refuses an id offered before Delete case", async () => {
    const { app, api } = await connected();
    await offerSecond(app);
    expect(gmailOffers(app.store)).toHaveLength(1);
    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    expect(gmailOffers(app.store)).toEqual([]);
    const res = await api({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {}, generation: app.kase.generation() });
    expect(res).toMatchObject({ status: 409, body: { error: "gmail_not_offered" } });
    expect(app.intake.messages()).toEqual([]);
  });

  it("refuses an id offered under another Google account", async () => {
    const { app, api, fake, google } = await connected();
    await offerSecond(app);
    // The same id in another mailbox, after the person connects as someone else.
    fake.account = { sub: "2000002", email: "other.demo@example.com" };
    const flow = google.connection.startConnect({ expectedVersion: google.connection.status().version, features: { gmail: true, calendar: true }, calendarId: "primary", redirectUri: "http://127.0.0.1:5192/auth/google/callback" });
    const back = fake.consent(flow.authorizeUrl);
    await google.connection.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null, cookie: flow.cookie });
    expect(google.connection.gmailAccount()).toBe("2000002");
    const res = await api({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {}, generation: app.kase.generation() });
    expect(res).toMatchObject({ status: 409, body: { error: "gmail_not_offered" } });
    expect(app.intake.messages().map((m) => m.id)).toEqual([`gmail-${FIRST.id}`]);
  });

  it("the app drops every offer on a disconnect and on a connect as another account", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sprint13e-ws-"));
    dirs.push(dir);
    const fake = new FakeGoogle();
    const ws = createWorkspace({ dbPath: path.join(dir, "app.sqlite"), secretsPath: path.join(dir, "app-secrets.sqlite"), port: 5197, extraHosts: [], googleClient: FAKE_CLIENT, googleFetch: fake.fetch, serverMetaKey: null });
    try {
      const host = "127.0.0.1:5197";
      const route = (p: string, body: unknown) => ws.googleRoutes.api({ method: "POST", path: p, body, generation: ws.kase.generation(), host, secure: false });
      const connect = async () => {
        const started = await route("/api/google/connect", { expectedVersion: ws.googleConnection.status().version });
        const back = fake.consent((started.body as { authorizeUrl: string }).authorizeUrl);
        await ws.googleRoutes.callback(back, started.setCookie!.split(";")[0]!);
      };
      const offer = () => recordGmailOffers(ws.store, [{ gmail_id: SECOND.id, account: ws.googleConnection.gmailAccount()!, generation: ws.kase.generation() }]);
      await connect();
      offer();
      expect(gmailOffers(ws.store)).toHaveLength(1);
      expect((await route("/api/google/disconnect", { expectedVersion: ws.googleConnection.status().version })).status).toBe(200);
      expect(gmailOffers(ws.store)).toEqual([]);
      await connect();
      offer();
      // The same account again keeps them. Another account drops them.
      await connect();
      expect(gmailOffers(ws.store)).toHaveLength(1);
      fake.account = { sub: "2000002", email: "other.demo@example.com" };
      await connect();
      expect(gmailOffers(ws.store)).toEqual([]);
      // Code's bookkeeping, not a line of the case history.
      expect(ws.kase.history().some((h) => h.streamId === "gmail_offers")).toBe(false);
    } finally {
      ws.close();
    }
  });
});

describe("sprint 13E fix round 2, F4: Gmail offers drop only when the Gmail account changes", () => {
  function workspace() {
    const dir = mkdtempSync(path.join(tmpdir(), "sprint13e-f4-"));
    dirs.push(dir);
    const fake = new FakeGoogle();
    const ws = createWorkspace({ dbPath: path.join(dir, "app.sqlite"), secretsPath: path.join(dir, "app-secrets.sqlite"), port: 5197, extraHosts: [], googleClient: FAKE_CLIENT, googleFetch: fake.fetch, serverMetaKey: null });
    const route = (p: string, body: unknown) => ws.googleRoutes.api({ method: "POST", path: p, body, generation: ws.kase.generation(), host: "127.0.0.1:5197", secure: false });
    const connect = async (options: Record<string, unknown> = {}) => {
      const started = await route("/api/google/connect", { expectedVersion: ws.googleConnection.status().version, ...options });
      const back = fake.consent((started.body as { authorizeUrl: string }).authorizeUrl);
      await ws.googleRoutes.callback(back, started.setCookie!.split(";")[0]!);
    };
    const offer = () => recordGmailOffers(ws.store, [{ gmail_id: SECOND.id, account: ws.googleConnection.gmailAccount()!, generation: ws.kase.generation() }]);
    return { fake, ws, connect, offer };
  }

  it("keeps them when only the calendar changes, and when the same account reconnects after it expired", async () => {
    const { fake, ws, connect, offer } = workspace();
    try {
      await connect();
      offer();
      await connect({ calendarId: "work@group.calendar.google.com" });
      expect(ws.googleConnection.accountKey()).toBe(`${fake.account.sub}|work@group.calendar.google.com`);
      expect(gmailOffers(ws.store)).toHaveLength(1);
      // Google refuses the grant: the connection needs reconnecting.
      fake.access.clear();
      fake.refreshFails = "invalid_grant";
      await new Gmail(ws.googleConnection).search({ days: 30, senders: [] }).catch(() => {});
      expect(ws.googleConnection.status().needsReconnect).toBe(true);
      fake.refreshFails = null;
      await connect();
      expect(ws.googleConnection.gmailAccount()).toBe(fake.account.sub);
      expect(gmailOffers(ws.store)).toHaveLength(1);
    } finally {
      ws.close();
    }
  });

  it("drops them when a Gmail-only connection reconnects as another account", async () => {
    const { fake, ws, connect, offer } = workspace();
    try {
      await connect({ gmail: true, calendar: false });
      expect(ws.googleConnection.accountKey()).toBeNull();
      offer();
      expect(gmailOffers(ws.store)).toHaveLength(1);
      fake.account = { sub: "2000002", email: "other.demo@example.com" };
      await connect({ gmail: true, calendar: false });
      expect(ws.googleConnection.gmailAccount()).toBe("2000002");
      expect(gmailOffers(ws.store)).toEqual([]);
    } finally {
      ws.close();
    }
  });
});

describe("sprint 13E fix round 2, F3: offers keep no account id and are used once", () => {
  it("stores a hash of the account, uses the offer on Add it, and an Undo of that import makes it addable again", async () => {
    const { app, api, fake } = await connected();
    await offerSecond(app);
    const stored = JSON.stringify(app.store.readStream("gmail_offers"));
    expect(stored).not.toContain(fake.account.sub);
    expect(stored).toMatch(/"account":"[0-9a-f]{32}"/);
    const add = () => api({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {}, generation: app.kase.generation() });
    expect((await add()).status).toBe(200);
    expect(gmailOffers(app.store).map((o) => [o.gmail_id, o.used])).toEqual([[SECOND.id, true]]);
    expect((await add()).status).toBe(409);
    // Undo of the person's import: the card offers it again, and Add works.
    const actions = new CaseActions(app.store, app);
    const mine = actions.activity().entries.find((e) => e.kind === "gmail_message_imported" && e.actor === "you")!;
    await actions.undoEntry(YOU, mine.id, actions.activityVersion());
    expect(app.intake.messages().map((m) => m.id)).not.toContain(`gmail-${SECOND.id}`);
    expect((await add()).status).toBe(200);
    expect(app.intake.messages().map((m) => m.id)).toContain(`gmail-${SECOND.id}`);
  });
});

describe("sprint 13E fix round 2, F1: Add it checks the offer again right before it imports", () => {
  async function raced(during: (google: GoogleServices, fake: FakeGoogle) => Promise<void>) {
    const { app, fake, google } = await connected();
    await offerSecond(app);
    const real = google.gmail;
    const gmail = {
      get: async (id: string) => {
        const m = await real.get(id);
        await during(google, fake);
        return m;
      },
    } as unknown as GoogleServices["gmail"];
    const api = createApi(app.intake, app.kase, {}, app.reply, { store: app.store, records: app.records, google: { ...google, gmail } });
    const before = new CaseActions(app.store, app).activity().entries.length;
    const res = await api({ method: "POST", path: `/api/gmail/${SECOND.id}/add`, body: {}, generation: app.kase.generation() });
    expect(res).toMatchObject({ status: 409, body: { error: "gmail_not_offered" } });
    expect(app.intake.messages().map((m) => m.id)).toEqual([`gmail-${FIRST.id}`]);
    expect(new CaseActions(app.store, app).activity().entries).toHaveLength(before);
    expect(gmailOffers(app.store).map((o) => o.used)).toEqual([false]);
  }

  it("refuses and writes nothing when another account connects while the email is read", async () => {
    await raced(async (google, fake) => {
      fake.account = { sub: "2000002", email: "other.demo@example.com" };
      const flow = google.connection.startConnect({ expectedVersion: google.connection.status().version, features: { gmail: true, calendar: true }, calendarId: "primary", redirectUri: "http://127.0.0.1:5192/auth/google/callback" });
      const back = fake.consent(flow.authorizeUrl);
      await google.connection.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null, cookie: flow.cookie });
    });
  });

  it("refuses and writes nothing when Google is disconnected while the email is read", async () => {
    await raced(async (google) => {
      await google.connection.disconnect(google.connection.status().version);
    });
  });
});

describe("sprint 13E fix round 1, R2: import and read are one outcome per email", () => {
  async function importCtx(app: Awaited<ReturnType<typeof connected>>["app"], gmail: GoogleServices["gmail"]) {
    return {
      ...app,
      google: { ...app.google, gmail },
      actions: new CaseActions(app.store, app),
      by: { actor: "agent" as const },
      userText: "Import them.",
      sentAt: CLOCK(),
      zone: app.kase.timeZone(),
      today: "2026-11-05",
      messageIdFor: () => "x",
      turn: { paste: false, imported: [], gmailImported: [], gmailFound: [], gmailRefused: [] as string[] },
    };
  }

  it("an email added whose read fails is reported added and not read, the activity agrees, and an unexpected error is one email's result", async () => {
    const { app, fake } = await connected();
    // The read of this one is refused after the email was added.
    email(fake, { id: "19a0nr", at: FIRST.at, date: FIRST.date }, "Your visit on Friday, November 13 at 9:15 AM is set.");
    const extract = app.intake.extract.bind(app.intake);
    vi.spyOn(app.intake, "extract").mockImplementation((id, o) => (id === "gmail-19a0nr" ? Promise.reject(new OutOfScopeError()) : extract(id, o)));
    const real = app.google.gmail;
    const gmail = { get: async (id: string) => (id === "19a0bx" ? Promise.reject(new Error("unexpected")) : real.get(id)) } as unknown as GoogleServices["gmail"];
    const ctx = await importCtx(app, gmail);
    const run = googleToolByName("gmail_import")!;
    const r = await run.run(ctx as never, run.input.parse({ message_ids: ["19a0nr", "19a0bx", FIRST.id] }));
    const out = r.output as { results: Array<Record<string, unknown>>; imported: number; imported_not_read: number; refused: number };
    expect([r.ok, r.code]).toEqual([true, "partial"]);
    expect(out.results.map((x) => [x.message_id, x.status ?? null, x.extraction ?? null, x.not_read ?? x.error ?? null])).toEqual([
      ["19a0nr", "imported", "imported", "out_of_scope"],
      ["19a0bx", null, null, "server_error"],
      [FIRST.id, "imported", "claims_pending", null],
    ]);
    expect([out.imported, out.imported_not_read, out.refused]).toEqual([1, 1, 1]);
    expect(String(out.results[0]!.note)).toContain("it was not read because it reads as clinical content");
    // The activity says what the output says: two emails added.
    const entries = ctx.actions.activity().entries.filter((e) => e.kind === "gmail_message_imported");
    expect(entries.map((e) => e.target?.id).sort()).toEqual(["gmail-19a001", "gmail-19a0nr"]);
    expect(ctx.turn.gmailRefused).toEqual([]);
    // Its card is there, unread, so the person can read it again.
    expect(r.cards).toContainEqual({ kind: "claims", messageId: "gmail-19a0nr", evidenceIds: [] });
  });

  it("an error that ends the turn still ends it", async () => {
    const { app } = await connected();
    const gmail = { get: async () => Promise.reject(new BudgetError()) } as unknown as GoogleServices["gmail"];
    const run = googleToolByName("gmail_import")!;
    await expect(run.run((await importCtx(app, gmail)) as never, run.input.parse({ message_ids: [FIRST.id] }))).rejects.toBeInstanceOf(BudgetError);
  });
});

describe("sprint 13E fix round 1, R4: one offer per email across turns", () => {
  it("a later search does not offer an email an earlier answer still offers, and after Undo of its import none is offered twice", async () => {
    const { app } = await connected();
    await offerSecond(app);
    const again = sequence(SEARCH(), reply(message("Nothing new.")));
    const r = await say(agentFor(app, again), app, "Check my Gmail again.");
    expect(waiting(r.report.cards)).toEqual([]);
    expect(gmailOffers(app.store).map((o) => o.gmail_id)).toEqual([SECOND.id]);
  });
});

describe("sprint 13E fix round 1, R5: only the tool says it chose not to act", () => {
  it("the paste rule's refusal is declined, and gmail_import's waits_for_person for an unread email is not", async () => {
    const { app } = await connected();
    // In the case and never read, from an earlier step.
    await addGmailMessage(new CaseActions(app.store, app), app.intake, app.google.gmail, YOU, SECOND.id);
    const paste = sequence(
      reply(fnCall("calendar_sync_slot", { slot_key: "2026-11-12T10:30", restore_removed: null })),
      reply(fnCall("gmail_import", { message_ids: [SECOND.id] })),
      reply(message("Both wait for your next message.")),
    );
    const r = await say(agentFor(app, paste), app, "Use the clinic email.\nAlso add it to my calendar.");
    expect(r.report.tools).toEqual([
      { tool: "calendar_sync_slot", ok: false, code: "waits_for_person" },
      { tool: "gmail_import", ok: false, code: "waits_for_person" },
    ]);
    const finished = r.of("tool.finished");
    expect(finished[0]).toMatchObject({ ok: false, declined: true });
    expect(finished[1]).not.toHaveProperty("declined");
  });
});

describe("sprint 13E fix round 2, F2: the paste import gives no sender line", () => {
  it("import_message returns the office as the page names it and the address domain, never the address or the sender line", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    const m1 = fixtureMessage("m1");
    const from = "lantern hill <front@lanternhill.example>";
    const model = sequence(reply(fnCall("import_message", { text: m1.text, channel: "sms", from, received_at: null })), reply(message("Imported.")));
    const r = await say(agentFor(app, model), app, `From: ${from}\n\n${m1.text}`);
    expect(r.report.tools).toEqual([{ tool: "import_message", ok: true, code: "ok" }]);
    // The sender was kept, as the person's paste named it.
    expect(app.intake.message("m1").message.from).toBe(from);
    const out = turnOutputs(model.calls[1]!.body.input).find((o) => o.name === "import_message")!.output;
    expect(out.source).not.toHaveProperty("from");
    // The name the page shows for a pasted sender is the paste's own name.
    expect(out.source).toMatchObject({ office: { untrusted_text: "lantern hill" }, sender_domain: "lanternhill.example" });
    expect(JSON.stringify(out)).not.toMatch(/front@|<front/);
  });
});
