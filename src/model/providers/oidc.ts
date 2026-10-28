// OpenID Connect pieces for Sign in with ChatGPT (0010, design item 3):
// the discovery document, the signing keys and the ID token check, with
// Node's crypto and fetch only.
//
// The ID token check follows the sign-in guide, step 4: the signature
// against OpenAI's published keys, the issuer from discovery, the audience
// against the issued client id, the expiry with a small clock tolerance,
// and the nonce saved for this attempt. Only RS256 and ES256 signatures are
// accepted, so "none" and shared-secret algorithms are refused.
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

export const OPENAI_ISSUER = "https://auth.openai.com";
export const DISCOVERY_URL = `${OPENAI_ISSUER}/.well-known/openid-configuration`;
// Seconds of clock skew allowed on exp, iat and nbf.
export const CLOCK_TOLERANCE_S = 5;
// How long the signing keys are kept: the response's Cache-Control max-age,
// within these bounds, or the default when it gives none.
export const JWKS_MIN_TTL_MS = 60_000;
export const JWKS_DEFAULT_TTL_MS = 60 * 60_000;
export const JWKS_MAX_TTL_MS = 24 * 60 * 60_000;
// An unfamiliar kid or a failed signature reloads the keys at most this
// often.
export const JWKS_RELOAD_GAP_MS = 60_000;

function keysLifetime(cacheControl: string | null): number {
  if (cacheControl && /(^|,)\s*(no-store|no-cache)\s*(,|$)/i.test(cacheControl)) return JWKS_MIN_TTL_MS;
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl ?? "");
  if (!m) return JWKS_DEFAULT_TTL_MS;
  return Math.min(JWKS_MAX_TTL_MS, Math.max(JWKS_MIN_TTL_MS, Number(m[1]) * 1000));
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string | null;
};

// `unavailable`: OpenAI's discovery or key service could not be read, which
// says nothing about the token. `invalid`: the token failed a check.
export class IdentityError extends Error {
  override name = "IdentityError";
  readonly kind: "unavailable" | "invalid";
  // A short code for tests and logs, such as "nonce" or "signature".
  readonly reason: string;
  constructor(kind: "unavailable" | "invalid", reason: string) {
    super(kind === "unavailable" ? "ChatGPT identity checks are unavailable just now." : `The ChatGPT ID token failed its check (${reason}).`);
    this.kind = kind;
    this.reason = reason;
  }
}

export type VerifiedIdentity = { issuer: string; subject: string; email: string | null; name: string | null };

const ALGORITHMS: Record<string, { kty: string; dsaEncoding?: "ieee-p1363" }> = {
  RS256: { kty: "RSA" },
  ES256: { kty: "EC", dsaEncoding: "ieee-p1363" },
};

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class OpenAiIdentity {
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  #discovery: Promise<Discovery> | null = null;
  #keys: Map<string, { key: KeyObject; kty: string; alg: string | null }> | null = null;
  #keysFetchedAt = 0;
  #keysExpireAt = 0;
  #loading: Promise<void> | null = null;

  constructor(options: { fetch?: FetchLike; now?: () => number } = {}) {
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  get fetch(): FetchLike {
    return this.#fetch;
  }

  // The discovery document, checked: the issuer must be OpenAI's, and every
  // endpoint must be on the issuer's origin. Cached once it reads well.
  discovery(): Promise<Discovery> {
    this.#discovery ??= this.#loadDiscovery().catch((err) => {
      this.#discovery = null;
      throw err;
    });
    return this.#discovery;
  }

  async #loadDiscovery(): Promise<Discovery> {
    let data: Record<string, unknown>;
    try {
      const res = await this.#fetch(DISCOVERY_URL, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error("status");
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new IdentityError("unavailable", "discovery");
    }
    if (!data || data.issuer !== OPENAI_ISSUER) throw new IdentityError("unavailable", "discovery_issuer");
    const endpoint = (name: string, required: boolean): string | null => {
      const value = data[name];
      if (value === undefined && !required) return null;
      if (typeof value !== "string") throw new IdentityError("unavailable", `discovery_${name}`);
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new IdentityError("unavailable", `discovery_${name}`);
      }
      if (url.origin !== OPENAI_ISSUER) throw new IdentityError("unavailable", `discovery_${name}`);
      return value;
    };
    return {
      issuer: OPENAI_ISSUER,
      authorization_endpoint: endpoint("authorization_endpoint", true)!,
      token_endpoint: endpoint("token_endpoint", true)!,
      jwks_uri: endpoint("jwks_uri", true)!,
      revocation_endpoint: endpoint("revocation_endpoint", false),
    };
  }

  // One key load at a time: calls that need the keys while a load runs
  // share it.
  #loadKeys(): Promise<void> {
    this.#loading ??= this.#fetchKeys().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  async #fetchKeys(): Promise<void> {
    const { jwks_uri } = await this.discovery();
    let body: { keys?: unknown };
    let lifetime: number;
    try {
      const res = await this.#fetch(jwks_uri, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (res.status !== 200) throw new Error("status");
      lifetime = keysLifetime(res.headers.get("cache-control"));
      body = (await res.json()) as { keys?: unknown };
    } catch {
      throw new IdentityError("unavailable", "jwks");
    }
    if (!Array.isArray(body?.keys)) throw new IdentityError("unavailable", "jwks");
    const keys = new Map<string, { key: KeyObject; kty: string; alg: string | null }>();
    for (const jwk of body.keys as Array<Record<string, unknown>>) {
      if (!jwk || typeof jwk.kid !== "string" || typeof jwk.kty !== "string") continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      try {
        keys.set(jwk.kid, { key: createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }), kty: jwk.kty, alg: typeof jwk.alg === "string" ? jwk.alg : null });
      } catch {
        // A key this runtime cannot read is skipped.
      }
    }
    this.#keys = keys;
    this.#keysFetchedAt = this.#now();
    this.#keysExpireAt = this.#keysFetchedAt + lifetime;
  }

  get #mayReload(): boolean {
    return this.#now() - this.#keysFetchedAt >= JWKS_RELOAD_GAP_MS;
  }

  async #key(kid: string) {
    if (!this.#keys || this.#now() >= this.#keysExpireAt) await this.#loadKeys();
    let found = this.#keys!.get(kid);
    // An unfamiliar kid reloads the keys, at most once a minute.
    if (!found && this.#mayReload) {
      await this.#loadKeys();
      found = this.#keys!.get(kid);
    }
    return found;
  }

  // Checks an ID token. `nonce` is the value sent with this attempt, or
  // null for an ID token from a refresh, which carries none to check.
  async verifyIdToken(idToken: unknown, options: { clientId: string; nonce: string | null }): Promise<VerifiedIdentity> {
    if (typeof idToken !== "string") throw new IdentityError("invalid", "missing");
    const parts = idToken.split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new IdentityError("invalid", "format");
    const header = decodeJson(parts[0]!);
    const payload = decodeJson(parts[1]!);
    if (!header || !payload) throw new IdentityError("invalid", "format");
    const alg = typeof header.alg === "string" ? header.alg : "";
    const algorithm = ALGORITHMS[alg];
    if (!algorithm) throw new IdentityError("invalid", "algorithm");
    if (typeof header.kid !== "string") throw new IdentityError("invalid", "kid");
    const { issuer } = await this.discovery();
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2]!, "base64url");
    const check = (key: { key: KeyObject; kty: string; alg: string | null } | undefined): void => {
      if (!key) throw new IdentityError("invalid", "unknown_key");
      if (key.kty !== algorithm.kty || (key.alg !== null && key.alg !== alg)) throw new IdentityError("invalid", "algorithm");
      const ok = verify("sha256", signed, algorithm.dsaEncoding ? { key: key.key, dsaEncoding: algorithm.dsaEncoding } : key.key, signature);
      if (!ok) throw new IdentityError("invalid", "signature");
    };
    try {
      check(await this.#key(header.kid));
    } catch (err) {
      // A key replaced under the same kid: reload once, at most once a
      // minute, and check again.
      if (!(err instanceof IdentityError && err.reason === "signature" && this.#mayReload)) throw err;
      await this.#loadKeys();
      check(this.#keys!.get(header.kid));
    }

    const now = Math.floor(this.#now() / 1000);
    if (payload.iss !== issuer) throw new IdentityError("invalid", "issuer");
    const aud = payload.aud;
    const audOk = aud === options.clientId || (Array.isArray(aud) && aud.includes(options.clientId) && (aud.length === 1 || payload.azp === options.clientId));
    if (!audOk) throw new IdentityError("invalid", "audience");
    if (typeof payload.exp !== "number" || payload.exp + CLOCK_TOLERANCE_S <= now) throw new IdentityError("invalid", "expired");
    if (typeof payload.iat !== "number" || payload.iat - CLOCK_TOLERANCE_S > now) throw new IdentityError("invalid", "issued_at");
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - CLOCK_TOLERANCE_S > now)) throw new IdentityError("invalid", "not_before");
    if (options.nonce !== null && payload.nonce !== options.nonce) throw new IdentityError("invalid", "nonce");
    if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new IdentityError("invalid", "subject");
    const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" && v.length <= 320 ? v : null);
    return { issuer, subject: payload.sub, email: text(payload.email), name: text(payload.name) };
  }
}
