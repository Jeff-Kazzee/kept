// Sprint 19 (0021): the hosted site's shared demo Gmail and Calendar. One
// made-up person's Google, connected by the admin command, that every
// account without its own Google connection uses, with each account's
// calendar events marked, isolated, capped and swept. Offline, with the
// fake Google endpoints.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAdminAsync } from "../scripts/admin.ts";
import { createWorkspace, DEMO_CONNECT_REFUSED } from "../server/workspace.ts";
import { DEMO_CONNECTED_TEXT } from "../server/hosted.ts";
import { CaseActions } from "../src/actions/service.ts";
import { AGENT_INSTRUCTIONS } from "../src/agent/agent.ts";
import { DELETE_CONFIRMATION } from "../src/case/constants.ts";
import { APP_PROPERTY, OWNER_PROPERTY, eventIdFor } from "../src/google/calendar.ts";
import { DEMO_GOOGLE_INSTRUCTION, DemoGoogle, MAX_EVENT_AGE_MS, MAX_LIVE_EVENTS, WRITE_LIMIT, ownerTag } from "../src/google/demo.ts";
import { GOOGLE_ERROR_TEXT, GoogleError } from "../src/google/http.ts";
import { recordGmailOffers } from "../src/google/offers.ts";
import { googleToolByName, undoGoogleActivity } from "../src/google/tools.ts";
import { ConfigError, readHostedConfig } from "../src/hosted/config.ts";
import { AccountsStore } from "../src/hosted/store.ts";
import type { SlotView } from "../src/slots/types.ts";
import { FAKE_CLIENT, FakeGoogle, gmailMessage, syncThroughActions, type FakeEvent } from "./google-fake.ts";
import { fakeMeta, sseEvents, startHosted, type Hosted } from "./hosted-helpers.ts";

const dirs: string[] = [];
let hosted: Hosted | null = null;
afterEach(async () => {
  await hosted?.close();
  hosted = null;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const REDIRECT = "https://site.example:10000/auth/google/callback";
const ACCOUNT_A = `a${"1".repeat(32)}`;
const ACCOUNT_B = `a${"2".repeat(32)}`;
const DEMO_SUB = "1000001";
const ZONE = "America/Denver";

const slot = (date: string, time = "10:30"): SlotView => ({ key: `${date}T${time}`, date, time, state: "requested", location: null }) as unknown as SlotView;

function tmp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// The demo connection on a fake Google, connected unless told not to.
async function demoSetup(options: { connect?: boolean } = {}) {
  const dir = tmp("sprint19-");
  const fake = new FakeGoogle();
  const demo = new DemoGoogle({ client: FAKE_CLIENT, file: path.join(dir, "hosted", "demo-google.sqlite"), fetch: fake.fetch, now: () => fake.now });
  const connect = async (expectEmail = "dana.demo@example.com") => {
    const { authorizeUrl } = demo.startConnect({ redirectUri: REDIRECT, expectEmail });
    const back = fake.consent(authorizeUrl);
    await demo.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null });
    return back;
  };
  if (options.connect !== false) await connect();
  const workspaces: Array<ReturnType<typeof createWorkspace>> = [];
  const workspace = (accountId: string, ownConnect = false) => {
    const wdir = path.join(dir, "accounts", accountId);
    const ws = createWorkspace({
      dbPath: path.join(wdir, "app.sqlite"),
      secretsPath: path.join(wdir, "app-secrets.sqlite"),
      port: 5310,
      extraHosts: [],
      googleClient: FAKE_CLIENT,
      googleFetch: fake.fetch,
      serverMetaKey: null,
      demoGoogle: { demo, accountId, ownConnect },
      log: () => {},
    });
    workspaces.push(ws);
    return ws;
  };
  const close = () => {
    for (const ws of workspaces) ws.close();
    demo.close();
  };
  return { dir, fake, demo, connect, workspace, close };
}

const primary = (fake: FakeGoogle) => [...fake.calendars.get("primary")!.values()];
const props = (e: FakeEvent): Record<string, string> => (e.extendedProperties as { private?: Record<string, string> } | undefined)?.private ?? {};

function toolCtx(ws: ReturnType<typeof createWorkspace>) {
  return {
    ...ws.services,
    store: ws.store,
    actions: new CaseActions(ws.store, ws.services),
    by: { actor: "agent" as const },
    userText: "Check my Gmail.",
    sentAt: "2026-11-06T17:00:00.000Z",
    zone: ZONE,
    today: "2026-11-06",
    messageIdFor: () => "x",
    turn: { paste: false, imported: [], gmailImported: [], gmailFound: [], gmailRefused: [] },
  };
}

describe("sprint 19, D2: connecting the shared demo connection", () => {
  it("the state works once, within an hour, and a wrong state is not the demo's", async () => {
    const s = await demoSetup({ connect: false });
    try {
      const { authorizeUrl } = s.demo.startConnect({ redirectUri: REDIRECT, expectEmail: "dana.demo@example.com" });
      const u = new URL(authorizeUrl);
      // PKCE, offline access and the existing scopes.
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("access_type")).toBe("offline");
      expect(u.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events");
      expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
      const back = s.fake.consent(authorizeUrl);
      const state = back.searchParams.get("state");
      expect(s.demo.ownsState("not-the-state")).toBe(false);
      expect(s.demo.ownsState(null)).toBe(false);
      await expect(s.demo.finishConnect({ state: "not-the-state", code: back.searchParams.get("code"), error: null })).rejects.toMatchObject({ code: "invalid_state" });
      // The wrong state used nothing up.
      expect(s.demo.ownsState(state)).toBe(true);
      await s.demo.finishConnect({ state, code: back.searchParams.get("code"), error: null });
      expect(s.demo.status()).toMatchObject({ connected: true, email: "dana.demo@example.com", pendingUntil: null });
      // Single use.
      expect(s.demo.ownsState(state)).toBe(false);
      await expect(s.demo.finishConnect({ state, code: back.searchParams.get("code"), error: null })).rejects.toMatchObject({ code: "invalid_state" });

      // Expiry: a link older than an hour is refused.
      const late = s.demo.startConnect({ redirectUri: REDIRECT, expectEmail: "dana.demo@example.com" });
      const lateBack = s.fake.consent(late.authorizeUrl);
      s.fake.now += 59 * 60_000;
      expect(s.demo.ownsState(lateBack.searchParams.get("state"))).toBe(true);
      s.fake.now += 60_000 + 1;
      expect(s.demo.ownsState(lateBack.searchParams.get("state"))).toBe(false);
      await expect(s.demo.finishConnect({ state: lateBack.searchParams.get("state"), code: lateBack.searchParams.get("code"), error: null })).rejects.toMatchObject({ code: "invalid_state" });
      // The status says when Google ends the 7-day consent.
      const st = s.demo.status();
      expect(Date.parse(st.expiresAt!) - Date.parse(st.connectedAt!)).toBe(7 * 86_400_000);
    } finally {
      s.close();
    }
  });

  it("renews in place, refuses another account with --email, and disconnect revokes and deletes", async () => {
    const s = await demoSetup();
    try {
      const firstAt = s.demo.status().connectedAt!;
      s.fake.now += 3 * 86_400_000;
      await s.connect("dana.demo@example.com");
      expect(Date.parse(s.demo.status().connectedAt!)).toBeGreaterThan(Date.parse(firstAt));
      s.fake.account = { sub: "9000009", email: "someone.else@example.com" };
      await expect(s.connect("dana.demo@example.com")).rejects.toMatchObject({ code: "wrong_account" });
      // The other account's grant was revoked, and Dana's stays.
      expect(s.demo.status()).toMatchObject({ connected: true, email: "dana.demo@example.com" });
      const before = s.fake.revoked.length;
      expect(await s.demo.disconnect()).toEqual({ had: true, revoked: true });
      expect(s.fake.revoked.length).toBe(before + 1);
      expect(s.demo.status()).toMatchObject({ connected: false, email: null });
      // Mode 600, beside the accounts database.
      expect(statSync(path.join(s.dir, "hosted", "demo-google.sqlite")).mode & 0o777).toBe(0o600);
    } finally {
      s.close();
    }
  });
});

describe("sprint 19, D3 and D4: Gmail through the shared connection", () => {
  it("both accounts search the demo inbox, and one account's offers are never the other's", async () => {
    const s = await demoSetup();
    try {
      s.fake.messages.set("19c001", gmailMessage("19c001", { from: "Front Desk <front@lanternhill.example>", subject: "Your appointment", internalDate: String(Date.parse("2026-11-04T16:00:00Z")), plain: "This confirms your appointment on Thursday, November 12 at 10:30 AM." }));
      const a = s.workspace(ACCOUNT_A);
      const b = s.workspace(ACCOUNT_B);
      const search = googleToolByName("gmail_search")!;
      for (const ws of [a, b]) {
        const r = await search.run(toolCtx(ws) as never, search.input.parse({ days: null, senders: null }));
        expect(r.ok).toBe(true);
        expect((r.output as { messages: Array<{ message_id: string }> }).messages.map((m) => m.message_id)).toEqual(["19c001"]);
      }
      // Keyed by the shared connection, never as an own connection.
      expect(a.googleConnection.gmailAccount()).toBeNull();
      expect(a.services.google.connection.gmailAccount()).toBe(`shared:${DEMO_SUB}`);
      // A's turn offered the email. B cannot add it from A's offer.
      recordGmailOffers(a.store, [{ gmail_id: "19c001", account: a.services.google.connection.gmailAccount()!, generation: a.kase.generation() }]);
      const add = (ws: typeof a) => ws.api({ method: "POST", path: "/api/gmail/19c001/add", body: {}, generation: ws.kase.generation() });
      const refused = await add(b);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(b.services.intake.messages()).toEqual([]);
      const added = await add(a);
      expect(added.status).toBe(200);
      expect(a.services.intake.messages().map((m) => m.id)).toEqual(["gmail-19c001"]);
      expect(b.services.intake.messages()).toEqual([]);
      // Gmail stays read-only: only GETs reached Gmail.
      expect(s.fake.calls.filter((c) => c.url.origin === "https://gmail.googleapis.com").every((c) => c.method === "GET")).toBe(true);
    } finally {
      s.close();
    }
  });

  it("an account's own connection comes first", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A, true);
      expect(a.services.google.connection.calendar().key).toBe(`shared:${DEMO_SUB}|primary`);
      // A test user connects their own Google.
      s.fake.account = { sub: "3000003", email: "test.user@example.com" };
      const route = (p: string, body: unknown) => a.googleRoutes.api({ method: "POST", path: p, body, generation: a.kase.generation(), host: "127.0.0.1:5310", secure: false });
      const started = await route("/api/google/connect", { expectedVersion: a.googleConnection.status().version });
      expect(started.status).toBe(200);
      const back = s.fake.consent((started.body as { authorizeUrl: string }).authorizeUrl);
      expect((await a.googleRoutes.callback(back, started.setCookie!.split(";")[0]!)).location).toBe("/?connected=google");
      const link = a.services.google.connection;
      expect(link.gmailAccount()).toBe("3000003");
      expect(link.calendar().key).toBe("3000003|primary");
      expect((await a.googleRoutes.api({ method: "GET", path: "/api/google", body: undefined, host: undefined, secure: false })).body).not.toHaveProperty("demo");
      // Its events carry no account mark: they are in its own calendar.
      await syncThroughActions(new CaseActions(a.store, a.services), a.services.google.calendar, "2026-11-12T10:30", slot("2026-11-12"));
      const mine = primary(s.fake).filter((e) => props(e)[APP_PROPERTY] === "1");
      expect(mine).toHaveLength(1);
      expect(props(mine[0]!)).not.toHaveProperty(OWNER_PROPERTY);
      expect(props(mine[0]!)).toMatchObject({ apptAccount: "3000003" });
    } finally {
      s.close();
    }
  });
});

describe("sprint 19, D5 and D6: the shared calendar", () => {
  it("two accounts writing the same slot get their own marked events, and see only their own", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      const b = s.workspace(ACCOUNT_B);
      // The demo person's own event, and an event the local demo wrote.
      s.fake.addForeignEvent("primary", { summary: "Work call", start: { dateTime: "2026-11-12T09:00:00-07:00" }, end: { dateTime: "2026-11-12T11:00:00-07:00" } });
      s.fake.addForeignEvent("primary", {
        summary: "Local demo appointment",
        start: { dateTime: "2026-11-12T13:00:00-07:00" },
        end: { dateTime: "2026-11-12T14:00:00-07:00" },
        extendedProperties: { private: { [APP_PROPERTY]: "1", apptSlotKey: "2026-11-12T13:00", apptAccount: DEMO_SUB } },
      });
      const key = "2026-11-12T10:30";
      const outA = await syncThroughActions(new CaseActions(a.store, a.services), a.services.google.calendar, key, slot("2026-11-12"));
      const outB = await syncThroughActions(new CaseActions(b.store, b.services), b.services.google.calendar, key, slot("2026-11-12"));
      expect(outA.action).toBe("created");
      expect(outB.action).toBe("created");
      expect(outA.eventId).not.toBe(outB.eventId);
      expect(outA.eventId).toBe(eventIdFor(DEMO_SUB, "primary", key, null, ownerTag(ACCOUNT_A)));
      const app = primary(s.fake).filter((e) => props(e)?.[OWNER_PROPERTY]);
      expect(app.map((e) => props(e)[OWNER_PROPERTY]).sort()).toEqual([ownerTag(ACCOUNT_A), ownerTag(ACCOUNT_B)].sort());
      // The calendar read and the clash checks of each account.
      for (const [ws, own] of [
        [a, outA.eventId],
        [b, outB.eventId],
      ] as const) {
        const seen = await ws.services.google.calendar.list({ from: "2026-11-12", to: "2026-11-12" });
        expect(seen.map((e) => [e.summary, e.slotKey])).toEqual([
          ["Work call", null],
          [expect.stringContaining("requested"), key],
        ]);
        expect(seen.find((e) => e.slotKey)!.id).toBe(own);
        await ws.services.google.events!.refresh(["2026-11-12"], "2026-11-06");
        expect(ws.services.google.events!.snapshot()!.events.map((e) => e.summary)).toEqual(["Work call"]);
      }
      // The tool says the same.
      const list = googleToolByName("calendar_list")!;
      const r = await list.run(toolCtx(a) as never, list.input.parse({ from: "2026-11-12", to: "2026-11-12" }));
      expect((r.output as { events: Array<{ added_by_app: boolean }> }).events.map((e) => e.added_by_app)).toEqual([false, true]);

      // Undo removes only the account's own event.
      expect((await undoGoogleActivity({ google: a.services.google }, outA.undo!)).ok).toBe(true);
      const live = () => primary(s.fake).filter((e) => e.status !== "cancelled" && props(e)?.[OWNER_PROPERTY]);
      expect(live().map((e) => props(e)[OWNER_PROPERTY])).toEqual([ownerTag(ACCOUNT_B)]);
      // B's undo record names an event A cannot touch.
      const foreign = await undoGoogleActivity({ google: a.services.google }, outB.undo!);
      expect(foreign).toMatchObject({ ok: false, code: "google_not_app_event" });
      expect(live()).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it("Delete case and Delete account remove only that account's events", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      const b = s.workspace(ACCOUNT_B);
      for (const ws of [a, b]) for (const d of ["2026-11-12", "2026-11-13"]) await syncThroughActions(new CaseActions(ws.store, ws.services), ws.services.google.calendar, `${d}T10:30`, slot(d));
      const local = s.fake.addForeignEvent("primary", { summary: "Local", start: { dateTime: "2026-11-12T13:00:00-07:00" }, extendedProperties: { private: { [APP_PROPERTY]: "1", apptSlotKey: "x", apptAccount: DEMO_SUB } } });
      const del = await a.api({ method: "POST", path: "/api/case/delete", body: { expectedVersion: a.kase.caseVersion(), confirmation: DELETE_CONFIRMATION }, generation: a.kase.generation() });
      expect(del.status).toBe(200);
      const live = () => primary(s.fake).filter((e) => e.status !== "cancelled");
      expect(live().filter((e) => props(e)?.[OWNER_PROPERTY]).map((e) => props(e)[OWNER_PROPERTY])).toEqual([ownerTag(ACCOUNT_B), ownerTag(ACCOUNT_B)]);
      expect(local.status).toBe("confirmed");
      // Delete account's step (hosted.ts removeAccount).
      expect(await s.demo.forget(ACCOUNT_B)).toEqual({ removed: 2, pending: false });
      expect(live().filter((e) => props(e)?.[OWNER_PROPERTY])).toEqual([]);
      expect(local.status).toBe("confirmed");
    } finally {
      s.close();
    }
  });

  it("refuses an account's sixth live event with a clear sentence, and limits its rate of writes", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      const b = s.workspace(ACCOUNT_B);
      const days = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
      const write = (ws: typeof a, d: string) => syncThroughActions(new CaseActions(ws.store, ws.services), ws.services.google.calendar, `${d}T10:30`, slot(d));
      for (const d of days.slice(0, MAX_LIVE_EVENTS)) expect((await write(a, d)).action).toBe("created");
      const sixth = await write(a, days[5]!).catch((e: unknown) => e);
      expect(sixth).toBeInstanceOf(GoogleError);
      expect((sixth as GoogleError).code).toBe("google_demo_limit");
      expect((sixth as GoogleError).message).toBe(GOOGLE_ERROR_TEXT.google_demo_limit);
      expect(primary(s.fake).filter((e) => props(e)?.[OWNER_PROPERTY] === ownerTag(ACCOUNT_A))).toHaveLength(MAX_LIVE_EVENTS);
      // Another account is not held back by A's events.
      expect((await write(b, days[5]!)).action).toBe("created");
      // The rate limit: creates and updates per account in a window.
      const shared = s.demo.sharedCalendar(`a${"3".repeat(32)}`);
      for (let i = 0; i < WRITE_LIMIT.limit; i++) expect(shared.takeWrite()).toBe(true);
      expect(shared.takeWrite()).toBe(false);
      expect(s.demo.sharedCalendar(`a${"4".repeat(32)}`).takeWrite()).toBe(true);
    } finally {
      s.close();
    }
  });

  it("the sweep removes closed accounts' events, old ones and those a Delete left, and never the local demo's", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      const b = s.workspace(ACCOUNT_B);
      const write = (ws: typeof a, d: string) => syncThroughActions(new CaseActions(ws.store, ws.services), ws.services.google.calendar, `${d}T10:30`, slot(d));
      await write(a, "2026-11-12");
      await write(b, "2026-11-12");
      const local = s.fake.addForeignEvent("primary", { summary: "Local", start: { dateTime: "2026-11-12T13:00:00-07:00" }, created: "2026-01-01T00:00:00Z", extendedProperties: { private: { [APP_PROPERTY]: "1", apptSlotKey: "x", apptAccount: DEMO_SUB } } });
      const owners = () => primary(s.fake).filter((e) => e.status !== "cancelled" && props(e)?.[OWNER_PROPERTY]).map((e) => props(e)[OWNER_PROPERTY]);
      // B is closed: its event goes.
      expect(await s.demo.sweep((o) => o === ownerTag(ACCOUNT_A))).toEqual({ removed: 1, failed: 0, complete: true });
      expect(owners()).toEqual([ownerTag(ACCOUNT_A)]);
      // A Delete while Google could not be reached leaves a cleanup.
      s.fake.unreachable = true;
      expect(await s.demo.forget(ACCOUNT_A)).toEqual({ removed: 0, pending: true });
      s.fake.unreachable = false;
      s.fake.now += 1000;
      await write(a, "2026-11-13");
      expect(await s.demo.sweep(() => true)).toEqual({ removed: 1, failed: 0, complete: true });
      // The event made after the Delete stays.
      expect(primary(s.fake).filter((e) => e.status !== "cancelled" && props(e)?.[OWNER_PROPERTY]).map((e) => props(e).apptSlotKey)).toEqual(["2026-11-13T10:30"]);
      // Older than 7 days goes, even for a live account.
      s.fake.now += MAX_EVENT_AGE_MS + 1;
      expect(await s.demo.sweep(() => true)).toEqual({ removed: 1, failed: 0, complete: true });
      expect(owners()).toEqual([]);
      expect(local.status).toBe("confirmed");
    } finally {
      s.close();
    }
  });

  it("expired judge codes and deleted accounts are not live", () => {
    const dir = tmp("sprint19-store-");
    let now = Date.parse("2026-11-06T17:00:00Z");
    const store = new AccountsStore(path.join(dir, "accounts.sqlite"), { now: () => now });
    try {
      const day = 86_400_000;
      const live = store.createJudgeCode({ label: "Live", capMicros: 1_000_000, expiresAt: now + 3 * day, totalCapMicros: 100_000_000 });
      const short = store.createJudgeCode({ label: "Short", capMicros: 1_000_000, expiresAt: now + day, totalCapMicros: 100_000_000 });
      const revoked = store.createJudgeCode({ label: "Revoked", capMicros: 1_000_000, expiresAt: now + 3 * day, totalCapMicros: 100_000_000 });
      const a = store.redeemJudgeCode(live.code);
      const b = store.redeemJudgeCode(short.code);
      const c = store.redeemJudgeCode(revoked.code);
      const user = store.userAccount({ userId: "user1", email: "pat@example.com", name: null });
      const gone = store.userAccount({ userId: "user2", email: "lee@example.com", name: null });
      store.revokeJudgeCode(revoked.id);
      store.deleteAccount(gone.id);
      now += 2 * day;
      expect(new Set(store.demoLiveAccounts())).toEqual(new Set([a.id, user.id]));
      expect(store.demoLiveAccounts()).not.toContain(b.id);
      expect(store.demoLiveAccounts()).not.toContain(c.id);
    } finally {
      store.close();
    }
  });
});

describe("sprint 19, D7: an expired shared connection", () => {
  it("the Google tools say the demo needs reconnecting, Connections says so, and the rest works", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      // Google ended the consent: the refresh token is dead.
      s.fake.now += 2 * 3600_000;
      s.fake.refreshFails = "invalid_grant";
      const search = googleToolByName("gmail_search")!;
      const r = await search.run(toolCtx(a) as never, search.input.parse({ days: null, senders: null }));
      expect(r).toMatchObject({ ok: false, code: "google_demo_reconnect" });
      expect((r.output as { message: string }).message).toBe(GOOGLE_ERROR_TEXT.google_demo_reconnect);
      // Once marked, without another call to Google.
      const calls = s.fake.calls.length;
      const sync = googleToolByName("calendar_sync_slot")!;
      const w = await sync.run(toolCtx(a) as never, sync.input.parse({ slot_key: "2026-11-12T10:30", restore_removed: null }));
      expect(w).toMatchObject({ ok: false, code: "google_demo_reconnect" });
      expect(s.fake.calls.length).toBe(calls);
      expect(s.demo.status()).toMatchObject({ connected: false, needsReconnect: true });
      const status = (await a.googleRoutes.api({ method: "GET", path: "/api/google", body: undefined, host: undefined, secure: false })).body as Record<string, unknown>;
      expect(status.demo).toEqual({ connected: false, ownConnect: false });
      expect(status.connected).toBe(false);
      // The rest of the app works: the demo calendar file and the case.
      expect((await a.api({ method: "GET", path: "/api/fixtures/calendar", body: undefined })).status).toBe(200);
      expect((await a.api({ method: "GET", path: "/api/state", body: undefined })).status).toBe(200);
      // A judge has no Connect.
      const connect = await a.googleRoutes.api({ method: "POST", path: "/api/google/connect", body: { expectedVersion: 0 }, generation: a.kase.generation(), host: "127.0.0.1:5310", secure: false });
      expect(connect).toMatchObject({ status: 403, body: { error: "connect_not_offered", message: DEMO_CONNECT_REFUSED } });
    } finally {
      s.close();
    }
  });
});

describe("sprint 19: the hosted site", () => {
  it("the callback finishes the demo connect with no session, an account's own connect still works, and the judge's agent is told", async () => {
    hosted = await startHosted({ env: { APP_DEMO_GOOGLE: "on" } });
    const h = hosted;
    const fake = h.google!.fake;
    expect(h.app.demo).not.toBeNull();
    expect(h.app.startLines().some((l) => l.includes("Demo Gmail and Calendar (APP_DEMO_GOOGLE): not connected yet"))).toBe(true);

    // An email account starts its own connect.
    const a = h.browser();
    await h.signUp(a);
    const ga = (await a.call("GET", "/api/google")).body;
    expect(ga.demo).toEqual({ connected: false, ownConnect: true });
    const sa = (await a.call("GET", "/api/state")).body;
    const own = await a.call("POST", "/api/google/connect", { expectedVersion: ga.version }, { "X-Case-Generation": String(sa.generation) });
    expect(own.status).toBe(200);
    const ownBack = fake.consent(own.body.authorizeUrl);

    // The admin starts the demo connect. A browser with no session finishes it.
    const { authorizeUrl } = h.app.demo!.startConnect({ redirectUri: `http://localhost:${h.port}/auth/google/callback`, expectEmail: "dana.demo@example.com" });
    fake.account = { sub: "1000001", email: "dana.demo@example.com" };
    const demoBack = fake.consent(authorizeUrl);
    const anon = h.browser();
    const page = await anon.visit(`${demoBack.pathname}${demoBack.search}`);
    expect(page.status).toBe(200);
    expect(page.text).toBe(DEMO_CONNECTED_TEXT);
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(h.app.demo!.status().connected).toBe(true);
    // Used once: the same link again is not the demo's, and with no session
    // it goes nowhere.
    expect((await anon.visit(`${demoBack.pathname}${demoBack.search}`)).headers.location).toBe("/?google_error=signed_out");

    // A's own connect finishes as before, as another Google account.
    fake.account = { sub: "3000003", email: "test.user@example.com" };
    expect((await a.visit(`${ownBack.pathname}${ownBack.search}`)).headers.location).toBe("/?connected=google");
    const after = (await a.call("GET", "/api/google")).body;
    expect(after).toMatchObject({ connected: true });
    expect(after).not.toHaveProperty("demo");

    // A judge uses the shared one: one quiet line, no address, no Connect.
    const meta = fakeMeta();
    const j = h.browser();
    const { code } = h.judgeCode("Judge Ada");
    expect((await j.call("POST", "/api/session/judge", { code })).status).toBe(200);
    const gj = (await j.call("GET", "/api/google")).body;
    expect(gj.demo).toEqual({ connected: true, ownConnect: false });
    expect(JSON.stringify(gj)).not.toContain("dana.demo@example.com");
    const sj = (await j.call("GET", "/api/state")).body;
    const turn = await j.call("POST", "/api/chat", { text: "What is on my schedule?", expectedVersion: 0 }, { "X-Case-Generation": String(sj.generation) });
    expect(sseEvents(turn.text).at(-1)!.event).toBe("turn.done");
    expect(meta.calls[0]!.body.instructions).toBe(`${AGENT_INSTRUCTIONS} ${DEMO_GOOGLE_INSTRUCTION}`);
    const refused = await j.call("POST", "/api/google/connect", { expectedVersion: gj.version }, { "X-Case-Generation": String(sj.generation) });
    expect(refused.status).toBe(403);

    // D9: no token, address or code in the log.
    const logs = h.logs.join("\n");
    expect(logs).toContain("Demo Gmail and Calendar connected.");
    expect(logs).not.toMatch(/dana\.demo@example\.com|fake-refresh|fake-access|code-\d/);
  });

  it("with APP_DEMO_GOOGLE off, hosted mode is unchanged", async () => {
    hosted = await startHosted();
    const h = hosted;
    expect(h.app.demo).toBeNull();
    expect(h.app.startLines().some((l) => l.includes("APP_DEMO_GOOGLE"))).toBe(false);
    const j = h.browser();
    const { code } = h.judgeCode("Judge Bo");
    await j.call("POST", "/api/session/judge", { code });
    const g = (await j.call("GET", "/api/google")).body;
    expect(g).toMatchObject({ connected: false, configured: true });
    expect(g).not.toHaveProperty("demo");
    expect((await j.visit("/auth/google/callback?state=whatever&code=x")).headers.location).toBe("/?google_error=invalid_state");
  });

  it("D10: local mode reads no APP_DEMO_GOOGLE, and hosted mode refuses a bad value", () => {
    expect(readHostedConfig({ APP_DEMO_GOOGLE: "on" })).toMatchObject({ mode: "local", demoGoogle: false });
    expect(readHostedConfig({ APP_MODE: "hosted", APP_DEMO_GOOGLE: "on" }).demoGoogle).toBe(true);
    expect(() => readHostedConfig({ APP_MODE: "hosted", APP_DEMO_GOOGLE: "yes" })).toThrow(ConfigError);
  });
});

describe("sprint 19: the admin commands", () => {
  it("demo-connect prints a link, demo-status shows the connection and its end, demo-disconnect revokes", async () => {
    const dir = tmp("sprint19-admin-");
    const accounts = new AccountsStore(path.join(dir, "hosted", "accounts.sqlite"));
    accounts.demoLiveAccounts();
    accounts.close();
    const fake = new FakeGoogle();
    const env = { APP_DB: path.join(dir, "app.sqlite"), GOOGLE_CLIENT_ID: FAKE_CLIENT.clientId, GOOGLE_CLIENT_SECRET: FAKE_CLIENT.clientSecret, BETTER_AUTH_URL: "https://site.example:10000", APP_DEMO_GOOGLE: "on" };
    const admin = (...argv: string[]) => runAdminAsync(["google", ...argv], env, () => fake.now, { fetch: fake.fetch });

    expect((await admin("demo-status")).out).toEqual(["Demo Gmail and Calendar: not connected. Run pnpm admin google demo-connect."]);
    const started = await admin("demo-connect", "--email", "dana.demo@example.com");
    expect(started.code).toBe(0);
    const link = started.out.find((l) => l.startsWith("https://accounts.google.com/"))!;
    expect(new URL(link).searchParams.get("redirect_uri")).toBe("https://site.example:10000/auth/google/callback");
    expect((await admin("demo-status")).out.at(-1)).toMatch(/^A demo-connect link is waiting until /);

    // The site finishes it, from the same file.
    const demo = new DemoGoogle({ client: FAKE_CLIENT, file: path.join(dir, "hosted", "demo-google.sqlite"), fetch: fake.fetch, now: () => fake.now });
    const back = fake.consent(link);
    await demo.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null });
    demo.close();
    const status = await admin("demo-status");
    expect(status.out[0]).toBe("Demo Gmail and Calendar: connected, as dana.demo@example.com.");
    expect(status.out[1]).toBe("Granted: Gmail yes, Calendar yes.");
    expect(status.out[2]).toBe("Connected 2026-11-06 17:00 UTC. Google ends this consent 2026-11-13 17:00 UTC (7 days, testing mode): run demo-connect again before then.");
    expect(status.out.join("\n")).not.toMatch(/fake-refresh|fake-access/);

    expect((await admin("demo-disconnect")).out).toEqual(["Revoked the demo connection at Google and deleted it here."]);
    expect((await admin("demo-status")).out[0]).toBe("Demo Gmail and Calendar: not connected. Run pnpm admin google demo-connect.");

    // A wrong data folder or a missing client refuses.
    expect((await runAdminAsync(["google", "demo-status"], { ...env, APP_DB: path.join(dir, "nowhere", "app.sqlite") })).code).toBe(2);
    expect((await runAdminAsync(["google", "demo-connect"], { ...env, GOOGLE_CLIENT_ID: "" })).code).toBe(2);
  });
});
