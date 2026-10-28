// Access control for the local HTTP API (sprint 6 review rounds 1 and 2).
//
// A process on this computer can reach 127.0.0.1, and an agent with a
// shell tool can. A process that runs as your OS user can also open the
// database file directly, so nothing here stops it fully. The real control
// is the agent client's own tool permissions (docs/connect-agent.md).
// These checks make the web API itself need a person at the app's terminal:
//
// - Pairing. The server makes a pairing code at start, keeps it in memory
//   and prints it once to its own terminal. The browser sends it once to
//   POST /api/pair and gets a session cookie back: random, HttpOnly,
//   SameSite=Strict, kept only in this server's memory, valid until the
//   server stops. Every other /api route, reads included, needs that
//   cookie. A restart makes a new code and forgets every session.
// - Wrong codes slow down. Five wrong codes in a row are free. Then each
//   wrong code makes the next try wait, 1 minute after the fifth, doubling
//   up to 10 minutes. A right code, or 10 quiet minutes after the last wait
//   or wrong code, starts the count again.
// - Every request that changes state must come from the app's own page: a
//   browser sends Sec-Fetch-Site: same-origin, or an Origin equal to the
//   app's origin, and the page sends X-Appointments-App: 1. That keeps a
//   page on another site from using the cookie (CSRF).
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const APP_HEADER = "x-appointments-app";

export type RequestSource = { method: string; secFetchSite?: string; origin?: string; appHeader?: string };

// Why a request may not change state, or null when it may. GET and HEAD
// only read.
export function requestSourceProblem(req: RequestSource, appOrigins: readonly string[]): string | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const sameSite = req.secFetchSite === "same-origin" || (req.origin !== undefined && appOrigins.includes(req.origin));
  if (!sameSite) return "This request did not come from the app's own page: its Sec-Fetch-Site or Origin header is not the app's. Nothing was saved.";
  if (req.appHeader !== "1") return "This request does not carry the app's request header. Nothing was saved.";
  return null;
}

// No 0, O, 1, I or L, so the code is easy to read and type.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const FREE_TRIES = 5;
export const FIRST_WAIT_MS = 60_000;
export const MAX_WAIT_MS = 10 * 60_000;
// A wrong code older than this no longer counts.
export const FORGET_AFTER_MS = 10 * 60_000;

export type PairingResult =
  | { ok: true }
  | { ok: false; error: "pairing_required" | "pairing_failed" | "pairing_wait"; retryAfterSeconds: number | null };

const normalize = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");

export class Pairing {
  // Eight characters, about 40 bits, shown as XXXX-XXXX.
  readonly code: string;
  readonly #now: () => number;
  #failures = 0;
  #lastFailure = 0;
  #waitUntil = 0;

  constructor(options: { code?: string; now?: () => number } = {}) {
    this.code = options.code ?? Array.from({ length: 8 }, (_, i) => (i === 4 ? "-" : "") + ALPHABET[randomInt(ALPHABET.length)]).join("");
    this.#now = options.now ?? Date.now;
  }

  check(given: unknown): PairingResult {
    const now = this.#now();
    if (now < this.#waitUntil) return { ok: false, error: "pairing_wait", retryAfterSeconds: Math.ceil((this.#waitUntil - now) / 1000) };
    if (typeof given !== "string" || given.trim() === "") return { ok: false, error: "pairing_required", retryAfterSeconds: null };
    const a = Buffer.from(normalize(given));
    const b = Buffer.from(normalize(this.code));
    if (a.length === b.length && timingSafeEqual(a, b)) {
      this.#failures = 0;
      this.#waitUntil = 0;
      return { ok: true };
    }
    // Quiet time counts from the end of the last wait, so waiting one out
    // does not reset the count.
    if (now - Math.max(this.#lastFailure, this.#waitUntil) > FORGET_AFTER_MS) this.#failures = 0;
    this.#failures++;
    this.#lastFailure = now;
    if (this.#failures < FREE_TRIES) return { ok: false, error: "pairing_failed", retryAfterSeconds: null };
    const wait = Math.min(FIRST_WAIT_MS * 2 ** (this.#failures - FREE_TRIES), MAX_WAIT_MS);
    this.#waitUntil = now + wait;
    return { ok: false, error: "pairing_failed", retryAfterSeconds: wait / 1000 };
  }
}

// Paired browser sessions, kept in memory only. Only a hash of each
// session id is kept.
export class Sessions {
  readonly #hashes = new Set<string>();

  create(): string {
    const id = randomBytes(32).toString("base64url");
    this.#hashes.add(createHash("sha256").update(id).digest("hex"));
    return id;
  }

  has(id: string | undefined): boolean {
    return typeof id === "string" && id.length > 0 && this.#hashes.has(createHash("sha256").update(id).digest("hex"));
  }
}

// Cookies do not tell ports apart, so each app port has its own cookie
// name. Two apps on one computer then keep their sessions apart.
export const sessionCookieName = (port: number) => `appointments_session_${port}`;

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export type GateResponse = { status: number; body: unknown; setCookie?: string };

// The pairing route and the session check, without sockets, so tests can
// call them. The server calls `pair` for POST /api/pair and `sessionProblem`
// for every other /api request.
export function createGate(options: { pairing: Pairing; sessions: Sessions; port: number }) {
  const name = sessionCookieName(options.port);
  return {
    cookieName: name,
    pair(body: unknown): GateResponse {
      const code = (body as { code?: unknown } | null)?.code;
      const result = options.pairing.check(code);
      if (result.ok) {
        const id = options.sessions.create();
        return { status: 200, body: { paired: true }, setCookie: `${name}=${id}; HttpOnly; SameSite=Strict; Path=/` };
      }
      if (result.error === "pairing_wait") {
        return {
          status: 429,
          body: { error: "pairing_wait", retryAfterSeconds: result.retryAfterSeconds, message: `Too many wrong codes. Wait ${waitText(result.retryAfterSeconds!)}, then try again.` },
        };
      }
      if (result.error === "pairing_required") {
        return { status: 400, body: { error: "pairing_required", message: "Enter the pairing code the app printed in its terminal when it started." } };
      }
      const wait = result.retryAfterSeconds === null ? "" : ` Wait ${waitText(result.retryAfterSeconds)} before the next try.`;
      return { status: 401, body: { error: "pairing_failed", retryAfterSeconds: result.retryAfterSeconds, message: `That pairing code is not right.${wait}` } };
    },
    sessionProblem(cookieHeader: string | undefined): GateResponse | null {
      if (options.sessions.has(cookieValue(cookieHeader, name))) return null;
      return {
        status: 401,
        body: { error: "not_paired", message: "Pair this browser with the app first: enter the pairing code the app printed in its terminal. Nothing was saved." },
      };
    },
  };
}
