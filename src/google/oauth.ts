// Google OAuth 2.0, authorization code flow with PKCE (0012, item 1).
// Follows Google's "Using OAuth 2.0 for Web Server Applications" and
// "OpenID Connect" pages, read on 2026-10-28:
//
// - The page sends the person to the authorization endpoint with
//   response_type=code, the scopes the person turned on, access_type=offline
//   and prompt=consent (so a refresh token comes back every time), a random
//   `state`, a random `nonce` and an S256 code challenge.
// - `state` is single use, expires after 10 minutes and is bound to the
//   browser that started the flow by an HttpOnly cookie, so a callback with
//   a code from somewhere else is refused.
// - The code is exchanged at the token endpoint with the client secret and
//   the code verifier.
// - The ID token comes from the token endpoint over TLS, which Google says
//   is enough to trust its source. Its issuer, audience, expiry and nonce are
//   still checked here.
// - Google lets the person uncheck scopes on the consent screen, so the
//   granted scopes are read from the token answer, never assumed.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { GoogleError, callGoogle, oauthErrorOf, type FetchLike } from "./http.ts";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const IDENTITY_SCOPES = ["openid", "email"];

export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export type OAuthClient = { clientId: string; clientSecret: string };
export type Features = { gmail: boolean; calendar: boolean };

// Only the scopes the person turned on, plus the identity scopes for the
// account's email.
export function scopesFor(features: Features): string[] {
  return [...IDENTITY_SCOPES, ...(features.gmail ? [GMAIL_SCOPE] : []), ...(features.calendar ? [CALENDAR_SCOPE] : [])];
}

const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest();

// RFC 7636: a verifier of 43 to 128 unreserved characters, and its S256
// challenge, base64url without padding. 48 random bytes give 64 characters.
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = random(48);
  return { verifier, challenge: sha256(verifier).toString("base64url") };
}

export type Flow = {
  verifier: string;
  nonce: string;
  redirectUri: string;
  features: Features;
  calendarId: string;
};

type Pending = Flow & { cookieHash: Buffer; expiresAt: number };

export const FLOW_TTL_MS = 10 * 60_000;
const MAX_PENDING = 5;

// Flows started and not finished yet, in memory only. A restart forgets
// them, and the person starts again.
export class PendingFlows {
  readonly #flows = new Map<string, Pending>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  // Returns the state for the authorization URL and the value of the
  // browser-binding cookie. Only their hashes are kept.
  start(flow: Flow): { state: string; cookie: string } {
    this.#sweep();
    while (this.#flows.size >= MAX_PENDING) this.#flows.delete(this.#flows.keys().next().value!);
    const state = random(32);
    const cookie = random(32);
    this.#flows.set(sha256(state).toString("hex"), { ...flow, cookieHash: sha256(cookie), expiresAt: this.#now() + FLOW_TTL_MS });
    return { state, cookie };
  }

  // The flow for `state`, removed so it cannot be used twice, when the
  // cookie matches and it has not expired. Otherwise null.
  take(state: string | null, cookie: string | null): Flow | null {
    this.#sweep();
    if (!state || state.length > 200) return null;
    const key = sha256(state).toString("hex");
    const pending = this.#flows.get(key);
    if (!pending) return null;
    this.#flows.delete(key);
    if (!cookie || !timingSafeEqual(sha256(cookie), pending.cookieHash)) return null;
    const { cookieHash: _c, expiresAt: _e, ...flow } = pending;
    return flow;
  }

  #sweep() {
    const now = this.#now();
    for (const [k, f] of this.#flows) if (f.expiresAt <= now) this.#flows.delete(k);
  }
}

export function authorizeUrl(client: OAuthClient, flow: Flow, state: string, challenge: string): string {
  const url = new URL(AUTH_URL);
  const p = url.searchParams;
  p.set("client_id", client.clientId);
  p.set("redirect_uri", flow.redirectUri);
  p.set("response_type", "code");
  p.set("scope", scopesFor(flow.features).join(" "));
  p.set("access_type", "offline");
  p.set("prompt", "consent");
  p.set("state", state);
  p.set("nonce", flow.nonce);
  p.set("code_challenge", challenge);
  p.set("code_challenge_method", "S256");
  return url.toString();
}

const TokenAnswer = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
});
export type TokenAnswer = z.infer<typeof TokenAnswer>;

export class OAuthError extends Error {
  override name = "OAuthError";
  // A fixed code for the page, such as "invalid_state" or "id_token_invalid".
  readonly code: string;
  constructor(code: string) {
    super(`Google sign-in failed: ${code}.`);
    this.code = code;
  }
}

async function tokenCall(fetchImpl: FetchLike, form: Record<string, string>): Promise<TokenAnswer> {
  const res = await callGoogle(fetchImpl, TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  if (res.status === 400 || res.status === 401) {
    // invalid_grant: the code or the refresh token expired or was revoked.
    if (oauthErrorOf(res.body) === "invalid_grant") throw new GoogleError("google_reconnect_needed", res.status);
    throw new GoogleError("google_refused", res.status);
  }
  if (res.status >= 500 || res.status === 429) throw new GoogleError("google_unavailable", res.status);
  if (res.status !== 200) throw new GoogleError("google_refused", res.status);
  const parsed = TokenAnswer.safeParse(res.body);
  if (!parsed.success) throw new GoogleError("google_invalid_response", res.status);
  return parsed.data;
}

export function exchangeCode(fetchImpl: FetchLike, client: OAuthClient, code: string, flow: Flow): Promise<TokenAnswer> {
  return tokenCall(fetchImpl, {
    grant_type: "authorization_code",
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: flow.redirectUri,
    code_verifier: flow.verifier,
  });
}

export function refreshAccess(fetchImpl: FetchLike, client: OAuthClient, refreshToken: string): Promise<TokenAnswer> {
  return tokenCall(fetchImpl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
}

// Revokes the grant. Google revokes every scope of the grant, and the
// refresh token with it. True when Google confirmed it.
export async function revokeToken(fetchImpl: FetchLike, token: string): Promise<boolean> {
  try {
    const res = await callGoogle(fetchImpl, REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    // 400 invalid_token: Google no longer knows the token, so it is
    // already revoked or expired.
    return res.status === 200 || (res.status === 400 && oauthErrorOf(res.body) === "invalid_token");
  } catch {
    return false;
  }
}

const IdClaims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1).max(255),
  exp: z.number(),
  iat: z.number().optional(),
  nonce: z.string().optional(),
  email: z.email().max(320).optional(),
  email_verified: z.boolean().optional(),
});

// Checks the ID token from the token endpoint and returns the account. The
// token came straight from Google over TLS, so its signature is not checked
// here (Google's OpenID Connect page). Issuer, audience, expiry and nonce
// are.
export function checkIdToken(idToken: string, expected: { clientId: string; nonce: string; now: number }): { sub: string; email: string } {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OAuthError("id_token_invalid");
  let claims: z.infer<typeof IdClaims>;
  try {
    claims = IdClaims.parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
  } catch {
    throw new OAuthError("id_token_invalid");
  }
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new OAuthError("id_token_issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (aud.length !== 1 || aud[0] !== expected.clientId) throw new OAuthError("id_token_audience");
  // Five minutes of clock skew.
  if (claims.exp * 1000 < expected.now - 5 * 60_000) throw new OAuthError("id_token_expired");
  const nonce = Buffer.from(claims.nonce ?? "");
  const want = Buffer.from(expected.nonce);
  if (nonce.length !== want.length || !timingSafeEqual(nonce, want)) throw new OAuthError("id_token_nonce");
  if (!claims.email || claims.email_verified !== true) throw new OAuthError("email_unverified");
  return { sub: claims.sub, email: claims.email };
}

export const grantedFeatures = (scope: string | undefined): Features => {
  const granted = new Set((scope ?? "").split(/\s+/).filter(Boolean));
  return { gmail: granted.has(GMAIL_SCOPE), calendar: granted.has(CALENDAR_SCOPE) };
};

export const newNonce = () => random(24);
