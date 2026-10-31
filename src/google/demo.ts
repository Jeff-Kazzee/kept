// The shared demo Gmail and Calendar of the hosted site (0021). Judges
// cannot connect their own Google: the Google project is in testing mode
// with two made-up test users. So, with APP_DEMO_GOOGLE=on, the server holds
// one Google connection to a made-up person's account, and every hosted
// account without its own connection uses it.
//
// - D1. The connection is a GoogleConnection like a workspace's, in its own
//   secrets file, hosted/demo-google.sqlite (mode 600, the same checks and
//   transactions as app-secrets.sqlite).
// - D2. `pnpm admin google demo-connect` starts a connect: the flow, with
//   its PKCE verifier and nonce, is kept in that file, and only the hash of
//   its state. It lasts FLOW_TTL_MS and is used once. The server's
//   /auth/google/callback finishes it by the state alone, with no session:
//   only whoever holds the printed link can. A newer connect replaces a
//   waiting one.
// - D3, D4. AccountGoogle sends an account without its own connection to
//   the shared one. Its account keys start with "shared:", so offers, undo
//   records and intents made with it never match an own connection.
// - D5, D6. Each account's calendar writes carry its mark (ownerTag) and
//   follow the shared calendar's limits (calendar.ts, SharedCalendar).
//   Delete case and Delete account remove the account's events (forget),
//   and the sweep removes the events of closed accounts, of expired judge
//   codes and those older than MAX_EVENT_AGE_MS. Only events with an
//   account's mark are ever removed here: the local demo's never.
// - D7. With the shared connection expired or revoked, its errors become
//   google_demo_reconnect, a sentence that says so.
//
// Nothing here logs a token, an email address or an email's text.
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { AddressLimiter } from "../hosted/rate-limit.ts";
import { SecretsStore } from "../model/providers/secrets.ts";
import { appDbPath } from "../paths.ts";
import { APP_PROPERTY, CALENDAR_API, OWNER_PROPERTY, type SharedCalendar } from "./calendar.ts";
import { DEFAULT_CALENDAR_ID, GoogleConnection, type Feature, type GoogleLink, type GoogleStatus } from "./connection.ts";
import { GoogleError, type FetchLike, type GoogleErrorCode, type GoogleResponse } from "./http.ts";
import { FLOW_TTL_MS, OAuthError, type OAuthClient } from "./oauth.ts";

export const DEMO_GOOGLE_FILE = "demo-google.sqlite";

// Beside the accounts database.
export function demoGooglePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(appDbPath(env)), "hosted", DEMO_GOOGLE_FILE);
}

// A test user's consent lasts 7 days in testing mode (docs/google.md).
export const CONSENT_MS = 7 * 86_400_000;
// D6 (proposed): live app events per account, and creates and updates per
// account in a window.
export const MAX_LIVE_EVENTS = 5;
export const WRITE_LIMIT = { limit: 20, windowMs: 10 * 60_000 };
// Round 2, finding 2 (proposed): every Google call the accounts make
// through the shared connection, together, in a window, and the calendar
// refresh route, together, in a minute. The sweep and the cleanups are not
// counted: they keep the calendar small.
export const GLOBAL_CALL_LIMIT = { limit: 400, windowMs: 5 * 60_000 };
export const REFRESH_LIMIT = { limit: 30, windowMs: 60_000 };
// Final review, fairness (proposed): one account's share of each, checked
// first, so no single account can spend the shared budget for everyone.
export const ACCOUNT_CALL_LIMIT = { limit: 80, windowMs: 5 * 60_000 };
export const ACCOUNT_REFRESH_LIMIT = { limit: 6, windowMs: 60_000 };
// A calendar window read through the shared connection is kept this long
// for every account, and dropped at any calendar write.
export const LIST_CACHE_MS = 60_000;
const LIST_CACHE_MAX = 50;
export const MAX_EVENT_AGE_MS = 7 * 86_400_000;
export const SWEEP_MS = 60 * 60_000;
// Round 2, finding 4: the sweep pages to the end. Past this many pages of
// 250 it stops, says it is incomplete, and keeps its cleanups.
export const SWEEP_MAX_PAGES = 100;
const MAX_CLEANUPS = 500;

// What the agent is told while an account uses the shared connection (D8).
export const DEMO_GOOGLE_INSTRUCTION =
  "The Gmail inbox and Google Calendar here belong to a made-up person and are shared with other judges. When you use them, say so, and tell the person not to add anything private there.";

// An account's mark in the shared calendar: a hash of its id, so the
// calendar never holds the id itself.
export const ownerTag = (accountId: string) => createHash("sha256").update(`appointments-demo-owner:${accountId}`).digest("hex").slice(0, 32);

const sha256 = (s: string) => createHash("sha256").update(s).digest();

const FlowShape = z
  .object({
    verifier: z.string().min(43).max(128),
    nonce: z.string().min(1).max(200),
    redirectUri: z.string().max(500),
    features: z.object({ gmail: z.boolean(), calendar: z.boolean() }).strict(),
    calendarId: z.string().max(500),
    version: z.number().int().nonnegative(),
  })
  .strict();
// Round 2, finding 1: the demo account's email is required, and its Google
// id once it was connected.
const Pending = z
  .object({ stateHash: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.number().int(), expectEmail: z.string().min(3).max(320), expectSub: z.string().max(255).nullable(), flow: FlowShape })
  .strict();
const FlowRow = z.object({ pending: Pending.nullable() }).strict();
type Pending = z.infer<typeof Pending>;

const Cleanup = z.object({ owner: z.string().regex(/^[0-9a-f]{32}$/), before: z.number().int() }).strict();
const CleanupRow = z.object({ cleanups: z.array(Cleanup).max(MAX_CLEANUPS) }).strict();
type Cleanup = z.infer<typeof Cleanup>;

export type DemoStatus = {
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
  // For the admin command and the start log only, never a judge's page.
  email: string | null;
  connectedAt: string | null;
  // When Google ends the consent: connectedAt plus 7 days.
  expiresAt: string | null;
  // A demo-connect link is waiting until then.
  pendingUntil: string | null;
  // What the stored grant allows (round 2, finding 6).
  gmail: boolean;
  calendar: boolean;
};

// Thrown by startConnect without the demo account's email.
export class DemoConnectError extends Error {
  override name = "DemoConnectError";
}

const AppEvent = z.object({
  id: z.string().min(1).max(1024),
  etag: z.string().max(200).optional(),
  status: z.string().optional(),
  created: z.string().max(64).optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
});
type AppEvent = { id: string; etag: string | undefined; owner: string | null; created: number };

// A list of a calendar's events in a time window, which every account on
// the shared connection reads the same way.
const isWindowList = (url: string) => {
  const u = new URL(url);
  return u.pathname.endsWith("/events") && u.searchParams.has("timeMin");
};

// The shared connection's errors that mean it must be connected again.
const RECONNECT: ReadonlySet<GoogleErrorCode> = new Set(["google_reconnect_needed", "google_not_connected", "google_scope_missing"]);
const demoError = (err: unknown): unknown => (err instanceof GoogleError && RECONNECT.has(err.code) ? new GoogleError("google_demo_reconnect", err.status) : err);

export class DemoGoogle {
  readonly connection: GoogleConnection;
  readonly #store: SecretsStore;
  readonly #now: () => number;
  readonly #writes: AddressLimiter;
  readonly #calls: AddressLimiter;
  readonly #refreshes: AddressLimiter;
  readonly #accountCalls: AddressLimiter;
  readonly #accountRefreshes: AddressLimiter;
  // Calendar window reads, by URL, shared by every account (finding 2).
  readonly #lists = new Map<string, { at: number; read: Promise<GoogleResponse> }>();
  // One add at a time per account mark (finding 3).
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: { client: OAuthClient | null; file: string; fetch?: FetchLike; now?: () => number }) {
    this.#now = options.now ?? Date.now;
    this.#store = new SecretsStore(options.file, { now: this.#now });
    this.connection = new GoogleConnection({ client: options.client, store: this.#store, ...(options.fetch ? { fetch: options.fetch } : {}), now: this.#now });
    this.#writes = new AddressLimiter({ ...WRITE_LIMIT, now: this.#now });
    this.#calls = new AddressLimiter({ ...GLOBAL_CALL_LIMIT, now: this.#now });
    this.#refreshes = new AddressLimiter({ ...REFRESH_LIMIT, now: this.#now });
    this.#accountCalls = new AddressLimiter({ ...ACCOUNT_CALL_LIMIT, now: this.#now });
    this.#accountRefreshes = new AddressLimiter({ ...ACCOUNT_REFRESH_LIMIT, now: this.#now });
  }

  // ---- Round 2, findings 2 and 3: the shared budget, cache and locks ----

  // One Google call of an account through the shared connection. False
  // past the shared budget.
  takeCall(accountId?: string): boolean {
    if (accountId !== undefined && !this.#accountCalls.take(accountId).ok) return false;
    return this.#calls.take("all").ok;
  }

  // One POST /api/google/calendar/refresh of an account on the shared
  // connection. False past its limit.
  takeRefresh(accountId?: string): boolean {
    if (accountId !== undefined && !this.#accountRefreshes.take(accountId).ok) return false;
    return this.#refreshes.take("all").ok;
  }

  // A calendar window read, from the shared cache when one is younger than
  // LIST_CACHE_MS. Only a 200 is kept.
  async cachedList(url: string, read: () => Promise<GoogleResponse>): Promise<GoogleResponse> {
    const now = this.#now();
    const kept = this.#lists.get(url);
    if (kept && now - kept.at < LIST_CACHE_MS) return kept.read;
    const entry = { at: now, read: read() };
    this.#lists.set(url, entry);
    while (this.#lists.size > LIST_CACHE_MAX) this.#lists.delete(this.#lists.keys().next().value!);
    entry.read.then(
      (r) => {
        if (r.status !== 200 && this.#lists.get(url) === entry) this.#lists.delete(url);
      },
      () => {
        if (this.#lists.get(url) === entry) this.#lists.delete(url);
      },
    );
    return entry.read;
  }

  // A calendar write: no account reads a window from before it.
  dropLists(): void {
    this.#lists.clear();
  }

  // Runs `fn` alone for the account mark `owner`: a write that adds an
  // event counts the live ones and adds its own with no other add of the
  // same account in between.
  async lock<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(owner) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = before.then(() => mine);
    this.#locks.set(owner, chain);
    await before.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(owner) === chain) this.#locks.delete(owner);
    }
  }

  get configured(): boolean {
    return this.connection.configured;
  }

  close(): void {
    this.#store.close();
  }

  // ---- D2: connect, status, disconnect ----

  #pending(): Pending | null {
    const text = this.#store.readRow("google_demo_flow");
    if (text === null) return null;
    try {
      const p = FlowRow.parse(JSON.parse(text)).pending;
      return p && p.expiresAt > this.#now() ? p : null;
    } catch {
      return null;
    }
  }

  // Starts a connect and keeps its flow. Returns the link to open, signed
  // in as the demo account, and when it stops working.
  // Round 2, finding 1: the demo account's email is required. Once a demo
  // account is stored, only that same Google account can renew it, until
  // demo-disconnect.
  startConnect(input: { redirectUri: string; expectEmail: string }): { authorizeUrl: string; expiresAt: number } {
    const expectEmail = (input.expectEmail ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectEmail)) throw new DemoConnectError("The demo account's email address is required.");
    const { flow, state, authorizeUrl } = this.connection.newFlow({ features: { gmail: true, calendar: true }, calendarId: DEFAULT_CALENDAR_ID, redirectUri: input.redirectUri });
    const expiresAt = this.#now() + FLOW_TTL_MS;
    const pending: Pending = { stateHash: sha256(state).toString("hex"), expiresAt, expectEmail, expectSub: this.connection.storedAccount(), flow };
    this.#store.updateRow("google_demo_flow", () => JSON.stringify({ pending }));
    return { authorizeUrl, expiresAt };
  }

  // Whether `state` is the waiting demo connect's. Reads only.
  ownsState(state: string | null): boolean {
    if (!state || state.length > 200) return false;
    const p = this.#pending();
    return p !== null && timingSafeEqual(sha256(state), Buffer.from(p.stateHash, "hex"));
  }

  // The callback of a demo connect. Takes the flow, once, by its state,
  // then exchanges the code and stores the connection. Throws an
  // OAuthError with a fixed code.
  async finishConnect(input: { state: string | null; code: string | null; error: string | null }): Promise<void> {
    if (!input.state || input.state.length > 200) throw new OAuthError("invalid_state");
    const want = sha256(input.state);
    let taken: Pending | null = null;
    this.#store.updateRow("google_demo_flow", (current) => {
      let p: Pending | null = null;
      try {
        p = current === null ? null : FlowRow.parse(JSON.parse(current)).pending;
      } catch {
        p = null;
      }
      if (!p || !timingSafeEqual(want, Buffer.from(p.stateHash, "hex"))) return null;
      taken = p;
      return JSON.stringify({ pending: null });
    });
    const p = taken as Pending | null;
    if (!p || p.expiresAt <= this.#now()) throw new OAuthError("invalid_state");
    // One admin starts one connect at a time, so the flow finishes against
    // the connection as it is now, renewal included. The write itself
    // still checks that nothing changed while Google answered.
    const flow = { ...p.flow, version: this.connection.status().version };
    // Finding 1: the stored demo account, if any, is the only one that can
    // take its place, and nothing revokes its grant on a mismatch. Finding
    // 6: both Gmail and Calendar.
    const expectSub = this.connection.storedAccount() ?? p.expectSub;
    await this.connection.completeFlow(flow, { code: input.code, error: input.error, expectEmail: p.expectEmail, expectSub, requireBoth: true });
  }

  status(): DemoStatus {
    const s = this.connection.status();
    const at = this.connection.connectedAt();
    const pending = this.#pending();
    return {
      configured: s.configured,
      connected: s.connected,
      needsReconnect: s.needsReconnect,
      email: s.email,
      connectedAt: at,
      expiresAt: at ? new Date(Date.parse(at) + CONSENT_MS).toISOString() : null,
      pendingUntil: pending ? new Date(pending.expiresAt).toISOString() : null,
      gmail: s.gmail,
      calendar: s.calendar,
    };
  }

  // Revokes the grant at Google and deletes it here, with any waiting
  // connect.
  async disconnect(): Promise<{ had: boolean; revoked: boolean }> {
    this.#store.updateRow("google_demo_flow", () => JSON.stringify({ pending: null }));
    const s = this.connection.status();
    const had = s.email !== null || s.needsReconnect;
    const { revoked } = await this.connection.disconnect(s.version);
    return { had, revoked };
  }

  // ---- D3: an account's view ----

  linkFor(own: GoogleConnection, accountId?: string): AccountGoogle {
    return new AccountGoogle(own, this, accountId);
  }

  sharedCalendar(accountId: string): SharedCalendar {
    const owner = ownerTag(accountId);
    return { owner, maxLive: MAX_LIVE_EVENTS, takeWrite: () => this.#writes.take(accountId).ok, lock: (fn) => this.lock(owner, fn) };
  }

  // ---- D6: cleanup ----

  #cleanups(): Cleanup[] {
    const text = this.#store.readRow("google_demo_cleanup");
    if (text === null) return [];
    try {
      return CleanupRow.parse(JSON.parse(text)).cleanups;
    } catch {
      return [];
    }
  }

  #changeCleanups(change: (list: Cleanup[]) => Cleanup[]): void {
    this.#store.updateRow("google_demo_cleanup", (current) => {
      let list: Cleanup[] = [];
      try {
        list = current === null ? [] : CleanupRow.parse(JSON.parse(current)).cleanups;
      } catch {
        list = [];
      }
      return JSON.stringify({ cleanups: change(list).slice(-MAX_CLEANUPS) });
    });
  }

  // The app events in the shared calendar, every one or one account's,
  // page after page to the end, or to SWEEP_MAX_PAGES (finding 4), when
  // `complete` is false. Throws a GoogleError when Google cannot be read.
  async #appEvents(owner: string | null): Promise<{ events: AppEvent[]; complete: boolean }> {
    const { calendarId } = this.connection.calendar();
    const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.append("privateExtendedProperty", `${APP_PROPERTY}=1`);
    if (owner !== null) url.searchParams.append("privateExtendedProperty", `${OWNER_PROPERTY}=${owner}`);
    url.searchParams.set("maxResults", "250");
    const out: AppEvent[] = [];
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const res = await this.connection.call("calendar", url.toString());
      if (res.status !== 200) throw new GoogleError(res.status === 429 || res.status >= 500 ? "google_unavailable" : "google_refused", res.status);
      const parsed = z.object({ items: z.array(z.unknown()).optional(), nextPageToken: z.string().max(2000).optional() }).safeParse(res.body);
      if (!parsed.success) throw new GoogleError("google_invalid_response");
      for (const item of parsed.data.items ?? []) {
        const e = AppEvent.safeParse(item);
        if (!e.success || e.data.status === "cancelled") continue;
        const props = e.data.extendedProperties?.private;
        if (props?.[APP_PROPERTY] !== "1") continue;
        const created = Date.parse(e.data.created ?? "");
        out.push({ id: e.data.id, etag: e.data.etag, owner: props[OWNER_PROPERTY] ?? null, created: Number.isFinite(created) ? created : NaN });
      }
      if (!parsed.data.nextPageToken) return { events: out, complete: true };
      url.searchParams.set("pageToken", parsed.data.nextPageToken);
    }
    return { events: out, complete: false };
  }

  // Removes one event under its ETag. False when it could not be removed,
  // such as when it changed at Google since it was read.
  async #remove(e: AppEvent): Promise<boolean> {
    if (!e.etag) return false;
    const { calendarId } = this.connection.calendar();
    let res: GoogleResponse;
    try {
      res = await this.connection.call("calendar", `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(e.id)}`, {
        method: "DELETE",
        headers: { "If-Match": e.etag },
      });
    } catch {
      return false;
    }
    return res.status === 200 || res.status === 204 || res.status === 404 || res.status === 410;
  }

  // Delete case and Delete account (D6): the account's events in the shared
  // calendar, made until now, go now (finding 5: not one made after). What
  // cannot go now is kept as a cleanup, which the sweep finishes.
  // `pending` is true when some of them are left for the sweep.
  async forget(accountId: string): Promise<{ removed: number; pending: boolean }> {
    const owner = ownerTag(accountId);
    const before = this.#now();
    this.#changeCleanups((list) => [...list, { owner, before }]);
    this.dropLists();
    try {
      const { events, complete } = await this.#appEvents(owner);
      let removed = 0;
      let failed = 0;
      for (const e of events) {
        if (e.owner !== owner || e.created > before) continue;
        if (await this.#remove(e)) removed++;
        else failed++;
      }
      const done = failed === 0 && complete;
      if (done) this.#changeCleanups((list) => list.filter((c) => !(c.owner === owner && c.before === before)));
      return { removed, pending: !done };
    } catch (err) {
      if (err instanceof GoogleError) return { removed: 0, pending: true };
      throw err;
    } finally {
      this.dropLists();
    }
  }

  // The sweep (D6): removes the app events of accounts `live` does not
  // name, those older than MAX_EVENT_AGE_MS, and those a cleanup names.
  // Never an event without an account's mark. Counts only.
  async sweep(live: (owner: string) => boolean): Promise<{ removed: number; failed: number; complete: boolean }> {
    const now = this.#now();
    const cleanups = this.#cleanups();
    const { events, complete } = await this.#appEvents(null);
    let removed = 0;
    let failed = 0;
    for (const e of events) {
      if (e.owner === null) continue;
      const owner = e.owner;
      const old = Number.isFinite(e.created) && now - e.created > MAX_EVENT_AGE_MS;
      const pending = cleanups.some((c) => c.owner === owner && (!Number.isFinite(e.created) || e.created <= c.before));
      if (live(owner) && !old && !pending) continue;
      if (await this.#remove(e)) removed++;
      else failed++;
    }
    if (removed > 0) this.dropLists();
    // Finding 4: cleanups go only after a sweep that saw every event.
    if (failed === 0 && complete && cleanups.length > 0) {
      const done = new Set(cleanups.map((c) => `${c.owner}|${c.before}`));
      this.#changeCleanups((list) => list.filter((c) => !done.has(`${c.owner}|${c.before}`)));
    }
    return { removed, failed, complete };
  }
}

// One account's Google (D3): its own connection when it has one, also one
// that needs reconnecting, and the shared demo connection otherwise.
export class AccountGoogle implements GoogleLink {
  readonly #own: GoogleConnection;
  readonly #demo: DemoGoogle;
  readonly #accountId: string | undefined;

  constructor(own: GoogleConnection, demo: DemoGoogle, accountId?: string) {
    this.#own = own;
    this.#demo = demo;
    this.#accountId = accountId;
  }

  usingShared(): boolean {
    const s = this.#own.status();
    return !(s.connected || s.needsReconnect);
  }

  get configured(): boolean {
    return this.#own.configured;
  }

  // While shared: Gmail and Calendar as the shared connection grants them,
  // or both while it is not connected, so the tools are offered and say
  // that it needs reconnecting (D7). Never the shared account's address.
  status(): GoogleStatus {
    const own = this.#own.status();
    if (!this.usingShared()) return own;
    const d = this.#demo.connection.status();
    return {
      connected: d.configured,
      email: null,
      gmail: d.connected ? d.gmail : true,
      calendar: d.connected ? d.calendar : true,
      calendarId: d.calendarId ?? DEFAULT_CALENDAR_ID,
      configured: d.configured,
      needsReconnect: false,
      version: own.version,
    };
  }

  // Connections' line while shared (D7): connected or needs reconnecting.
  demoView(): { connected: boolean } | null {
    return this.usingShared() ? { connected: this.#demo.connection.status().connected } : null;
  }

  // What to say when there is no usable connection.
  missingError(): GoogleErrorCode {
    return this.usingShared() ? "google_demo_reconnect" : "google_not_connected";
  }

  // Through the shared connection (round 2, finding 2): every call counts
  // against the shared budget, a calendar window read comes from the
  // shared cache, and a calendar write drops that cache.
  async call(feature: Feature, url: string, init: RequestInit = {}): Promise<GoogleResponse> {
    if (!this.usingShared()) return this.#own.call(feature, url, init);
    const demo = this.#demo;
    const send = async () => {
      if (!demo.takeCall(this.#accountId)) throw new GoogleError("google_demo_rate_limited");
      try {
        return await demo.connection.call(feature, url, init);
      } catch (err) {
        throw demoError(err);
      }
    };
    const method = (init.method ?? "GET").toUpperCase();
    if (feature !== "calendar") return send();
    if (method === "GET") return isWindowList(url) ? demo.cachedList(url, send) : send();
    demo.dropLists();
    try {
      return await send();
    } finally {
      demo.dropLists();
    }
  }

  // D4: keys of the shared connection start with "shared:", so nothing
  // made with it matches an own connection of the same Google account.
  gmailAccount(): string | null {
    if (!this.usingShared()) return this.#own.gmailAccount();
    const a = this.#demo.connection.gmailAccount();
    return a === null ? null : `shared:${a}`;
  }

  storedAccount(): string | null {
    if (!this.usingShared()) return this.#own.storedAccount();
    const a = this.#demo.connection.storedAccount();
    return a === null ? null : `shared:${a}`;
  }

  accountKey(): string | null {
    if (!this.usingShared()) return this.#own.accountKey();
    const k = this.#demo.connection.accountKey();
    return k === null ? null : `shared:${k}`;
  }

  calendar(): { calendarId: string; sub: string; key: string } {
    if (!this.usingShared()) return this.#own.calendar();
    try {
      const c = this.#demo.connection.calendar();
      return { ...c, key: `shared:${c.key}` };
    } catch (err) {
      throw demoError(err);
    }
  }
}
