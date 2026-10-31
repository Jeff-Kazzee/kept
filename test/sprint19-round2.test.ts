// Sprint 19 round 2: the sprint 19 round 1 review (0021) and sprint 18's
// round 2 lows (0020), through the real paths, and the hosted held live
// read and first read after the merge with sprint 17 (0019). Offline, with
// the fake Google and Meta endpoints.
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAdminAsync } from "../scripts/admin.ts";
import { LIVE_PATH } from "../server/live.ts";
import { requestLogger } from "../server/request-log.ts";
import { createWorkspace } from "../server/workspace.ts";
import { CaseActions, YOU } from "../src/actions/service.ts";
import { DELETE_CONFIRMATION } from "../src/case/constants.ts";
import { APP_PROPERTY, OWNER_PROPERTY } from "../src/google/calendar.ts";
import { DemoGoogle, GLOBAL_CALL_LIMIT, MAX_LIVE_EVENTS, REFRESH_LIMIT, SWEEP_MAX_PAGES, WRITE_LIMIT, ownerTag } from "../src/google/demo.ts";
import { GMAIL_API } from "../src/google/gmail.ts";
import { GOOGLE_ERROR_TEXT } from "../src/google/http.ts";
import { googleToolByName, undoGoogleActivity } from "../src/google/tools.ts";
import { AccountsStore } from "../src/hosted/store.ts";
import { CALENDAR_UNREADABLE } from "../src/agent/tools.ts";
import { FAKE_CLIENT, FakeGoogle, gmailMessage, type FakeEvent } from "./google-fake.ts";
import { startHosted, type Hosted } from "./hosted-helpers.ts";

const dirs: string[] = [];
let hosted: Hosted | null = null;
afterEach(async () => {
  vi.unstubAllGlobals();
  await hosted?.close();
  hosted = null;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const DANA = "dana.demo@example.com";
const REDIRECT = "https://site.example:10000/auth/google/callback";
const ACCOUNT_A = `a${"1".repeat(32)}`;
const ACCOUNT_B = `a${"2".repeat(32)}`;
const ZONE = "America/Denver";

function tmp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function demoSetup(options: { connect?: boolean } = {}) {
  const dir = tmp("sprint19r2-");
  const fake = new FakeGoogle();
  const demo = new DemoGoogle({ client: FAKE_CLIENT, file: path.join(dir, "hosted", "demo-google.sqlite"), fetch: fake.fetch, now: () => fake.now });
  const consent = (grant?: { only?: string[] }) => {
    const { authorizeUrl } = demo.startConnect({ redirectUri: REDIRECT, expectEmail: DANA });
    if (grant?.only) fake.grantOnly = grant.only;
    const back = fake.consent(authorizeUrl);
    fake.grantOnly = null;
    return back;
  };
  const connect = async (grant?: { only?: string[] }) => {
    const back = consent(grant);
    await demo.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null });
  };
  if (options.connect !== false) await connect();
  const open: Array<ReturnType<typeof createWorkspace>> = [];
  const workspace = (accountId: string) => {
    const wdir = path.join(dir, "accounts", accountId);
    const ws = createWorkspace({
      dbPath: path.join(wdir, "app.sqlite"),
      secretsPath: path.join(wdir, "app-secrets.sqlite"),
      port: 5311,
      extraHosts: [],
      googleClient: FAKE_CLIENT,
      googleFetch: fake.fetch,
      serverMetaKey: null,
      demoGoogle: { demo, accountId, ownConnect: false },
      log: () => {},
    });
    open.push(ws);
    return ws;
  };
  const close = () => {
    for (const ws of open) ws.close();
    demo.close();
  };
  return { dir, fake, demo, consent, connect, workspace, close };
}

type Ws = ReturnType<typeof createWorkspace>;

// Appointments the person confirmed, entered by hand, so the case has real
// slots for the calendar tools with no model call.
function addSlots(ws: Ws, dates: string[]) {
  const actions = new CaseActions(ws.store, ws.services);
  for (const [i, date] of dates.entries()) {
    const m = actions.importMessage(YOU, { id: `pasted-${date}-${i}`, channel: "email", from: "Front Desk <front@clinic.example>", received_at: "2026-11-05T16:00:00Z", text: "Your visit is confirmed." });
    const e = actions.enterManually(YOU, m.id, ws.services.intake.message(m.id).version, { claim_type: "confirm", date, time: "10:30", location: null, quote: null, request_item: null });
    ws.services.intake.accept(e.id, e.version);
  }
}

function toolCtx(ws: Ws) {
  return {
    ...ws.services,
    store: ws.store,
    actions: new CaseActions(ws.store, ws.services),
    by: { actor: "agent" as const },
    userText: "Put them on my calendar.",
    sentAt: "2026-11-06T17:00:00.000Z",
    zone: ZONE,
    today: "2026-11-06",
    messageIdFor: () => "x",
    turn: { paste: false, imported: [], gmailImported: [], gmailFound: [], gmailRefused: [] },
  };
}

const run = (ws: Ws, name: string, input: unknown) => {
  const tool = googleToolByName(name)!;
  return tool.run(toolCtx(ws) as never, tool.input.parse(input));
};

const props = (e: FakeEvent): Record<string, string> => (e.extendedProperties as { private?: Record<string, string> } | undefined)?.private ?? {};
const liveOwned = (fake: FakeGoogle, owner: string) => [...fake.calendars.get("primary")!.values()].filter((e) => e.status !== "cancelled" && props(e)[OWNER_PROPERTY] === owner);

describe("0021 round 2, finding 1: only the demo account can take the shared connection", () => {
  it("refuses another account or another Google id, and never revokes the demo account's grant", async () => {
    const s = await demoSetup();
    try {
      const danaGrants = () => [...s.fake.grants.values()].filter((g) => !g.revoked).length;
      expect(danaGrants()).toBe(1);
      // Another account, at the right email check.
      s.fake.account = { sub: "9000009", email: "someone@example.com" };
      const back = s.consent();
      await expect(s.demo.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null })).rejects.toMatchObject({ code: "wrong_account" });
      // Another Google id with Dana's address (a recreated account) is not
      // the stored one.
      s.fake.account = { sub: "9000010", email: DANA };
      const again = s.consent();
      await expect(s.demo.finishConnect({ state: again.searchParams.get("state"), code: again.searchParams.get("code"), error: null })).rejects.toMatchObject({ code: "wrong_account" });
      expect(s.demo.status()).toMatchObject({ connected: true, email: DANA });
      expect(s.demo.connection.storedAccount()).toBe("1000001");
      // Dana's grant still stands. The two refused ones were revoked.
      expect(danaGrants()).toBe(1);
      // After demo-disconnect another Google id may connect.
      await s.demo.disconnect();
      await s.connect();
      expect(s.demo.connection.storedAccount()).toBe("9000010");
      // startConnect needs the email.
      expect(() => s.demo.startConnect({ redirectUri: REDIRECT, expectEmail: "" })).toThrow();
    } finally {
      s.close();
    }
  });

  it("the admin command needs --email, and refuses another address while one is connected", async () => {
    const dir = tmp("sprint19r2-admin-");
    const accounts = new AccountsStore(path.join(dir, "hosted", "accounts.sqlite"));
    accounts.demoLiveAccounts();
    accounts.close();
    const fake = new FakeGoogle();
    const env = { APP_DB: path.join(dir, "app.sqlite"), GOOGLE_CLIENT_ID: FAKE_CLIENT.clientId, GOOGLE_CLIENT_SECRET: FAKE_CLIENT.clientSecret, BETTER_AUTH_URL: "https://site.example:10000", APP_DEMO_GOOGLE: "on" };
    const admin = (...argv: string[]) => runAdminAsync(["google", ...argv], env, () => fake.now, { fetch: fake.fetch });
    const bare = await admin("demo-connect");
    expect(bare.code).toBe(2);
    expect(bare.err.join("\n")).toContain("demo-connect needs --email");
    const started = await admin("demo-connect", "--email", DANA);
    const link = started.out.find((l) => l.startsWith("https://accounts.google.com/"))!;
    const demo = new DemoGoogle({ client: FAKE_CLIENT, file: path.join(dir, "hosted", "demo-google.sqlite"), fetch: fake.fetch, now: () => fake.now });
    const back = fake.consent(link);
    await demo.finishConnect({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null });
    demo.close();
    const other = await admin("demo-connect", "--email", "someone@example.com");
    expect(other.code).toBe(2);
    expect(other.err.join("\n")).toContain("demo-disconnect first");
    // The backup copies the demo connection, and says it is a secret.
    const backup = await runAdminAsync(["backup", "--to", path.join(dir, "backup")], env);
    expect(backup.code).toBe(0);
    expect(existsSync(path.join(dir, "backup", "demo-google.sqlite"))).toBe(true);
    expect(backup.out.join("\n")).toContain("a secret");
  });

  it("through the site: a signed-in judge finishing the link as another account is refused, and failed tries are limited per address", async () => {
    hosted = await startHosted({ env: { APP_DEMO_GOOGLE: "on" } });
    const h = hosted;
    const fake = h.google!.fake;
    const redirectUri = `http://localhost:${h.port}/auth/google/callback`;
    // Dana is connected.
    const first = fake.consent(h.app.demo!.startConnect({ redirectUri, expectEmail: DANA }).authorizeUrl);
    expect((await h.browser().visit(`${first.pathname}${first.search}`)).status).toBe(200);
    const judge = h.browser();
    expect((await judge.call("POST", "/api/session/judge", { code: h.judgeCode().code })).status).toBe(200);
    // The judge got the link and consents as themself.
    fake.account = { sub: "7000007", email: "judge.person@example.com" };
    const back = fake.consent(h.app.demo!.startConnect({ redirectUri, expectEmail: DANA }).authorizeUrl);
    const page = await judge.visit(`${back.pathname}${back.search}`);
    expect(page.status).toBe(400);
    expect(page.text).toContain("wrong_account");
    expect(h.app.demo!.status()).toMatchObject({ connected: true, email: DANA });
    // Five failures from one address, then the sixth link is refused
    // without being used.
    for (let i = 0; i < 4; i++) {
      const b = fake.consent(h.app.demo!.startConnect({ redirectUri, expectEmail: DANA }).authorizeUrl);
      expect((await judge.visit(`${b.pathname}${b.search}`)).status).toBe(400);
    }
    const sixth = fake.consent(h.app.demo!.startConnect({ redirectUri, expectEmail: DANA }).authorizeUrl);
    expect((await judge.visit(`${sixth.pathname}${sixth.search}`)).status).toBe(429);
    expect(h.app.demo!.ownsState(sixth.searchParams.get("state"))).toBe(true);
    expect(h.logs.join("\n")).not.toContain("judge.person@example.com");
  });
});

describe("0021 round 2, finding 2: one budget and one calendar cache for the shared connection", () => {
  it("the shared budget refuses Gmail and calendar calls of every account with the plain sentence", async () => {
    const s = await demoSetup();
    try {
      s.fake.messages.set("19d001", gmailMessage("19d001", { from: "Front <front@clinic.example>", subject: "Appointment", internalDate: String(Date.parse("2026-11-04T16:00:00Z")), plain: "Your appointment is confirmed." }));
      const a = s.workspace(ACCOUNT_A);
      const b = s.workspace(ACCOUNT_B);
      expect((await run(a, "gmail_search", { days: null, senders: null })).ok).toBe(true);
      while (s.demo.takeCall());
      const calls = s.fake.calls.length;
      for (const ws of [a, b]) {
        const r = await run(ws, "gmail_search", { days: null, senders: null });
        expect(r).toMatchObject({ ok: false, code: "google_demo_rate_limited" });
        expect((r.output as { message: string }).message).toBe(GOOGLE_ERROR_TEXT.google_demo_rate_limited);
      }
      expect((await run(b, "calendar_list", { from: "2026-11-12", to: "2026-11-12" })).code).toBe("google_demo_rate_limited");
      expect(s.fake.calls.length).toBe(calls);
      expect(GLOBAL_CALL_LIMIT.limit).toBeGreaterThan(0);
    } finally {
      s.close();
    }
  });

  it("the refresh route is limited for all shared accounts together, and a window is read once for all of them", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      const b = s.workspace(ACCOUNT_B);
      const lists = () => s.fake.calls.filter((c) => c.method === "GET" && c.url.searchParams.has("timeMin")).length;
      await a.services.google.calendar.list({ from: "2026-11-12", to: "2026-11-14" });
      await b.services.google.calendar.list({ from: "2026-11-12", to: "2026-11-14" });
      expect(lists()).toBe(1);
      // A write drops the shared copy.
      addSlots(a, ["2026-11-12"]);
      expect((await run(a, "calendar_sync_slot", { slot_key: "2026-11-12T10:30", restore_removed: null })).code).toBe("ok");
      const seen = await b.services.google.calendar.list({ from: "2026-11-12", to: "2026-11-14" });
      expect(lists()).toBe(2);
      // B never sees A's event.
      expect(seen.filter((e) => e.slotKey !== null)).toEqual([]);
      const refresh = (ws: Ws) => ws.googleRoutes.api({ method: "POST", path: "/api/google/calendar/refresh", body: {}, generation: ws.kase.generation(), host: "127.0.0.1:5311", secure: false });
      const answers: number[] = [];
      for (let i = 0; i < REFRESH_LIMIT.limit + 1; i++) answers.push((await refresh(i % 2 ? a : b)).status);
      expect(answers.slice(0, REFRESH_LIMIT.limit).every((x) => x === 200)).toBe(true);
      const last = await refresh(a);
      expect(last).toMatchObject({ status: 429, body: { error: "google_demo_rate_limited", message: GOOGLE_ERROR_TEXT.google_demo_rate_limited } });
    } finally {
      s.close();
    }
  });
});

describe("0021 round 2, finding 3: the cap holds under concurrent writes", () => {
  it("seven concurrent syncs of different slots add exactly five events", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      const dates = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"];
      addSlots(a, dates);
      const results = await Promise.all(dates.map((d) => run(a, "calendar_sync_slot", { slot_key: `${d}T10:30`, restore_removed: null })));
      expect(results.filter((r) => r.code === "ok")).toHaveLength(MAX_LIVE_EVENTS);
      expect(results.filter((r) => r.code === "google_demo_limit")).toHaveLength(dates.length - MAX_LIVE_EVENTS);
      expect(liveOwned(s.fake, ownerTag(ACCOUNT_A))).toHaveLength(MAX_LIVE_EVENTS);
    } finally {
      s.close();
    }
  });

  it("concurrent Undo restores and new syncs share the lock and the count", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      const dates = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"];
      addSlots(a, dates);
      const made = [];
      for (const d of dates.slice(0, 5)) made.push(await run(a, "calendar_sync_slot", { slot_key: `${d}T10:30`, restore_removed: null }));
      const removed = [];
      for (const d of dates.slice(0, 2)) removed.push(await run(a, "calendar_remove_slot", { slot_key: `${d}T10:30` }));
      expect(liveOwned(s.fake, ownerTag(ACCOUNT_A))).toHaveLength(3);
      const actions = new CaseActions(a.store, a.services);
      const entries = actions.activity().entries.filter((e) => e.kind === "calendar_event_removed");
      expect(entries).toHaveLength(2);
      const undos = entries.map((e) => actions.undoEntry(YOU, e.id, actions.activityVersion()).then(() => "ok", (err: Error) => err.message));
      const syncs = dates.slice(5).map((d) => run(a, "calendar_sync_slot", { slot_key: `${d}T10:30`, restore_removed: null }));
      await Promise.all([...undos, ...syncs]);
      expect(liveOwned(s.fake, ownerTag(ACCOUNT_A)).length).toBeLessThanOrEqual(MAX_LIVE_EVENTS);
    } finally {
      s.close();
    }
  });

  it("the write rate limit refuses calendar_sync_slot and an Undo that puts an event back, never a remove", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      addSlots(a, ["2026-11-12", "2026-11-13"]);
      const made = await run(a, "calendar_sync_slot", { slot_key: "2026-11-12T10:30", restore_removed: null });
      expect(made.code).toBe("ok");
      const removed = await run(a, "calendar_remove_slot", { slot_key: "2026-11-12T10:30" });
      expect(removed.code).toBe("ok");
      // The account spends the rest of its window.
      const shared = s.demo.sharedCalendar(ACCOUNT_A);
      while (shared.takeWrite());
      const refused = await run(a, "calendar_sync_slot", { slot_key: "2026-11-13T10:30", restore_removed: null });
      expect(refused).toMatchObject({ ok: false, code: "google_demo_rate_limited" });
      const actions = new CaseActions(a.store, a.services);
      const undo = actions.activity().entries.find((e) => e.kind === "calendar_event_removed")!;
      await expect(actions.undoEntry(YOU, undo.id, actions.activityVersion())).rejects.toThrow(GOOGLE_ERROR_TEXT.google_demo_rate_limited);
      expect(liveOwned(s.fake, ownerTag(ACCOUNT_A))).toEqual([]);
      expect(WRITE_LIMIT.limit).toBe(20);
    } finally {
      s.close();
    }
  });
});

describe("0021 round 2, findings 4 and 5: the sweep reads every page, and cleanups keep their time", () => {
  it("pages to the end, and past the page cap says so and keeps its cleanups", async () => {
    const s = await demoSetup();
    try {
      const add = (owner: string, created: string) =>
        s.fake.addForeignEvent("primary", { summary: "x", start: { dateTime: "2026-11-12T10:00:00-07:00" }, created, extendedProperties: { private: { [APP_PROPERTY]: "1", apptSlotKey: "k", apptAccount: "1000001", [OWNER_PROPERTY]: owner } } });
      const closed = ownerTag(ACCOUNT_B);
      for (let i = 0; i < 7; i++) add(closed, "2026-11-06T16:00:00Z");
      s.fake.pageSize = 2;
      expect(await s.demo.sweep(() => false)).toEqual({ removed: 7, failed: 0, complete: true });
      // More pages than the cap: incomplete, and a cleanup stays.
      for (let i = 0; i < SWEEP_MAX_PAGES + 1; i++) add(ownerTag(ACCOUNT_A), "2026-11-06T16:00:00Z");
      s.fake.pageSize = 1;
      s.fake.unreachable = true;
      expect(await s.demo.forget(ACCOUNT_A)).toEqual({ removed: 0, pending: true });
      s.fake.unreachable = false;
      const r = await s.demo.sweep(() => true);
      expect(r.complete).toBe(false);
      expect(r.removed).toBe(SWEEP_MAX_PAGES);
      // The next sweep finishes it.
      expect(await s.demo.sweep(() => true)).toEqual({ removed: 1, failed: 0, complete: true });
      expect(liveOwned(s.fake, ownerTag(ACCOUNT_A))).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("forget leaves an event made after it, and Delete case says whether the events went", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      addSlots(a, ["2026-11-12"]);
      await run(a, "calendar_sync_slot", { slot_key: "2026-11-12T10:30", restore_removed: null });
      // An event made after the delete's time, as by another tab.
      s.fake.addForeignEvent("primary", { summary: "later", start: { dateTime: "2026-11-13T10:00:00-07:00" }, created: new Date(s.fake.now + 60_000).toISOString(), extendedProperties: { private: { [APP_PROPERTY]: "1", apptSlotKey: "k", apptAccount: "1000001", [OWNER_PROPERTY]: ownerTag(ACCOUNT_A) } } });
      const del = await a.api({ method: "POST", path: "/api/case/delete", body: { expectedVersion: a.kase.caseVersion(), confirmation: DELETE_CONFIRMATION }, generation: a.kase.generation() });
      expect(del).toMatchObject({ status: 200, body: { demoCalendar: "removed" } });
      expect(liveOwned(s.fake, ownerTag(ACCOUNT_A)).map((e) => e.summary)).toEqual(["later"]);
      // Google cannot be reached: the answer says the removal is pending.
      s.fake.unreachable = true;
      const again = await a.api({ method: "POST", path: "/api/case/delete", body: { expectedVersion: a.kase.caseVersion(), confirmation: DELETE_CONFIRMATION }, generation: a.kase.generation() });
      expect(again).toMatchObject({ status: 200, body: { demoCalendar: "pending" } });
    } finally {
      s.close();
    }
  });
});

describe("0021 round 2, findings 6 to 9", () => {
  it("a demo grant without both Gmail and Calendar is refused, and the status prints what was granted", async () => {
    const s = await demoSetup({ connect: false });
    try {
      await expect(s.connect({ only: ["https://www.googleapis.com/auth/gmail.readonly"] })).rejects.toMatchObject({ code: "no_permission_granted" });
      expect(s.demo.status()).toMatchObject({ connected: false });
      // A new account's partial grant is revoked.
      expect([...s.fake.grants.values()].every((g) => g.revoked)).toBe(true);
      await s.connect();
      expect(s.demo.status()).toMatchObject({ connected: true, gmail: true, calendar: true });
      // A partial renewal of the same account leaves the stored grant.
      await expect(s.connect({ only: ["https://www.googleapis.com/auth/calendar.events"] })).rejects.toMatchObject({ code: "no_permission_granted" });
      expect([...s.fake.grants.values()].some((g) => !g.revoked)).toBe(true);
      expect(s.demo.status()).toMatchObject({ connected: true, gmail: true, calendar: true });
    } finally {
      s.close();
    }
  });

  it("while the shared connection needs reconnecting, a clash check says the calendar could not be read", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      addSlots(a, ["2026-11-12"]);
      s.fake.now += 2 * 3600_000;
      s.fake.refreshFails = "invalid_grant";
      // The first call finds the connection expired.
      expect((await run(a, "calendar_list", { from: "2026-11-12", to: "2026-11-12" })).code).toBe("google_demo_reconnect");
      const tool = (await import("../src/agent/tools.ts")).toolByName("check_calendar")!;
      const r = await tool.run(toolCtx(a) as never, tool.input.parse({ date: "2026-11-12", time: "10:00" }));
      expect(r).toMatchObject({ ok: false, code: "google_demo_reconnect" });
      expect(r.cards).toEqual([{ kind: "notice", text: CALENDAR_UNREADABLE }]);
    } finally {
      s.close();
    }
  });

  it("Gmail is read only: a call that is not a read never reaches Google", async () => {
    const s = await demoSetup();
    try {
      const a = s.workspace(ACCOUNT_A);
      const calls = s.fake.calls.length;
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        await expect(a.services.google.connection.call("gmail", `${GMAIL_API}/messages/19d001/trash`, { method })).rejects.toMatchObject({ code: "google_refused" });
        await expect(s.demo.connection.call("gmail", `${GMAIL_API}/messages/send`, { method })).rejects.toMatchObject({ code: "google_refused" });
      }
      expect(s.fake.calls.length).toBe(calls);
    } finally {
      s.close();
    }
  });

  it("a stray link leaves an account's own connect in progress, with its cookie", async () => {
    hosted = await startHosted({ env: { APP_DEMO_GOOGLE: "on" } });
    const h = hosted;
    const fake = h.google!.fake;
    const a = h.browser();
    await h.signUp(a);
    const ga = (await a.call("GET", "/api/google")).body;
    const sa = (await a.call("GET", "/api/state")).body;
    const own = await a.call("POST", "/api/google/connect", { expectedVersion: ga.version }, { "X-Case-Generation": String(sa.generation) });
    const ownBack = fake.consent(own.body.authorizeUrl);
    const cookieName = [...a.cookies.keys()].find((k) => k.startsWith("appt_google_flow_"))!;
    // A used demo link, or any other, opened in the same browser.
    const stray = await a.visit("/auth/google/callback?state=used-demo-link&code=x");
    expect(stray.headers.location).toBe("/?google_error=invalid_state");
    expect(stray.headers["set-cookie"]).toBeUndefined();
    expect(a.cookies.has(cookieName)).toBe(true);
    fake.account = { sub: "3000003", email: "test.user@example.com" };
    expect((await a.visit(`${ownBack.pathname}${ownBack.search}`)).headers.location).toBe("/?connected=google");
  });
});

describe("the merge with sprint 17: the held live read and the first read, per hosted account", () => {
  it("each account's boot is its own, a sign-out and another account in one browser read again, and the live read ends with its session", async () => {
    hosted = await startHosted();
    const h = hosted;
    const b = h.browser();
    expect((await b.call("POST", "/api/session/judge", { code: h.judgeCode("Judge A").code })).status).toBe(200);
    const s1 = (await b.call("GET", "/api/session")).body;
    const boot1 = await b.call("GET", "/api/boot");
    expect(boot1.status).toBe(200);
    expect(boot1.body.settings.hosted).toMatchObject({ chatgptAvailable: false });
    // A writes to its case.
    const st = boot1.body.state;
    await b.call("POST", "/api/messages", { channel: "email", from: "Front Desk <front@clinic.example>", received_at: "2026-11-05T16:00:00Z", text: "Your visit is confirmed." }, { "X-Case-Generation": String(st.generation) });
    expect((await b.call("GET", "/api/boot")).body.state.messages).toHaveLength(1);
    // Sign out, then another judge in the same browser.
    await b.call("POST", "/api/session/signout", {});
    expect((await b.call("GET", "/api/boot")).status).toBe(401);
    expect((await b.call("POST", "/api/session/judge", { code: h.judgeCode("Judge B").code })).status).toBe(200);
    const s2 = (await b.call("GET", "/api/session")).body;
    expect(s2.account.owner).not.toBe(s1.account.owner);
    expect(s1.account.owner).toMatch(/^[0-9a-f]{24}$/);
    const boot2 = (await b.call("GET", "/api/boot")).body;
    expect(boot2.state.messages).toEqual([]);

    // The held live read answers B's own version, and a sign-out ends it.
    const live = boot2.live;
    const since = `${live.generation}.${live.seq}${live.calendar === undefined ? "" : `.${live.calendar}`}`;
    const held = b.call("GET", `${LIVE_PATH}?since=${since}`);
    await new Promise((r) => setTimeout(r, 300));
    const other = h.browser();
    other.cookies.clear();
    for (const [k, v] of b.cookies) other.cookies.set(k, v);
    await other.call("POST", "/api/session/signout", {});
    const answer = await held;
    expect(answer.status).toBe(401);
  }, 20_000);

  it("the held read does not keep a workspace open, and the request log stays quiet for it", async () => {
    hosted = await startHosted();
    const h = hosted;
    const b = h.browser();
    await b.call("POST", "/api/session/judge", { code: h.judgeCode().code });
    const account = h.app.store.listJudgeCodes().length;
    expect(account).toBe(1);
    const boot = (await b.call("GET", "/api/boot")).body;
    expect(h.app.workspaces.size).toBe(1);
    h.app.workspaces.closeAll();
    const since = `${boot.live.generation}.${boot.live.seq}${boot.live.calendar === undefined ? "" : `.${boot.live.calendar}`}`;
    const held = b.call("GET", `${LIVE_PATH}?since=${since}`);
    await new Promise((r) => setTimeout(r, 600));
    // Nothing opened the closed workspace while the read is held.
    expect(h.app.workspaces.size).toBe(0);
    await b.call("POST", "/api/session/signout", {});
    expect((await held).status).toBe(401);
    // The poll path is left out of the request log, with or without since.
    const lines: string[] = [];
    const log = requestLogger({ write: (l) => lines.push(l) });
    const fakeRes = { statusCode: 200, headersSent: true, writableFinished: true, writeHead: () => fakeRes, getHeader: () => "application/json", once: (_: string, fn: () => void) => fn() };
    log({ method: "GET", url: `${LIVE_PATH}?since=1.2.3`, headers: {} } as never, fakeRes as never);
    expect(lines).toEqual([]);
  }, 20_000);
});

describe("sprint 18 round 2", () => {
  it("a session read while Delete account runs finds the closed account, never a new one", async () => {
    const dir = tmp("sprint18r2-");
    const store = new AccountsStore(path.join(dir, "accounts.sqlite"));
    try {
      const a = store.userAccount({ userId: "userAAA", email: "pat@example.com", name: null });
      store.deleteAccount(a.id);
      const again = store.userAccount({ userId: "userAAA", email: "pat@example.com", name: null });
      expect(again).toMatchObject({ id: a.id, deleted: true, email: null });
      // A new Better Auth user with the same email is a new account.
      const fresh = store.userAccount({ userId: "userBBB", email: "pat@example.com", name: null });
      expect(fresh.id).not.toBe(a.id);
      expect(fresh.deleted).toBe(false);
    } finally {
      store.close();
    }
  });

  it("deleting a user through a signed dashboard request closes the app account", async () => {
    const KEY = "ba_fake_dashboard_key_for_tests_only_1234567890";
    const apiUrl = `https://dash-${randomUUID()}.example.test`;
    const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const kid = "test-key-2";
    const jwk = { ...(signing.publicKey.export({ format: "jwk" }) as object), kid, alg: "ES256", use: "sig" };
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${apiUrl}/api/auth/jwks`) return Response.json({ keys: [jwk] });
      if (url.startsWith(apiUrl)) return Response.json({ valid: false });
      throw new Error(`no network in tests: ${url}`);
    });
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const jwt = (claims: Record<string, unknown>) => {
      const head = `${b64({ alg: "ES256", kid, typ: "JWT" })}.${b64(claims)}`;
      return `${head}.${sign("sha256", Buffer.from(head), { key: signing.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    };
    const nowS = Math.floor(Date.now() / 1000);
    hosted = await startHosted({ authEnv: { BETTER_AUTH_API_KEY: KEY, BETTER_AUTH_API_URL: apiUrl, BETTER_AUTH_KV_URL: `${apiUrl}/kv` } });
    const h = hosted;
    const target = h.browser();
    await h.signUp(target, { email: "dash-delete@example.com" });
    const accountId = await h.accountOf(target);
    const userId = (await target.auth("GET", "/api/auth/get-session")).body.user.id as string;
    const token = jwt({ apiKeyHash: createHash("sha256").update(KEY).digest("hex"), iat: nowS, exp: nowS + 300, jti: randomUUID(), userId });
    const res = await h.browser().auth("POST", "/api/auth/dash/delete-user", { userId }, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    for (let i = 0; i < 50 && !h.app.store.account(accountId)!.deleted; i++) await new Promise((r) => setTimeout(r, 20));
    expect(h.app.store.account(accountId)).toMatchObject({ deleted: true, email: null });
    // The old session reaches nothing, and mints no new account.
    expect((await target.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect(h.app.store.accountOfUser(userId)).toBeNull();
  });

  it("a session chat turn after Delete account is refused", async () => {
    hosted = await startHosted();
    const h = hosted;
    const b = h.browser();
    await h.signUp(b);
    const s = (await b.call("GET", "/api/state")).body;
    expect((await b.call("POST", "/api/account/delete", { confirmation: DELETE_CONFIRMATION })).status).toBe(200);
    const turn = await b.call("POST", "/api/chat", { text: "Hi", expectedVersion: 0 }, { "X-Case-Generation": String(s.generation) });
    expect(turn.status).toBe(401);
  });
});
