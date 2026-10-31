// Calls to Google's endpoints (0012). Each call has a time limit and a size
// limit, and every failure becomes a GoogleError with a fixed code and a
// fixed sentence. No error carries a token, a response body, a header or
// message text, so nothing from Google reaches a log or the browser.

// The part of `fetch` this module uses. Tests pass a fake of Google's
// endpoints. The app passes the global fetch.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const GOOGLE_ERROR_CODES = [
  "google_not_configured",
  "google_not_connected",
  "google_reconnect_needed",
  "google_scope_missing",
  "google_unavailable",
  "google_refused",
  "google_not_found",
  "google_changed",
  "google_not_app_event",
  "google_invalid_response",
  "google_stale",
  "google_duplicate",
  "google_read_limit",
  "google_demo_reconnect",
  "google_demo_limit",
  "google_demo_rate_limited",
] as const;
export type GoogleErrorCode = (typeof GOOGLE_ERROR_CODES)[number];

export const GOOGLE_ERROR_TEXT: Record<GoogleErrorCode, string> = {
  google_not_configured: "Google is not set up on this server yet.",
  google_not_connected: "Google is not connected. Connect it in Connections.",
  google_reconnect_needed: "The Google connection expired or was revoked. Connect it again in Connections.",
  google_scope_missing: "The Google connection does not include this permission. Connect again with it turned on.",
  google_unavailable: "Google did not answer. Nothing changed. Try again in a moment.",
  google_refused: "Google refused the request. Nothing changed.",
  google_not_found: "Google has no such item.",
  google_changed: "The calendar event changed at Google since the app wrote it, so the app left it as it is.",
  google_not_app_event: "That calendar event was not created by this app, so the app does not change it.",
  google_invalid_response: "Google sent an answer the app could not read. Nothing changed.",
  google_stale: "The Google connection changed since the page read it. Reload and try again.",
  google_duplicate: "Google Calendar has more than one event the app made for this appointment. Remove the extra one in Google Calendar, then try again.",
  google_read_limit: "The app already read Google Calendar as many times as one answer allows, so this date was not checked. Ask about it again.",
  // The shared demo connection of the hosted site (0021, D7).
  google_demo_reconnect:
    "The demo Gmail and Calendar need reconnecting by the site's owner, so the assistant cannot use them just now. Everything else still works: paste a message, or load a calendar file.",
  google_demo_limit: "Each account can keep at most 5 events in the shared demo calendar, so this one was not added. Undo or remove one first. Nothing was added.",
  google_demo_rate_limited: "The shared demo Gmail and Calendar had many requests in a short time. Wait a few minutes and try again. Nothing changed.",
};

// A fixed sentence for one case of a code, chosen by code.
const VARIANTS = {
  removed: "The calendar event was removed in Google Calendar, so the app did not add it back. Undo the removal in the activity list, or ask the assistant to put it back.",
} as const;
export type GoogleErrorVariant = keyof typeof VARIANTS;

export class GoogleError extends Error {
  override name = "GoogleError";
  readonly code: GoogleErrorCode;
  // Google's HTTP status, when there was one. Never the body.
  readonly status: number | null;
  // Set when the sentence is one of the VARIANTS.
  readonly variant: GoogleErrorVariant | null;
  constructor(code: GoogleErrorCode, status: number | null = null, variant: GoogleErrorVariant | null = null) {
    super(variant ? VARIANTS[variant] : GOOGLE_ERROR_TEXT[code]);
    this.code = code;
    this.status = status;
    this.variant = variant;
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000;
// A Gmail message in full format is the largest answer the app reads.
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// The body as text, or null when it is larger than `max` bytes. The body is
// read as a stream and counted, and reading stops and cancels the stream
// as soon as the count passes `max`, so a large answer is never held whole
// (review round 1, finding 4).
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return "";
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body.cancel().catch(() => {});
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  // Past the cap, or on a read error, the stream is canceled. The reader's
  // lock is always released (review round 2, finding 18).
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(value);
    }
    finished = true;
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export type GoogleResponse = { status: number; body: unknown; etag: string | null };

// One call. Returns the status and the JSON body, or null for an empty
// body. A network failure, a time-out or an answer that is too large or not
// JSON is a GoogleError.
export async function callGoogle(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<GoogleResponse> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new GoogleError("google_unavailable");
  }
  let text: string | null;
  try {
    text = await readCapped(res, maxBytes);
  } catch {
    throw new GoogleError("google_unavailable", res.status);
  }
  if (text === null) throw new GoogleError("google_invalid_response", res.status);
  let body: unknown = null;
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      // Error pages are sometimes HTML. Only a successful answer must be
      // JSON.
      if (res.ok) throw new GoogleError("google_invalid_response", res.status);
    }
  }
  return { status: res.status, body, etag: res.headers.get("etag") };
}

// The `error` field of an OAuth error body, such as "invalid_grant".
export function oauthErrorOf(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return null;
}

// The machine-readable reasons of a Google API error body, such as
// "insufficientPermissions" or "rateLimitExceeded". Only these short codes
// are read, never the message text.
function reasonsOf(body: unknown): string[] {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object") return [];
  const out: string[] = [];
  const status = (error as { status?: unknown }).status;
  if (typeof status === "string") out.push(status);
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors)) for (const e of errors) if (e && typeof e.reason === "string") out.push(e.reason);
  const details = (error as { details?: unknown }).details;
  if (Array.isArray(details)) for (const d of details) if (d && typeof d.reason === "string") out.push(d.reason);
  return out;
}

const RATE_LIMIT = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "RESOURCE_EXHAUSTED"]);
const SCOPE = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);

// A failed API answer as a GoogleError. 401 is handled by the caller, which
// refreshes the token once first.
export function apiError(status: number, body: unknown = null): GoogleError {
  const reasons = reasonsOf(body);
  if (reasons.some((r) => RATE_LIMIT.has(r))) return new GoogleError("google_unavailable", status);
  if (status === 403 && reasons.some((r) => SCOPE.has(r))) return new GoogleError("google_scope_missing", status);
  if (status === 404 || status === 410) return new GoogleError("google_not_found", status);
  if (status === 412) return new GoogleError("google_changed", status);
  if (status === 429 || status >= 500) return new GoogleError("google_unavailable", status);
  return new GoogleError("google_refused", status);
}
