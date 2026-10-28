// Defense in depth for the local HTTP API (sprint 6 review, finding 1).
//
// The API has no user login. Any process on this computer that can reach
// 127.0.0.1 could call it, and an agent with a shell tool can. A process
// that runs as your OS user can also open the database file directly, so
// nothing here stops it fully. The real control is the agent client's own
// tool permissions (docs/connect-agent.md). These checks only raise the bar:
//
// - Every request that changes state must come from the app's own page: a
//   browser sends Sec-Fetch-Site: same-origin, or an Origin equal to the
//   app's origin, and the page sends X-Appointments-App: 1. That stops a
//   page on another site and a plain request made without thought.
// - Creating a grant and confirming an agent's proposal also need the
//   pairing code. The server makes it at start, keeps it in memory only and
//   prints it once to its own terminal. The page asks for it once per
//   browser tab. Ten wrong codes lock both actions until the app restarts.
import { randomInt, timingSafeEqual } from "node:crypto";

export const APP_HEADER = "x-appointments-app";
export const PAIRING_HEADER = "x-pairing-code";

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
export const MAX_PAIRING_FAILURES = 10;

export type PairingCheck = "ok" | "missing" | "wrong" | "locked";

const normalize = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");

export class Pairing {
  // Eight characters, about 40 bits, shown as XXXX-XXXX.
  readonly code: string;
  #failures = 0;

  constructor(code?: string) {
    this.code = code ?? Array.from({ length: 8 }, (_, i) => (i === 4 ? "-" : "") + ALPHABET[randomInt(ALPHABET.length)]).join("");
  }

  check(given: string | undefined): PairingCheck {
    if (this.#failures >= MAX_PAIRING_FAILURES) return "locked";
    if (given === undefined || given.trim() === "") return "missing";
    const a = Buffer.from(normalize(given));
    const b = Buffer.from(normalize(this.code));
    if (a.length === b.length && timingSafeEqual(a, b)) return "ok";
    this.#failures++;
    return this.#failures >= MAX_PAIRING_FAILURES ? "locked" : "wrong";
  }
}
