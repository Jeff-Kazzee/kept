// The app's one Google connection (0012). It keeps the refresh token in
// the `google` row of the app's secrets database (sprint 10's
// app-secrets.sqlite, mode 600, outside the event log), with the last
// access token, which this process also keeps in memory. Every write reads the row, checks it and writes it in one
// BEGIN IMMEDIATE transaction, so the app and the MCP server, which share
// the file, never lose each other's change. It refreshes the access token a minute before it expires. A
// refresh that Google refuses with invalid_grant marks the connection as
// needing a reconnect. Nothing here logs, and no token leaves this module
// except in the Authorization header of a call to Google.
import { createHash } from "node:crypto";
import { z } from "zod";
import { GoogleError, callGoogle, type FetchLike, type GoogleResponse } from "./http.ts";
import {
  OAuthError,
  PendingFlows,
  authorizeUrl,
  checkIdToken,
  exchangeCode,
  grantedFeatures,
  newNonce,
  pkcePair,
  refreshAccess,
  revokeToken,
  type Features,
  type OAuthClient,
} from "./oauth.ts";

// "primary", or a calendar id such as an email address or
// abc123@group.calendar.google.com.
export const CalendarId = z.string().regex(/^(?:primary|[A-Za-z0-9._%+-]{1,200}@[A-Za-z0-9.-]{1,200})$/, "Use primary or a calendar id.");
export const DEFAULT_CALENDAR_ID = "primary";

const Connection = z
  .object({
    sub: z.string().min(1).max(255),
    email: z.string().max(320),
    scopes: z.array(z.string().max(200)).max(20),
    calendarId: CalendarId,
    refreshToken: z.string().min(1).max(4096),
    needsReconnect: z.boolean(),
    connectedAt: z.string(),
    // The last access token and when it expires (Unix ms), so another
    // process sharing the file uses it instead of refreshing again (review
    // round 3, finding 7).
    accessToken: z.string().min(1).max(4096).optional(),
    accessExpiresAt: z.number().int().optional(),
  })
  .strict();
type Connection = z.infer<typeof Connection>;

const Stored = z
  .object({
    version: z.number().int().nonnegative(),
    connection: Connection.nullable(),
  })
  .strict();
type Stored = z.infer<typeof Stored>;

// A stored row that is not valid JSON or not of this shape, such as one
// written by an earlier build (review round 2, finding 10). The app reads
// it as no connection that needs a reconnect: status, connect and
// disconnect still work, and a connect or a disconnect writes a new row in
// its place. The version and the refresh token are kept when they can be
// read, so a page's expected version still matches and a disconnect can
// still revoke the grant.
type Damaged = { version: number; refreshToken: string | null };

function damagedOf(json: unknown): Damaged {
  const o = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const version = Number.isSafeInteger(o.version) && (o.version as number) >= 0 ? (o.version as number) : 0;
  const c = o.connection && typeof o.connection === "object" ? (o.connection as Record<string, unknown>) : {};
  const refreshToken = typeof c.refreshToken === "string" && c.refreshToken.length > 0 && c.refreshToken.length <= 4096 ? c.refreshToken : null;
  return { version, refreshToken };
}

// GET /api/google. The first five fields are the contract shared with
// sprints 8, 9 and 10. The rest are added by this sprint. Never a token.
export type GoogleStatus = {
  connected: boolean;
  email: string | null;
  gmail: boolean;
  calendar: boolean;
  calendarId: string | null;
  // GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
  configured: boolean;
  // A refresh failed. `email`, `gmail` and `calendar` still say what was
  // connected, so the page can offer to connect it again.
  needsReconnect: boolean;
  // The expected version for POST /api/google/connect and disconnect.
  version: number;
};

export type Feature = keyof Features;

const REFRESH_EARLY_MS = 60_000;

// The row store: SecretsStore (src/model/providers/secrets.ts) in the app.
export interface GoogleRowStore {
  readRow(name: "google"): string | null;
  updateRow(name: "google", change: (current: string | null) => string | null): string | null;
  // A lease across processes (SecretsStore.withLease). Without it a refresh
  // is serialized in this process only.
  withLease?<T>(name: string, fn: () => Promise<T>, options?: { skip?: () => T | undefined }): Promise<T>;
}

type State = { stored: Stored; damaged: Damaged | null };

function parseState(text: string | null): State {
  if (text === null) return { stored: { version: 0, connection: null }, damaged: null };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { stored: { version: 0, connection: null }, damaged: { version: 0, refreshToken: null } };
  }
  const parsed = Stored.safeParse(json);
  if (parsed.success) return { stored: parsed.data, damaged: null };
  const damaged = damagedOf(json);
  return { stored: { version: damaged.version, connection: null }, damaged };
}

export type ConnectionOptions = {
  client: OAuthClient | null;
  store: GoogleRowStore;
  fetch?: FetchLike;
  now?: () => number;
};

export class GoogleConnection {
  readonly #client: OAuthClient | null;
  readonly #store: GoogleRowStore;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #flows: PendingFlows;
  // The access token and the refresh in progress, each tagged with the
  // identity of the connection it belongs to (review round 1, finding 1).
  #access: { token: string; expiresAt: number; identity: string } | null = null;
  #refreshing: { identity: string; promise: Promise<string> } | null = null;

  constructor(options: ConnectionOptions) {
    this.#client = options.client;
    this.#store = options.store;
    // Looked up at call time, so a test's replacement of fetch applies.
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#flows = new PendingFlows(this.#now);
  }

  get configured(): boolean {
    return this.#client !== null;
  }

  // A connect started in this process and not finished or expired. Its
  // state lives only in memory (oauth.ts), so the workspace cache keeps
  // this connection open while it is true.
  hasPendingFlow(): boolean {
    return this.#flows.size > 0;
  }

  // The stored state. A damaged row reads as no connection at its own
  // version, with `damaged` set.
  #state(): State {
    return parseState(this.#store.readRow("google"));
  }

  #read(): Stored {
    return this.#state().stored;
  }

  // One transaction: reads the row, applies `change` and writes its result.
  // A change that returns null writes nothing. A change that throws writes
  // nothing either.
  #mutate(change: (state: State) => Stored | null): void {
    this.#store.updateRow("google", (current) => {
      const next = change(parseState(current));
      return next === null ? null : JSON.stringify(Stored.parse({ version: next.version, connection: next.connection }));
    });
  }

  status(): GoogleStatus {
    const { stored, damaged } = this.#state();
    const { version, connection: c } = stored;
    const features = grantedFeatures(c?.scopes.join(" "));
    return {
      connected: this.configured && c !== null && !c.needsReconnect,
      email: c?.email ?? null,
      gmail: c !== null && features.gmail,
      calendar: c !== null && features.calendar,
      calendarId: c?.calendarId ?? null,
      configured: this.configured,
      needsReconnect: damaged !== null || (c?.needsReconnect ?? false),
      version,
    };
  }

  #requireClient(): OAuthClient {
    if (!this.#client) throw new GoogleError("google_not_configured");
    return this.#client;
  }

  #checkVersion(expectedVersion: number) {
    if (this.#read().version !== expectedVersion) throw new GoogleError("google_stale");
  }

  // POST /api/google/connect. Returns the URL the page opens and the value
  // of the cookie that binds the flow to this browser.
  startConnect(input: { expectedVersion: number; features: Features; calendarId: string; redirectUri: string }): { authorizeUrl: string; cookie: string } {
    const client = this.#requireClient();
    this.#checkVersion(input.expectedVersion);
    const { verifier, challenge } = pkcePair();
    const flow = {
      verifier,
      nonce: newNonce(),
      redirectUri: input.redirectUri,
      features: input.features,
      calendarId: input.calendarId,
      version: input.expectedVersion,
    };
    const { state, cookie } = this.#flows.start(flow);
    return { authorizeUrl: authorizeUrl(client, flow, state, challenge), cookie };
  }

  // The callback. Checks the state and the browser cookie, exchanges the
  // code, checks the ID token and stores the connection. Throws an
  // OAuthError with a fixed code.
  async finishConnect(input: { state: string | null; code: string | null; error: string | null; cookie: string | null | ((secure: boolean) => string | null) }): Promise<void> {
    const client = this.#requireClient();
    const flow = this.#flows.take(input.state, input.cookie);
    if (!flow) throw new OAuthError("invalid_state");
    // A flow started before a connect or a disconnect cannot finish after
    // it (review round 1, finding 2).
    if (flow.version !== this.#read().version) throw new OAuthError("stale_flow");
    if (input.error !== null) throw new OAuthError(input.error === "access_denied" ? "access_denied" : "google_error");
    if (!input.code || input.code.length > 2048) throw new OAuthError("no_code");
    let answer;
    try {
      answer = await exchangeCode(this.#fetch, client, input.code, flow);
    } catch (err) {
      if (err instanceof GoogleError) throw new OAuthError(err.code === "google_unavailable" ? "google_unavailable" : "code_exchange_failed");
      throw err;
    }
    // A failed check below revokes the new grant, so no token is left at
    // Google that the app does not hold.
    const drop = async (code: string): Promise<never> => {
      await revokeToken(this.#fetch, answer.refresh_token ?? answer.access_token);
      throw new OAuthError(code);
    };
    if (!answer.id_token) return drop("no_id_token");
    let account: { sub: string; email: string };
    try {
      account = checkIdToken(answer.id_token, { clientId: client.clientId, nonce: flow.nonce, now: this.#now() });
    } catch (err) {
      if (err instanceof OAuthError) return drop(err.code);
      throw err;
    }
    const granted = grantedFeatures(answer.scope);
    if (!granted.gmail && !granted.calendar) return drop("no_permission_granted");
    if (!answer.refresh_token) return drop("no_refresh_token");

    const refreshToken = answer.refresh_token;
    // The version check and the write are one transaction. A connect or a
    // disconnect that finished while Google answered makes the flow stale.
    let stale: Stored | null = null;
    let replaced: Connection | null = null;
    this.#mutate(({ stored }) => {
      if (stored.version !== flow.version) {
        stale = stored;
        return null;
      }
      replaced = stored.connection;
      return {
        version: stored.version + 1,
        connection: {
          sub: account.sub,
          email: account.email,
          scopes: (answer.scope ?? "").split(/\s+/).filter(Boolean).slice(0, 20),
          calendarId: flow.calendarId,
          refreshToken,
          needsReconnect: false,
          connectedAt: new Date(this.#now()).toISOString(),
          accessToken: answer.access_token,
          accessExpiresAt: this.#now() + answer.expires_in * 1000,
        },
      };
    });
    if (stale !== null) {
      // The new grant is revoked, unless the connection now stored is the
      // same account, whose grant the revoke would end too.
      if ((stale as Stored).connection?.sub === account.sub) throw new OAuthError("stale_flow");
      return drop("stale_flow");
    }
    // A different account's grant is revoked. The same account's old token
    // is not, because revoking it would revoke the new grant too.
    const old = replaced as Connection | null;
    if (old && old.sub !== account.sub) await revokeToken(this.#fetch, old.refreshToken);
    this.#access = { token: answer.access_token, expiresAt: this.#now() + answer.expires_in * 1000, identity: identityOf(account.sub, answer.refresh_token) };
  }

  // POST /api/google/disconnect. Revokes the grant at Google and deletes the
  // token here, even when Google could not be reached.
  async disconnect(expectedVersion: number): Promise<{ revoked: boolean }> {
    // The version check and the delete are one transaction. A damaged row
    // is replaced too, and its token revoked when it could be read.
    let token: string | null = null;
    let had = false;
    this.#mutate(({ stored, damaged }) => {
      if (stored.version !== expectedVersion) throw new GoogleError("google_stale");
      had = damaged !== null || stored.connection !== null;
      if (!had) return null;
      token = damaged ? damaged.refreshToken : stored.connection!.refreshToken;
      return { version: stored.version + 1, connection: null };
    });
    this.#access = null;
    // A Google sign-in still open in a browser cannot connect again.
    this.#flows.clear();
    if (!had || token === null) return { revoked: false };
    return { revoked: await revokeToken(this.#fetch, token) };
  }

  #connection(feature: Feature): Connection {
    if (!this.#client) throw new GoogleError("google_not_configured");
    const { stored, damaged } = this.#state();
    if (damaged) throw new GoogleError("google_reconnect_needed");
    const c = stored.connection;
    if (!c) throw new GoogleError("google_not_connected");
    if (c.needsReconnect) throw new GoogleError("google_reconnect_needed");
    if (!grantedFeatures(c.scopes.join(" "))[feature]) throw new GoogleError("google_scope_missing");
    return c;
  }

  // Marks the connection as needing a reconnect, only if it is still the
  // one whose refresh failed.
  #markReconnect(identity: string) {
    if (this.#access?.identity === identity) this.#access = null;
    this.#mutate(({ stored: s }) => {
      if (!s.connection || identityOf(s.connection.sub, s.connection.refreshToken) !== identity || s.connection.needsReconnect) return null;
      return { version: s.version + 1, connection: { ...s.connection, needsReconnect: true } };
    });
  }

  // The stored access token of the connection `identity` names, when it is
  // still good for a minute.
  #storedAccess(identity: string): string | null {
    const c = this.#read().connection;
    if (!c || identityOf(c.sub, c.refreshToken) !== identity || !c.accessToken || !c.accessExpiresAt) return null;
    if (c.accessExpiresAt - REFRESH_EARLY_MS <= this.#now()) return null;
    this.#access = { token: c.accessToken, expiresAt: c.accessExpiresAt, identity };
    return c.accessToken;
  }

  async #token(c: Connection, force = false): Promise<string> {
    const identity = identityOf(c.sub, c.refreshToken);
    const cached = this.#access;
    if (!force && cached && cached.identity === identity && cached.expiresAt - REFRESH_EARLY_MS > this.#now()) return cached.token;
    // One refresh at a time per connection in this process. A refresh for a
    // connection that was replaced meanwhile is not reused.
    if (this.#refreshing?.identity === identity) return this.#refreshing.promise;
    const rejected = force ? (cached?.token ?? null) : null;
    // Review round 3, finding 7: across processes a refresh holds the
    // google_refresh lease. A holder that waited reads the row first: when
    // the other holder refreshed already, its access token (or its rotated
    // refresh token) is used, so the same refresh token is never sent twice.
    const run = async (): Promise<string> => {
      const stored = this.#read().connection;
      if (!stored || stored.sub !== c.sub) throw new GoogleError("google_stale");
      const current = identityOf(stored.sub, stored.refreshToken);
      if (stored.accessToken && stored.accessToken !== rejected && stored.accessExpiresAt && stored.accessExpiresAt - REFRESH_EARLY_MS > this.#now()) {
        const fresh = this.#storedAccess(current);
        if (fresh) return fresh;
      }
      let answer;
      try {
        answer = await refreshAccess(this.#fetch, this.#client!, stored.refreshToken);
      } catch (err) {
        if (err instanceof GoogleError && err.code === "google_reconnect_needed") this.#markReconnect(current);
        throw err;
      }
      const rotated = answer.refresh_token ?? stored.refreshToken;
      const expiresAt = this.#now() + answer.expires_in * 1000;
      // The identity check and the write are one transaction. A refresh for
      // a connection replaced meanwhile is used for this one call and
      // dropped (review round 1, finding 1). One that succeeded for the
      // same connection clears a reconnect mark set while it ran.
      let kept = false;
      this.#mutate(({ stored: s }) => {
        kept = s.connection !== null && identityOf(s.connection.sub, s.connection.refreshToken) === current;
        if (!kept) return null;
        return {
          version: s.connection!.needsReconnect ? s.version + 1 : s.version,
          connection: {
            ...s.connection!,
            refreshToken: rotated,
            needsReconnect: false,
            accessToken: answer.access_token,
            accessExpiresAt: expiresAt,
            ...(answer.scope ? { scopes: answer.scope.split(/\s+/).filter(Boolean).slice(0, 20) } : {}),
          },
        };
      });
      if (kept) this.#access = { token: answer.access_token, expiresAt, identity: identityOf(c.sub, rotated) };
      return answer.access_token;
    };
    const entry: { identity: string; promise: Promise<string> } = { identity, promise: Promise.resolve("") };
    entry.promise = (async () => {
      try {
        if (!this.#store.withLease) return await run();
        return await this.#store.withLease("google_refresh", run, {
          skip: () => {
            const c2 = this.#read().connection;
            if (!c2 || c2.sub !== c.sub || c2.accessToken === rejected) return undefined;
            return this.#storedAccess(identityOf(c2.sub, c2.refreshToken)) ?? undefined;
          },
        });
      } finally {
        if (this.#refreshing === entry) this.#refreshing = null;
      }
    })();
    this.#refreshing = entry;
    return entry.promise;
  }

  // A call to a Google API that needs `feature`. A 401 refreshes the token
  // once and tries again. A second 401 marks the connection as needing a
  // reconnect.
  async call(feature: Feature, url: string, init: RequestInit = {}): Promise<GoogleResponse> {
    const c = this.#connection(feature);
    const send = async (token: string) =>
      callGoogle(this.#fetch, url, { ...init, headers: { Accept: "application/json", ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } });
    let res = await send(await this.#token(c));
    if (res.status === 401) {
      res = await send(await this.#token(c, true));
      if (res.status === 401) {
        this.#markReconnect(identityOf(c.sub, c.refreshToken));
        throw new GoogleError("google_reconnect_needed", 401);
      }
    }
    return res;
  }

  // The account of a usable Gmail connection, or null (0018, fix round 1,
  // R1).
  gmailAccount(): string | null {
    try {
      return this.#connection("gmail").sub;
    } catch (err) {
      if (err instanceof GoogleError) return null;
      throw err;
    }
  }

  // `sub|calendarId` of a usable calendar connection, or null.
  accountKey(): string | null {
    try {
      const c = this.#connection("calendar");
      return `${c.sub}|${c.calendarId}`;
    } catch (err) {
      if (err instanceof GoogleError) return null;
      throw err;
    }
  }

  // The calendar the person chose, the account it belongs to, and the key
  // of the two that undo records carry.
  calendar(): { calendarId: string; sub: string; key: string } {
    const c = this.#connection("calendar");
    return { calendarId: c.calendarId, sub: c.sub, key: `${c.sub}|${c.calendarId}` };
  }
}

// The account and the refresh token a cached token or a refresh belongs
// to. A hash, so the token itself is not kept twice.
function identityOf(sub: string, refreshToken: string): string {
  return `${sub}|${createHash("sha256").update(refreshToken).digest("hex")}`;
}

export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthClient | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
