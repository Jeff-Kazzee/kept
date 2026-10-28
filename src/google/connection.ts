// The app's one Google connection (0012). It keeps the refresh token in a
// server-side file with mode 600 (secrets.ts) and the access token in
// memory only. It refreshes the access token a minute before it expires. A
// refresh that Google refuses with invalid_grant marks the connection as
// needing a reconnect. Nothing here logs, and no token leaves this module
// except in the Authorization header of a call to Google.
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
import { SecretFile } from "./secrets.ts";

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
  })
  .strict();
type Connection = z.infer<typeof Connection>;

const Stored = z
  .object({
    version: z.number().int().nonnegative(),
    connection: Connection.nullable(),
    // Calendar events this app created: account and calendar, then event id
    // to slot key. Kept after a disconnect, so after a reconnect the app
    // still knows its own events and edits no other.
    createdEvents: z.record(z.string(), z.record(z.string(), z.string())),
  })
  .strict();
type Stored = z.infer<typeof Stored>;

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

export type ConnectionOptions = {
  client: OAuthClient | null;
  file: string;
  fetch?: FetchLike;
  now?: () => number;
};

export class GoogleConnection {
  readonly #client: OAuthClient | null;
  readonly #file: SecretFile<Stored>;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #flows: PendingFlows;
  #access: { token: string; expiresAt: number } | null = null;
  #refreshing: Promise<string> | null = null;

  constructor(options: ConnectionOptions) {
    this.#client = options.client;
    this.#file = new SecretFile(options.file, Stored);
    // Looked up at call time, so a test's replacement of fetch applies.
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#flows = new PendingFlows(this.#now);
  }

  get configured(): boolean {
    return this.#client !== null;
  }

  #read(): Stored {
    return this.#file.read() ?? { version: 0, connection: null, createdEvents: {} };
  }

  #write(next: Stored) {
    this.#file.write(next);
  }

  status(): GoogleStatus {
    const { version, connection: c } = this.#read();
    const features = grantedFeatures(c?.scopes.join(" "));
    return {
      connected: this.configured && c !== null && !c.needsReconnect,
      email: c?.email ?? null,
      gmail: c !== null && features.gmail,
      calendar: c !== null && features.calendar,
      calendarId: c?.calendarId ?? null,
      configured: this.configured,
      needsReconnect: c?.needsReconnect ?? false,
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
    const flow = { verifier, nonce: newNonce(), redirectUri: input.redirectUri, features: input.features, calendarId: input.calendarId };
    const { state, cookie } = this.#flows.start(flow);
    return { authorizeUrl: authorizeUrl(client, flow, state, challenge), cookie };
  }

  // The callback. Checks the state and the browser cookie, exchanges the
  // code, checks the ID token and stores the connection. Throws an
  // OAuthError with a fixed code.
  async finishConnect(input: { state: string | null; code: string | null; error: string | null; cookie: string | null }): Promise<void> {
    const client = this.#requireClient();
    const flow = this.#flows.take(input.state, input.cookie);
    if (!flow) throw new OAuthError("invalid_state");
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

    const before = this.#read();
    // A different account's grant is revoked. The same account's old token
    // is not, because revoking it would revoke the new grant too.
    if (before.connection && before.connection.sub !== account.sub) await revokeToken(this.#fetch, before.connection.refreshToken);
    this.#write({
      ...before,
      version: before.version + 1,
      connection: {
        sub: account.sub,
        email: account.email,
        scopes: (answer.scope ?? "").split(/\s+/).filter(Boolean).slice(0, 20),
        calendarId: flow.calendarId,
        refreshToken: answer.refresh_token,
        needsReconnect: false,
        connectedAt: new Date(this.#now()).toISOString(),
      },
    });
    this.#access = { token: answer.access_token, expiresAt: this.#now() + answer.expires_in * 1000 };
  }

  // POST /api/google/disconnect. Revokes the grant at Google and deletes the
  // token here, even when Google could not be reached.
  async disconnect(expectedVersion: number): Promise<{ revoked: boolean }> {
    this.#checkVersion(expectedVersion);
    const before = this.#read();
    this.#access = null;
    if (!before.connection) return { revoked: false };
    this.#write({ ...before, version: before.version + 1, connection: null });
    return { revoked: await revokeToken(this.#fetch, before.connection.refreshToken) };
  }

  #connection(feature: Feature): Connection {
    if (!this.#client) throw new GoogleError("google_not_configured");
    const c = this.#read().connection;
    if (!c) throw new GoogleError("google_not_connected");
    if (c.needsReconnect) throw new GoogleError("google_reconnect_needed");
    if (!grantedFeatures(c.scopes.join(" "))[feature]) throw new GoogleError("google_scope_missing");
    return c;
  }

  #markReconnect() {
    this.#access = null;
    const s = this.#read();
    if (s.connection && !s.connection.needsReconnect) this.#write({ ...s, version: s.version + 1, connection: { ...s.connection, needsReconnect: true } });
  }

  async #token(c: Connection, force = false): Promise<string> {
    if (!force && this.#access && this.#access.expiresAt - REFRESH_EARLY_MS > this.#now()) return this.#access.token;
    // One refresh at a time.
    this.#refreshing ??= (async () => {
      try {
        const answer = await refreshAccess(this.#fetch, this.#client!, c.refreshToken);
        this.#access = { token: answer.access_token, expiresAt: this.#now() + answer.expires_in * 1000 };
        const s = this.#read();
        if (s.connection && (answer.refresh_token || answer.scope)) {
          this.#write({
            ...s,
            connection: {
              ...s.connection,
              ...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
              ...(answer.scope ? { scopes: answer.scope.split(/\s+/).filter(Boolean).slice(0, 20) } : {}),
            },
          });
        }
        return answer.access_token;
      } catch (err) {
        if (err instanceof GoogleError && err.code === "google_reconnect_needed") this.#markReconnect();
        throw err;
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
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
        this.#markReconnect();
        throw new GoogleError("google_reconnect_needed", 401);
      }
    }
    return res;
  }

  // The calendar the person chose, and the key under which the app keeps
  // the events it created there.
  calendar(): { calendarId: string; key: string } {
    const c = this.#connection("calendar");
    return { calendarId: c.calendarId, key: `${c.sub}|${c.calendarId}` };
  }

  // The slot key of an event this app created, or null.
  createdSlot(key: string, eventId: string): string | null {
    return this.#read().createdEvents[key]?.[eventId] ?? null;
  }

  rememberEvent(key: string, eventId: string, slotKey: string) {
    const s = this.#read();
    this.#write({ ...s, createdEvents: { ...s.createdEvents, [key]: { ...s.createdEvents[key], [eventId]: slotKey } } });
  }

  forgetEvent(key: string, eventId: string) {
    const s = this.#read();
    const events = { ...s.createdEvents[key] };
    delete events[eventId];
    this.#write({ ...s, createdEvents: { ...s.createdEvents, [key]: events } });
  }
}

export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthClient | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
