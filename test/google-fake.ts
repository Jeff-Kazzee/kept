// An offline fake of the Google endpoints the app calls: the OAuth
// authorization, token and revoke endpoints, Gmail messages.list and
// messages.get, and Calendar events list, get, insert, patch and delete with
// ETags. It follows the behavior the Google reference pages describe, as far
// as the app relies on it. Tests pass `fake.fetch` to the connection, so the
// global fetch stays blocked.
import { createHash } from "node:crypto";
import type { FetchLike } from "../src/google/http.ts";
import { CALENDAR_SCOPE, GMAIL_SCOPE } from "../src/google/oauth.ts";

export const FAKE_CLIENT = { clientId: "demo-client.apps.googleusercontent.com", clientSecret: "demo-client-secret" };
export const FAKE_ACCOUNT = { sub: "1000001", email: "dana.demo@example.com" };

type Code = { challenge: string; method: string; redirectUri: string; scope: string; nonce: string; used: boolean };
type Grant = { scope: string; revoked: boolean };
type Access = { scope: string; expiresAt: number; refresh: string };
export type FakeEvent = Record<string, unknown> & { id: string; etag: string; status: string };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export type Call = { method: string; url: URL; headers: Record<string, string>; body: string };

export class FakeGoogle {
  now = Date.parse("2026-11-06T17:00:00Z");
  calls: Call[] = [];
  codes = new Map<string, Code>();
  grants = new Map<string, Grant>();
  access = new Map<string, Access>();
  revoked: string[] = [];
  messages = new Map<string, unknown>();
  calendars = new Map<string, Map<string, FakeEvent>>([["primary", new Map()]]);
  #n = 0;

  // Knobs for failure tests.
  grantOnly: string[] | null = null; // the scopes the person leaves checked
  idToken: Record<string, unknown> = {};
  omitIdToken = false;
  omitRefreshToken = false;
  refreshFails: "invalid_grant" | "server" | null = null;
  apiStatus: number | null = null; // the next API call answers this
  reject401Once = false;
  unreachable = false;
  // The next insert is stored at Google, then the answer is lost.
  insertCommitsThenFails = false;
  // A refresh waits for this before it answers.
  refreshGate: Promise<void> | null = null;
  // A refresh answer rotates the refresh token and names this scope.
  refreshRotates: { scope: string } | null = null;
  // GET answers leave out the event's etag.
  omitEtags = false;
  // A patch answer leaves out the event's private properties.
  patchDropsProperties = false;
  // The account the next consent signs in as.
  account = { ...FAKE_ACCOUNT };

  #next(prefix: string) {
    this.#n += 1;
    return `${prefix}-${this.#n}`;
  }

  // The person consents on Google's page. Returns the callback URL Google
  // redirects the browser to.
  consent(authorizeUrl: string, options: { deny?: boolean } = {}): URL {
    const u = new URL(authorizeUrl);
    const p = u.searchParams;
    if (u.origin + u.pathname !== "https://accounts.google.com/o/oauth2/v2/auth") throw new Error("wrong authorization endpoint");
    if (p.get("client_id") !== FAKE_CLIENT.clientId) throw new Error("wrong client");
    const back = new URL(p.get("redirect_uri")!);
    back.searchParams.set("state", p.get("state")!);
    if (options.deny) {
      back.searchParams.set("error", "access_denied");
      return back;
    }
    const requested = p.get("scope")!.split(" ");
    const scope = (this.grantOnly ? requested.filter((s) => ["openid", "email", ...this.grantOnly!].includes(s)) : requested).join(" ");
    const code = this.#next("code");
    this.codes.set(code, { challenge: p.get("code_challenge")!, method: p.get("code_challenge_method")!, redirectUri: p.get("redirect_uri")!, scope, nonce: p.get("nonce")!, used: false });
    back.searchParams.set("code", code);
    return back;
  }

  #tokens(scope: string, nonce: string | null) {
    const refresh = this.#next("fake-refresh");
    const at = this.#next("fake-access");
    this.grants.set(refresh, { scope, revoked: false });
    this.access.set(at, { scope, expiresAt: this.now + 3600_000, refresh });
    const id = {
      iss: "https://accounts.google.com",
      aud: FAKE_CLIENT.clientId,
      sub: this.account.sub,
      email: this.account.email,
      email_verified: true,
      iat: Math.floor(this.now / 1000),
      exp: Math.floor(this.now / 1000) + 3600,
      ...(nonce ? { nonce } : {}),
      ...this.idToken,
    };
    return {
      access_token: at,
      expires_in: 3599,
      token_type: "Bearer",
      scope,
      ...(this.omitRefreshToken ? {} : { refresh_token: refresh }),
      ...(this.omitIdToken ? {} : { id_token: `${b64url({ alg: "RS256" })}.${b64url(id)}.fake-signature` }),
    };
  }

  async #token(form: URLSearchParams): Promise<Response> {
    if (form.get("client_id") !== FAKE_CLIENT.clientId || form.get("client_secret") !== FAKE_CLIENT.clientSecret) return json(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      if (!code || code.used) return json(400, { error: "invalid_grant" });
      code.used = true;
      if (code.redirectUri !== form.get("redirect_uri")) return json(400, { error: "redirect_uri_mismatch" });
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (code.method !== "S256" || challenge !== code.challenge) return json(400, { error: "invalid_grant" });
      return json(200, this.#tokens(code.scope, code.nonce));
    }
    if (form.get("grant_type") === "refresh_token") {
      if (this.refreshGate) await this.refreshGate;
      if (this.refreshFails === "server") return json(503, null);
      const grant = this.grants.get(form.get("refresh_token") ?? "");
      if (!grant || grant.revoked || this.refreshFails === "invalid_grant") return json(400, { error: "invalid_grant" });
      const at = this.#next("fake-access");
      if (this.refreshRotates) {
        const rotated = this.#next("fake-refresh");
        this.grants.set(rotated, { scope: this.refreshRotates.scope, revoked: false });
        this.access.set(at, { scope: this.refreshRotates.scope, expiresAt: this.now + 3600_000, refresh: rotated });
        return json(200, { access_token: at, expires_in: 3599, token_type: "Bearer", scope: this.refreshRotates.scope, refresh_token: rotated });
      }
      this.access.set(at, { scope: grant.scope, expiresAt: this.now + 3600_000, refresh: form.get("refresh_token")! });
      return json(200, { access_token: at, expires_in: 3599, token_type: "Bearer", scope: grant.scope });
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  #revoke(form: URLSearchParams): Response {
    const token = form.get("token") ?? "";
    this.revoked.push(token);
    const grant = this.grants.get(token) ?? this.grants.get(this.access.get(token)?.refresh ?? "");
    if (!grant) return json(400, { error: "invalid_token" });
    grant.revoked = true;
    return json(200, null);
  }

  #authorized(headers: Record<string, string>, scope: string): Response | null {
    const token = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
    const access = token ? this.access.get(token) : undefined;
    if (this.reject401Once) {
      this.reject401Once = false;
      return json(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
    }
    if (!access || access.expiresAt <= this.now || this.grants.get(access.refresh)?.revoked) return json(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
    if (!access.scope.split(" ").includes(scope)) return json(403, { error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] } });
    return null;
  }

  #gmail(method: string, url: URL): Response {
    const path = url.pathname.replace("/gmail/v1/users/me/", "");
    if (method === "GET" && path === "messages") {
      const ids = [...this.messages.keys()].slice(0, Number(url.searchParams.get("maxResults") ?? 100));
      return json(200, ids.length ? { messages: ids.map((id) => ({ id, threadId: id })), resultSizeEstimate: ids.length } : { resultSizeEstimate: 0 });
    }
    const m = /^messages\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const msg = this.messages.get(decodeURIComponent(m[1]!));
      return msg ? json(200, msg) : json(404, { error: { code: 404 } });
    }
    return json(404, { error: { code: 404 } });
  }

  #calendar(method: string, url: URL, headers: Record<string, string>, body: string): Response {
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return json(404, { error: { code: 404 } });
    const cal = this.calendars.get(decodeURIComponent(m[1]!));
    if (!cal) return json(404, { error: { code: 404 } });
    const eventId = m[2] ? decodeURIComponent(m[2]) : null;
    const bump = (e: FakeEvent) => {
      e.etag = `"${this.#next("etag")}"`;
    };
    if (!eventId && method === "GET") {
      let items = [...cal.values()].filter((e) => e.status !== "cancelled" || url.searchParams.get("showDeleted") === "true");
      for (const prop of url.searchParams.getAll("privateExtendedProperty")) {
        const [k, v] = prop.split("=") as [string, string];
        items = items.filter((e) => (e.extendedProperties as { private?: Record<string, string> } | undefined)?.private?.[k] === v);
      }
      const min = url.searchParams.get("timeMin");
      const max = url.searchParams.get("timeMax");
      const startOf = (e: FakeEvent) => {
        const s = e.start as { dateTime?: string; date?: string };
        return Date.parse(s.dateTime ?? `${s.date}T00:00:00Z`);
      };
      if (min) items = items.filter((e) => startOf(e) >= Date.parse(min) - 86_400_000);
      if (max) items = items.filter((e) => startOf(e) < Date.parse(max));
      return json(200, { kind: "calendar#events", timeZone: "America/Denver", items });
    }
    if (!eventId && method === "POST") {
      const sent = JSON.parse(body) as Record<string, unknown>;
      // Google's rule for a client-chosen id: 5 to 1024 characters, a to v
      // and 0 to 9. A taken id, deleted events included, is 409.
      if (sent.id !== undefined && !/^[a-v0-9]{5,1024}$/.test(String(sent.id))) return json(400, { error: { code: 400, errors: [{ reason: "invalid" }] } });
      const id = (sent.id as string | undefined) ?? this.#next("event");
      if (cal.has(id)) return json(409, { error: { code: 409, errors: [{ reason: "duplicate" }] } });
      const e = { ...sent, id, etag: "", status: (sent.status as string | undefined) ?? "confirmed" } as FakeEvent;
      bump(e);
      cal.set(e.id, e);
      if (this.insertCommitsThenFails) {
        this.insertCommitsThenFails = false;
        throw new TypeError("fetch failed");
      }
      return json(200, e);
    }
    const e = eventId ? cal.get(eventId) : undefined;
    if (!e) return json(404, { error: { code: 404 } });
    if (method === "GET") {
      if (!this.omitEtags) return json(200, e);
      const { etag: _etag, ...rest } = e;
      return json(200, rest);
    }
    const ifMatch = headers["if-match"];
    if (ifMatch && ifMatch !== e.etag) return json(412, { error: { code: 412, errors: [{ reason: "conditionNotMet" }] } });
    if (method === "PATCH") {
      for (const [k, v] of Object.entries(JSON.parse(body) as Record<string, unknown>)) {
        if (v === null) delete e[k];
        else if (k === "start" || k === "end") e[k] = Object.fromEntries(Object.entries(v as object).filter(([, x]) => x !== null));
        else e[k] = v;
      }
      bump(e);
      if (this.patchDropsProperties) {
        const { extendedProperties: _p, ...rest } = e;
        return json(200, rest);
      }
      return json(200, e);
    }
    if (method === "DELETE") {
      if (e.status === "cancelled") return json(410, { error: { code: 410 } });
      e.status = "cancelled";
      bump(e);
      return new Response(null, { status: 204 });
    }
    return json(405, null);
  }

  // A Calendar event someone else made, for the "only its own events" tests.
  addForeignEvent(calendarId: string, event: Record<string, unknown>): FakeEvent {
    const e = { status: "confirmed", ...event, id: (event.id as string | undefined) ?? this.#next("foreign"), etag: "" } as FakeEvent;
    e.etag = `"${this.#next("etag")}"`;
    this.calendars.get(calendarId)!.set(e.id, e);
    return e;
  }

  fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === "string" ? init.body : "";
    this.calls.push({ method, url, headers, body });
    if (this.unreachable) throw new TypeError("fetch failed");
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") return this.#token(new URLSearchParams(body));
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/revoke") return this.#revoke(new URLSearchParams(body));
    if (this.apiStatus !== null) {
      const status = this.apiStatus;
      this.apiStatus = null;
      return json(status, { error: { code: status, errors: [{ reason: status === 429 ? "rateLimitExceeded" : "backendError" }] } });
    }
    if (url.origin === "https://gmail.googleapis.com") return this.#authorized(headers, GMAIL_SCOPE) ?? this.#gmail(method, url);
    if (url.origin === "https://www.googleapis.com" && url.pathname.startsWith("/calendar/v3/")) {
      return this.#authorized(headers, CALENDAR_SCOPE) ?? this.#calendar(method, url, headers, body);
    }
    return json(404, null);
  };
}

// A Gmail API message in format=full.
export function gmailMessage(
  id: string,
  options: { from: string; subject: string; date?: string; internalDate: string; plain?: string; html?: string; charset?: string },
) {
  const part = (mimeType: string, text: string) => ({
    mimeType,
    headers: [{ name: "Content-Type", value: `${mimeType}; charset="${options.charset ?? "UTF-8"}"` }],
    body: { size: text.length, data: Buffer.from(text, options.charset === "iso-8859-1" ? "latin1" : "utf8").toString("base64url") },
  });
  const parts = [...(options.plain !== undefined ? [part("text/plain", options.plain)] : []), ...(options.html !== undefined ? [part("text/html", options.html)] : [])];
  return {
    id,
    threadId: id,
    internalDate: options.internalDate,
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: options.from },
        { name: "Subject", value: options.subject },
        ...(options.date ? [{ name: "Date", value: options.date }] : []),
      ],
      body: { size: 0 },
      parts,
    },
  };
}
