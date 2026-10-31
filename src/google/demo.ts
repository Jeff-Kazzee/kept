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
export const MAX_EVENT_AGE_MS = 7 * 86_400_000;
export const SWEEP_MS = 60 * 60_000;
// The most app events one sweep reads: pages of 250.
const SWEEP_PAGES = 8;
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
const Pending = z.object({ stateHash: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.number().int(), expectEmail: z.string().max(320).nullable(), flow: FlowShape }).strict();
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
};

const AppEvent = z.object({
  id: z.string().min(1).max(1024),
  etag: z.string().max(200).optional(),
  status: z.string().optional(),
  created: z.string().max(64).optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
});
type AppEvent = { id: string; etag: string | undefined; owner: string | null; created: number };

// The shared connection's errors that mean it must be connected again.
const RECONNECT: ReadonlySet<GoogleErrorCode> = new Set(["google_reconnect_needed", "google_not_connected", "google_scope_missing"]);
const demoError = (err: unknown): unknown => (err instanceof GoogleError && RECONNECT.has(err.code) ? new GoogleError("google_demo_reconnect", err.status) : err);

export class DemoGoogle {
  readonly connection: GoogleConnection;
  readonly #store: SecretsStore;
  readonly #now: () => number;
  readonly #writes: AddressLimiter;

  constructor(options: { client: OAuthClient | null; file: string; fetch?: FetchLike; now?: () => number }) {
    this.#now = options.now ?? Date.now;
    this.#store = new SecretsStore(options.file, { now: this.#now });
    this.connection = new GoogleConnection({ client: options.client, store: this.#store, ...(options.fetch ? { fetch: options.fetch } : {}), now: this.#now });
    this.#writes = new AddressLimiter({ ...WRITE_LIMIT, now: this.#now });
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
  startConnect(input: { redirectUri: string; expectEmail?: string | null }): { authorizeUrl: string; expiresAt: number } {
    const { flow, state, authorizeUrl } = this.connection.newFlow({ features: { gmail: true, calendar: true }, calendarId: DEFAULT_CALENDAR_ID, redirectUri: input.redirectUri });
    const expiresAt = this.#now() + FLOW_TTL_MS;
    const pending: Pending = { stateHash: sha256(state).toString("hex"), expiresAt, expectEmail: input.expectEmail?.trim().toLowerCase() || null, flow };
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
    await this.connection.completeFlow(flow, { code: input.code, error: input.error, expectEmail: p.expectEmail });
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

  linkFor(own: GoogleConnection): AccountGoogle {
    return new AccountGoogle(own, this);
  }

  sharedCalendar(accountId: string): SharedCalendar {
    return { owner: ownerTag(accountId), maxLive: MAX_LIVE_EVENTS, takeWrite: () => this.#writes.take(accountId).ok };
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

  // The app events in the shared calendar, every one or one account's, at
  // most SWEEP_PAGES pages. Throws a GoogleError when Google cannot be read.
  async #appEvents(owner: string | null): Promise<AppEvent[]> {
    const { calendarId } = this.connection.calendar();
    const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.append("privateExtendedProperty", `${APP_PROPERTY}=1`);
    if (owner !== null) url.searchParams.append("privateExtendedProperty", `${OWNER_PROPERTY}=${owner}`);
    url.searchParams.set("maxResults", "250");
    const out: AppEvent[] = [];
    for (let page = 0; page < SWEEP_PAGES; page++) {
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
      if (!parsed.data.nextPageToken) break;
      url.searchParams.set("pageToken", parsed.data.nextPageToken);
    }
    return out;
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
  // calendar go now. What cannot go now is kept as a cleanup, which the
  // sweep finishes: every event of the account made until now. Returns how
  // many went, or null when Google could not be reached.
  async forget(accountId: string): Promise<number | null> {
    const owner = ownerTag(accountId);
    const before = this.#now();
    this.#changeCleanups((list) => [...list, { owner, before }]);
    try {
      const events = await this.#appEvents(owner);
      let removed = 0;
      let failed = 0;
      for (const e of events) {
        if (e.owner !== owner) continue;
        if (await this.#remove(e)) removed++;
        else failed++;
      }
      if (failed === 0) this.#changeCleanups((list) => list.filter((c) => !(c.owner === owner && c.before === before)));
      return removed;
    } catch (err) {
      if (err instanceof GoogleError) return null;
      throw err;
    }
  }

  // The sweep (D6): removes the app events of accounts `live` does not
  // name, those older than MAX_EVENT_AGE_MS, and those a cleanup names.
  // Never an event without an account's mark. Counts only.
  async sweep(live: (owner: string) => boolean): Promise<{ removed: number; failed: number }> {
    const now = this.#now();
    const cleanups = this.#cleanups();
    const events = await this.#appEvents(null);
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
    if (failed === 0 && cleanups.length > 0) {
      const done = new Set(cleanups.map((c) => `${c.owner}|${c.before}`));
      this.#changeCleanups((list) => list.filter((c) => !done.has(`${c.owner}|${c.before}`)));
    }
    return { removed, failed };
  }
}

// One account's Google (D3): its own connection when it has one, also one
// that needs reconnecting, and the shared demo connection otherwise.
export class AccountGoogle implements GoogleLink {
  readonly #own: GoogleConnection;
  readonly #demo: DemoGoogle;

  constructor(own: GoogleConnection, demo: DemoGoogle) {
    this.#own = own;
    this.#demo = demo;
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

  async call(feature: Feature, url: string, init: RequestInit = {}): Promise<GoogleResponse> {
    if (!this.usingShared()) return this.#own.call(feature, url, init);
    try {
      return await this.#demo.connection.call(feature, url, init);
    } catch (err) {
      throw demoError(err);
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
