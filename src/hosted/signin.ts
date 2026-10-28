// Sign in with Google for hosted accounts (0014, design item 3, J16). The
// authorization code flow with PKCE, a single-use `state` bound to the
// browser by an HttpOnly cookie, and a `nonce`, with the scopes `openid
// email profile` only: the account learns the person's name and email,
// nothing else. No refresh token is asked for, and the access token is
// dropped once the ID token is checked.
//
// This flow is apart from the Gmail and Calendar connection (0012), which
// stays per workspace. It reuses that connection's code exchange and ID
// token checks (issuer, audience, expiry, nonce, verified email), and adds
// the signature: the ID token must be signed by one of Google's published
// keys, because it decides who the account is.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import { GoogleError, type FetchLike } from "../google/http.ts";
import { AUTH_URL, OAuthError, checkIdToken, exchangeCode, pkcePair, type Flow, type OAuthClient } from "../google/oauth.ts";

export const SIGNIN_CALLBACK_PATH = "/auth/signin/callback";
export const SIGNIN_SCOPES = ["openid", "email", "profile"];
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const SIGNIN_TTL_MS = 10 * 60_000;
const MAX_PENDING = 2_000;
const KEYS_MIN_MS = 60_000;
const KEYS_DEFAULT_MS = 60 * 60_000;
const KEYS_MAX_MS = 24 * 60 * 60_000;

const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest();

type Pending = { verifier: string; nonce: string; redirectUri: string; cookieHash: Buffer; expiresAt: number };

// Google's signing keys, kept for the response's max-age within bounds.
// An unknown key id loads them again, at most once a minute.
export class GoogleKeys {
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  #keys: Map<string, KeyObject> | null = null;
  #expiresAt = 0;
  #loadedAt = 0;

  constructor(fetchImpl: FetchLike, now: () => number) {
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async #load(): Promise<void> {
    let body: { keys?: unknown };
    let lifetime = KEYS_DEFAULT_MS;
    try {
      const res = await this.#fetch(GOOGLE_JWKS_URL, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (res.status !== 200) throw new Error("status");
      const m = /max-age\s*=\s*(\d+)/i.exec(res.headers.get("cache-control") ?? "");
      if (m) lifetime = Math.min(KEYS_MAX_MS, Math.max(KEYS_MIN_MS, Number(m[1]) * 1000));
      body = (await res.json()) as { keys?: unknown };
    } catch {
      throw new OAuthError("google_unavailable");
    }
    if (!Array.isArray(body?.keys)) throw new OAuthError("google_unavailable");
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys as Array<Record<string, unknown>>) {
      if (!jwk || typeof jwk.kid !== "string" || jwk.kty !== "RSA" || (jwk.alg !== undefined && jwk.alg !== "RS256") || (jwk.use !== undefined && jwk.use !== "sig")) continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }));
      } catch {
        // A key this runtime cannot read is skipped.
      }
    }
    this.#keys = keys;
    this.#loadedAt = this.#now();
    this.#expiresAt = this.#loadedAt + lifetime;
  }

  async key(kid: string): Promise<KeyObject | null> {
    if (!this.#keys || this.#now() >= this.#expiresAt) await this.#load();
    let k = this.#keys!.get(kid);
    if (!k && this.#now() - this.#loadedAt >= KEYS_MIN_MS) {
      await this.#load();
      k = this.#keys!.get(kid);
    }
    return k ?? null;
  }
}

// RS256 only, the key by kid. Throws id_token_signature.
export async function checkSignature(idToken: string, keys: GoogleKeys): Promise<void> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new OAuthError("id_token_invalid");
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new OAuthError("id_token_invalid");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new OAuthError("id_token_signature");
  const key = await keys.key(header.kid);
  if (!key) throw new OAuthError("id_token_signature");
  if (!verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"))) throw new OAuthError("id_token_signature");
}

function nameOf(idToken: string): string | null {
  try {
    const p = JSON.parse(Buffer.from(idToken.split(".")[1]!, "base64url").toString("utf8")) as { name?: unknown };
    return typeof p.name === "string" && p.name.trim() !== "" && p.name.length <= 200 ? p.name.trim() : null;
  } catch {
    return null;
  }
}

export type SignedIn = { sub: string; email: string; name: string | null };

export class GoogleSignIn {
  readonly #client: OAuthClient | null;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #keys: GoogleKeys;
  readonly #flows = new Map<string, Pending>();

  constructor(options: { client: OAuthClient | null; fetch?: FetchLike; now?: () => number }) {
    this.#client = options.client;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#keys = new GoogleKeys(this.#fetch, this.#now);
  }

  get configured(): boolean {
    return this.#client !== null;
  }

  #sweep() {
    const now = this.#now();
    for (const [k, f] of this.#flows) if (f.expiresAt <= now) this.#flows.delete(k);
  }

  // The URL the page opens, and the value of the cookie that binds the
  // flow to this browser. Only the state's and the cookie's hashes are
  // kept, in memory.
  start(redirectUri: string): { authorizeUrl: string; cookie: string } {
    if (!this.#client) throw new GoogleError("google_not_configured");
    this.#sweep();
    while (this.#flows.size >= MAX_PENDING) this.#flows.delete(this.#flows.keys().next().value!);
    const { verifier, challenge } = pkcePair();
    const state = random(32);
    const cookie = random(32);
    const nonce = random(24);
    this.#flows.set(sha256(state).toString("hex"), { verifier, nonce, redirectUri, cookieHash: sha256(cookie), expiresAt: this.#now() + SIGNIN_TTL_MS });
    const url = new URL(AUTH_URL);
    const p = url.searchParams;
    p.set("client_id", this.#client.clientId);
    p.set("redirect_uri", redirectUri);
    p.set("response_type", "code");
    p.set("scope", SIGNIN_SCOPES.join(" "));
    p.set("state", state);
    p.set("nonce", nonce);
    p.set("code_challenge", challenge);
    p.set("code_challenge_method", "S256");
    p.set("prompt", "select_account");
    return { authorizeUrl: url.toString(), cookie };
  }

  // The callback. Throws an OAuthError with a fixed code.
  async finish(input: { state: string | null; code: string | null; error: string | null; cookie: string | null }): Promise<SignedIn> {
    if (!this.#client) throw new OAuthError("google_not_configured");
    this.#sweep();
    if (!input.state || input.state.length > 200) throw new OAuthError("invalid_state");
    const key = sha256(input.state).toString("hex");
    const pending = this.#flows.get(key);
    if (!pending) throw new OAuthError("invalid_state");
    this.#flows.delete(key);
    if (!input.cookie || !timingSafeEqual(sha256(input.cookie), pending.cookieHash)) throw new OAuthError("invalid_state");
    if (input.error !== null) throw new OAuthError(input.error === "access_denied" ? "access_denied" : "google_error");
    if (!input.code || input.code.length > 2048) throw new OAuthError("no_code");
    const flow: Flow = { verifier: pending.verifier, nonce: pending.nonce, redirectUri: pending.redirectUri, features: { gmail: false, calendar: false }, calendarId: "primary", version: 0 };
    let answer;
    try {
      answer = await exchangeCode(this.#fetch, this.#client, input.code, flow);
    } catch (err) {
      if (err instanceof GoogleError) throw new OAuthError(err.code === "google_unavailable" ? "google_unavailable" : "code_exchange_failed");
      throw err;
    }
    if (!answer.id_token) throw new OAuthError("no_id_token");
    await checkSignature(answer.id_token, this.#keys);
    const account = checkIdToken(answer.id_token, { clientId: this.#client.clientId, nonce: pending.nonce, now: this.#now() });
    return { ...account, name: nameOf(answer.id_token) };
  }
}
