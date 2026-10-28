// Sign in with ChatGPT for an open-source, locally hosted app (0010,
// design items 3 and 4), following OpenAI's token-sharing guide for
// open-source apps:
//
// 1. The host id. A `urn:uuid:` UUIDv4, made once before the first sign-in
//    and kept in the secrets file through sign-out.
// 2. Authorization. A fresh state, nonce and PKCE verifier for every
//    attempt, kept in memory only, used once and dropped after ten minutes.
//    A first sign-in sends client_id=dynamic_agent_client with
//    agent_name_hint and ext_agent_host_id. A later one sends the issued
//    client id and ext_agent_host_id, without agent_name_hint.
// 3. The callback, on this app's own loopback address. It checks state
//    before anything else, stops on an OAuth error, takes the issued client
//    id from a new registration (and refuses a different one on a returning
//    sign-in), then exchanges the code with the verifier, the same redirect
//    URI and the resource. The issued id stays with the attempt and is
//    saved only after the exchange and the ID token check succeed with it.
// 4. The ID token (oidc.ts), the same account on a returning sign-in, and
//    the granted scopes. Model calls need chatgpt.tokens.use.direct.
// 5. The tokens, saved with the issued client id in the secrets file.
//
// Refresh happens before expiry and once on a 401 from the Responses API.
// Refresh and sign-out hold the session lease (secrets.ts) while they call
// OpenAI, so they never overlap, in this process or across processes.
// Sign-in completion is one compare-and-swap transaction. A refresh stores
// its result only if it still holds the lease and the session it refreshed
// is still the stored one. A refresh the token
// endpoint refuses for good signs the user out. A network failure keeps
// the tokens.
//
// No token, code, verifier or ID token is logged, put in an error message
// or returned to the browser. The authorize URL holds none of them: it
// carries the PKCE challenge, never the verifier, and no id_token_hint.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { IdentityError, OpenAiIdentity, type FetchLike, type VerifiedIdentity } from "./oidc.ts";
import type { ChatGptModel, ChatGptSession, Lease, SecretsStore, StoredSettings } from "./secrets.ts";

export const RESOURCE = "https://api.openai.com/v1";
export const MODELS_URL = `${RESOURCE}/models`;
export const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
// The app's name, the same on every installation.
export const AGENT_NAME = "Appointment change assistant";
// The loopback callback path. The guide's example path, which must stay the
// same from the first registration on: only the port may change.
export const CALLBACK_PATH = "/auth/callback";
export const ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
// Refresh this long before the access token expires.
export const REFRESH_MARGIN_MS = 2 * 60_000;
// The lease refresh and sign-out hold (secrets.ts).
export const SESSION_LEASE = "chatgpt_session";

// Refresh error codes that mean the refresh token cannot be used again
// (errors-and-recovery, Refresh errors).
const TERMINAL_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
]);

const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export type CallbackCode =
  | "state_mismatch"
  | "expired"
  | "access_denied"
  | "authorization_failed"
  | "registration_incomplete"
  | "client_mismatch"
  | "exchange_failed"
  | "identity_unavailable"
  | "identity_invalid"
  | "account_mismatch";

export type CallbackResult = { ok: true; planUsage: boolean } | { ok: false; code: CallbackCode };

// Why a model call cannot get an access token.
export class ChatGptAuthError extends Error {
  override name = "ChatGptAuthError";
  readonly kind: "signed_out" | "plan_usage_off" | "session_ended" | "unavailable";
  constructor(kind: "signed_out" | "plan_usage_off" | "session_ended" | "unavailable") {
    super(`ChatGPT sign-in: ${kind}.`);
    this.kind = kind;
  }
}

type Attempt = { nonce: string; verifier: string; clientId: string; redirectUri: string; createdAt: number };

const random = () => randomBytes(32).toString("base64url");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

type TokenResponse = Record<string, unknown>;

function epochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function oauthCode(json: unknown): string | null {
  const o = (json ?? {}) as Record<string, unknown>;
  const code = typeof o.error === "string" ? o.error : typeof (o.error as Record<string, unknown> | undefined)?.code === "string" ? (o.error as { code: string }).code : null;
  return code && /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : null;
}

export class ChatGptAuth {
  readonly #store: SecretsStore;
  readonly #identity: OpenAiIdentity;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #redirectUri: string;
  readonly #attempts = new Map<string, Attempt>();
  #refreshing: Promise<string> | null = null;

  constructor(options: { store: SecretsStore; port: number; fetch?: FetchLike; now?: () => number; identity?: OpenAiIdentity }) {
    this.#store = options.store;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#identity = options.identity ?? new OpenAiIdentity({ fetch: this.#fetch, now: this.#now });
    // 127.0.0.1, never localhost, as the guide says.
    this.#redirectUri = `http://127.0.0.1:${options.port}${CALLBACK_PATH}`;
  }

  get redirectUri(): string {
    return this.#redirectUri;
  }

  // Starts one sign-in attempt and returns the URL the page opens.
  async start(): Promise<{ authorizeUrl: string }> {
    const { authorization_endpoint } = await this.#identity.discovery();
    // The host id is chosen and saved before the first sign-in.
    let settings = this.#store.read();
    if (!settings.chatgpt.hostId) {
      settings = this.#store.update((s) => ({ ...s, chatgpt: { ...s.chatgpt, hostId: `urn:uuid:${randomUUID()}` } }), { bump: false });
    }
    const { hostId, clientId: issued, account, session } = settings.chatgpt;
    const state = random();
    const nonce = random();
    const verifier = random();
    const clientId = issued ?? DYNAMIC_CLIENT_ID;
    const url = new URL(authorization_endpoint);
    const params: Array<[string, string]> = [
      ["client_id", clientId],
      ["response_type", "code"],
      ["redirect_uri", this.#redirectUri],
      ["scope", SCOPES],
      ["resource", RESOURCE],
      ["state", state],
      ["nonce", nonce],
      ["code_challenge", pkceChallenge(verifier)],
      ["code_challenge_method", "S256"],
      ["ext_agent_host_id", hostId!],
    ];
    if (!issued) params.push(["agent_name_hint", AGENT_NAME]);
    if (issued && account?.email) params.push(["login_hint", account.email]);
    // Asking again after plan usage was declined (errors-and-recovery).
    if (issued && session && !session.scopes.includes(PLAN_USAGE_SCOPE)) params.push(["prompt", "consent"]);
    for (const [k, v] of params) url.searchParams.set(k, v);
    this.#prune();
    if (this.#attempts.size >= MAX_ATTEMPTS) this.#attempts.delete(this.#attempts.keys().next().value!);
    this.#attempts.set(state, { nonce, verifier, clientId, redirectUri: this.#redirectUri, createdAt: this.#now() });
    return { authorizeUrl: url.toString() };
  }

  #prune() {
    const now = this.#now();
    for (const [state, a] of this.#attempts) if (now - a.createdAt > ATTEMPT_TTL_MS) this.#attempts.delete(state);
  }

  // Handles the browser's return to the loopback callback.
  async callback(query: URLSearchParams): Promise<CallbackResult> {
    const state = query.get("state");
    const attempt = state ? this.#attempts.get(state) : undefined;
    if (!state || !attempt) return { ok: false, code: "state_mismatch" };
    // One use only, whatever the outcome.
    this.#attempts.delete(state);
    if (this.#now() - attempt.createdAt > ATTEMPT_TTL_MS) return { ok: false, code: "expired" };
    const error = query.get("error");
    if (error !== null) return { ok: false, code: error === "access_denied" ? "access_denied" : "authorization_failed" };
    const code = query.get("code");
    if (!code) return { ok: false, code: "authorization_failed" };
    const returned = query.get("client_id");
    let clientId = attempt.clientId;
    const registering = attempt.clientId === DYNAMIC_CLIENT_ID;
    if (registering) {
      if (!returned || returned === DYNAMIC_CLIENT_ID || !CLIENT_ID.test(returned)) return { ok: false, code: "registration_incomplete" };
      // Kept with this attempt only. It is saved after the exchange and the
      // ID token check succeed with it, so a tampered callback saves nothing.
      clientId = returned;
    } else if (returned !== null && returned !== attempt.clientId) {
      return { ok: false, code: "client_mismatch" };
    }

    const exchanged = await this.#token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      resource: RESOURCE,
    });
    if (!exchanged.ok) return { ok: false, code: "exchange_failed" };
    const data = exchanged.json;

    let identity: VerifiedIdentity;
    try {
      identity = await this.#identity.verifyIdToken(data.id_token, { clientId, nonce: attempt.nonce });
    } catch (err) {
      return { ok: false, code: err instanceof IdentityError && err.kind === "unavailable" ? "identity_unavailable" : "identity_invalid" };
    }
    const session = this.#session(data, null);
    if (!session) return { ok: false, code: "exchange_failed" };
    const planUsage = session.scopes.includes(PLAN_USAGE_SCOPE);
    const models = planUsage ? await this.listModels(session.accessToken).catch(() => null) : null;

    // One transaction checks and writes, so of two registrations finishing
    // at once, in any process, exactly one is saved.
    let result: CallbackResult = { ok: true, planUsage };
    this.#store.update(
      (s) => {
        // Another registration finished first: keep it, refuse this one.
        if (s.chatgpt.clientId !== null && s.chatgpt.clientId !== clientId) {
          result = { ok: false, code: "client_mismatch" };
          return null;
        }
        if (s.chatgpt.account && s.chatgpt.account.subject !== identity.subject) {
          result = { ok: false, code: "account_mismatch" };
          return null;
        }
        return {
          ...s,
          // Signing in chooses ChatGPT only when no provider was chosen yet.
          provider: s.provider ?? "chatgpt",
          chatgpt: { ...s.chatgpt, clientId, account: { ...identity }, session, models: models ?? s.chatgpt.models },
        };
      },
      { bump: true },
    );
    return result;
  }

  // The token set from a token response, or null when it is incomplete.
  #session(data: TokenResponse, previous: ChatGptSession | null): ChatGptSession | null {
    const scope = typeof data.scope === "string" ? data.scope : previous ? previous.scopes.join(" ") : null;
    if (scope === null) return null;
    const scopes = scope.split(/\s+/).filter(Boolean);
    if (typeof data.access_token !== "string" || data.access_token === "") return null;
    if (typeof data.expires_in !== "number" || !(data.expires_in > 0)) return null;
    if (data.token_type !== undefined && (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer")) return null;
    const refresh = typeof data.refresh_token === "string" && data.refresh_token !== "" ? data.refresh_token : null;
    if (scopes.includes("offline_access") && refresh === null) return null;
    const now = this.#now();
    return {
      id: previous?.id ?? randomUUID(),
      accessToken: data.access_token,
      refreshToken: refresh,
      expiresAt: now + Math.round(data.expires_in * 1000),
      earliestRefreshAt: epochMs(data.earliest_refresh_at),
      scopes,
      savedAt: new Date(now).toISOString(),
    };
  }

  async #token(form: Record<string, string>): Promise<{ ok: true; json: TokenResponse } | { ok: false; status: number | null; code: string | null }> {
    const { token_endpoint } = await this.#identity.discovery();
    let res: Response;
    try {
      res = await this.#fetch(token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return { ok: false, status: null, code: null };
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.status !== 200 || !json || typeof json !== "object") return { ok: false, status: res.status, code: oauthCode(json) };
    return { ok: true, json: json as TokenResponse };
  }

  // A usable access token for a model call. `rejected` is a token the
  // Responses API just refused with a 401: it is refreshed unless another
  // call already did.
  async accessToken(options: { rejected?: string } = {}): Promise<string> {
    const { chatgpt } = this.#store.read();
    const session = chatgpt.session;
    if (!session || !chatgpt.clientId) throw new ChatGptAuthError("signed_out");
    if (!session.scopes.includes(PLAN_USAGE_SCOPE)) throw new ChatGptAuthError("plan_usage_off");
    const now = this.#now();
    if (options.rejected === undefined) {
      const nearExpiry = now >= session.expiresAt - REFRESH_MARGIN_MS;
      // The token endpoint's earliest_refresh_at holds a refresh back while
      // the token still works.
      const tooEarly = session.earliestRefreshAt !== null && now < session.earliestRefreshAt && now < session.expiresAt;
      if (!nearExpiry || tooEarly) return session.accessToken;
    }
    return this.#refresh(options.rejected ?? session.accessToken);
  }

  // One refresh at a time. A call that waited on another's refresh uses
  // its result.
  #refresh(stale: string): Promise<string> {
    this.#refreshing ??= this.#doRefresh(stale).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  // A usable token another holder stored, or undefined.
  #fresh(stale: string): string | undefined {
    const session = this.#store.read().chatgpt.session;
    if (!session || session.accessToken === stale || session.expiresAt - REFRESH_MARGIN_MS <= this.#now()) return undefined;
    return session.scopes.includes(PLAN_USAGE_SCOPE) ? session.accessToken : undefined;
  }

  // Holds the session lease. A process that finds another's live lease
  // waits and reads again, and uses that holder's refresh when it lands.
  #doRefresh(stale: string): Promise<string> {
    return this.#store.withLease(SESSION_LEASE, (lease) => this.#refreshHeld(stale, lease), { skip: () => this.#fresh(stale) });
  }

  async #refreshHeld(stale: string, lease: Lease): Promise<string> {
    // Read again holding the lease: another process, such as the eval, may
    // have refreshed already.
    const { chatgpt } = this.#store.read();
    const session = chatgpt.session;
    if (!session || !chatgpt.clientId) throw new ChatGptAuthError("signed_out");
    if (session.accessToken !== stale && session.expiresAt - REFRESH_MARGIN_MS > this.#now()) {
      if (!session.scopes.includes(PLAN_USAGE_SCOPE)) throw new ChatGptAuthError("plan_usage_off");
      return session.accessToken;
    }
    if (!session.refreshToken) {
      this.#endSession(session);
      throw new ChatGptAuthError("session_ended");
    }
    const result = await this.#token({
      grant_type: "refresh_token",
      client_id: chatgpt.clientId,
      refresh_token: session.refreshToken,
      resource: RESOURCE,
    });
    if (!result.ok) {
      const terminal = (result.status === 400 || result.status === 401) && result.code !== null && TERMINAL_REFRESH_CODES.has(result.code);
      if (terminal) {
        this.#endSession(session);
        throw new ChatGptAuthError("session_ended");
      }
      throw new ChatGptAuthError("unavailable");
    }
    const next = this.#session(result.json, session);
    if (!next) throw new ChatGptAuthError("unavailable");
    // A refresh that returns an ID token must name the same account.
    if (result.json.id_token !== undefined) {
      try {
        const identity = await this.#identity.verifyIdToken(result.json.id_token, { clientId: chatgpt.clientId, nonce: null });
        if (chatgpt.account && identity.subject !== chatgpt.account.subject) {
          this.#endSession(session);
          throw new ChatGptAuthError("session_ended");
        }
      } catch (err) {
        if (err instanceof ChatGptAuthError) throw err;
        if (err instanceof IdentityError && err.kind === "unavailable") throw new ChatGptAuthError("unavailable");
        this.#endSession(session);
        throw new ChatGptAuthError("session_ended");
      }
    }
    // The access token, expiry, scopes and rotated refresh token together,
    // in one transaction that checks the lease is still this holder's and
    // the stored session is still the one refreshed. A refresh without plan
    // usage counts as a visible change.
    const planUsage = next.scopes.includes(PLAN_USAGE_SCOPE);
    let stored = false;
    this.#store.update(
      (s, tx) => {
        const now = s.chatgpt.session;
        if (!tx.holds(lease) || !now || now.id !== session.id || now.refreshToken !== session.refreshToken) return null;
        stored = true;
        return { ...s, chatgpt: { ...s.chatgpt, session: next } };
      },
      { bump: !planUsage },
    );
    if (!stored) {
      // The lease ran out or the session was signed out or replaced. The
      // new refresh token is not kept, so it is revoked.
      if (next.refreshToken) await this.#revoke(next.refreshToken, chatgpt.clientId);
      const other = this.#fresh(stale);
      if (other !== undefined) return other;
      throw new ChatGptAuthError("signed_out");
    }
    // A refresh can grant fewer scopes. Without plan usage the token is not
    // used for this call either.
    if (!planUsage) throw new ChatGptAuthError("plan_usage_off");
    return next.accessToken;
  }

  // Clears the tokens and keeps the registration: the host id, the issued
  // client id and the account, for a later sign-in. Only if `session` is
  // still the stored one, so a newer sign-in is never cleared.
  #endSession(session: ChatGptSession): boolean {
    let cleared = false;
    this.#store.update(
      (s) => {
        const now = s.chatgpt.session;
        if (!now || now.id !== session.id || now.refreshToken !== session.refreshToken) return null;
        cleared = true;
        return { ...s, chatgpt: { ...s.chatgpt, session: null } };
      },
      { bump: true },
    );
    return cleared;
  }

  // Signs out: revokes the refresh token, then clears the tokens. Returns
  // whether OpenAI confirmed the revocation. Holds the session lease, so a
  // refresh in flight finishes first and its new refresh token is the one
  // revoked. `onlyIf`, checked on the settings first, can refuse it:
  // nothing is revoked or cleared, and `refused` is true.
  signOut(options: { onlyIf?: (settings: StoredSettings) => boolean } = {}): Promise<{ revoked: boolean; refused: boolean }> {
    return this.#store.withLease(SESSION_LEASE, async () => {
      const settings = this.#store.read();
      if (options.onlyIf && !options.onlyIf(settings)) return { revoked: false, refused: true };
      const { chatgpt } = settings;
      const session = chatgpt.session;
      if (!session) return { revoked: true, refused: false };
      const revoked = session.refreshToken && chatgpt.clientId ? await this.#revoke(session.refreshToken, chatgpt.clientId) : false;
      this.#endSession(session);
      return { revoked, refused: false };
    });
  }

  // Revokes a refresh token at the discovered endpoint, with one retry on
  // a network failure or a 5xx. True when OpenAI confirmed it.
  async #revoke(refreshToken: string, clientId: string): Promise<boolean> {
    let revocation: string | null;
    try {
      revocation = (await this.#identity.discovery()).revocation_endpoint;
    } catch {
      return false;
    }
    if (!revocation) return false;
    const form = new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: clientId }).toString();
    for (let i = 0; i < 2; i++) {
      try {
        const res = await this.#fetch(revocation, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        await res.body?.cancel();
        if (res.status === 200) return true;
        if (res.status < 500) return false;
      } catch {
        // Retried once.
      }
    }
    return false;
  }

  // The models listed for display for this connection, in the server's
  // order (models-and-inference, step 1).
  async listModels(accessToken: string): Promise<ChatGptModel[]> {
    const res = await this.#fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`The model listing returned HTTP ${res.status}.`);
    }
    const body = (await res.json()) as { models?: unknown };
    if (!Array.isArray(body?.models)) throw new Error("The model listing had no models array.");
    const out: ChatGptModel[] = [];
    for (const m of body.models as Array<Record<string, unknown>>) {
      if (!m || m.visibility !== "list") continue;
      if (typeof m.slug !== "string" || !m.slug.trim() || m.slug.length > 200) continue;
      const displayName = typeof m.display_name === "string" && m.display_name.trim() && m.display_name.length <= 200 ? m.display_name : m.slug;
      out.push({ slug: m.slug, displayName });
    }
    return out;
  }

  // What the settings page shows. No token, id or key.
  // Review round 1, finding 1: whether a call could go out on the stored
  // connection, read without the network. Signed in, with plan usage
  // granted, and an access token still valid or a refresh token to renew
  // it. The kind names what is missing, as the client's own errors do.
  static unavailable(settings: StoredSettings, now: number): "signed_out" | "plan_usage_off" | "session_ended" | null {
    const { session, account, clientId } = settings.chatgpt;
    if (!session || !account || !clientId) return "signed_out";
    if (!session.scopes.includes(PLAN_USAGE_SCOPE)) return "plan_usage_off";
    if (now >= session.expiresAt && !session.refreshToken) return "session_ended";
    return null;
  }

  // The clock this connection reads, for the readiness check.
  now(): number {
    return this.#now();
  }

  static view(settings: StoredSettings): { signedIn: boolean; name: string | null; email: string | null; planUsage: boolean } {
    const { session, account } = settings.chatgpt;
    const signedIn = session !== null && account !== null;
    return {
      signedIn,
      name: signedIn ? account!.name : null,
      email: signedIn ? account!.email : null,
      planUsage: signedIn && session!.scopes.includes(PLAN_USAGE_SCOPE),
    };
  }
}
