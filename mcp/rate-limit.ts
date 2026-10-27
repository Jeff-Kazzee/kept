// Calls per grant in fixed one-minute windows, counted in the shared SQLite
// file. Every server process on the file shares the count, so a grant used
// by two clients, or a restarted client, still gets 60 calls a minute in
// total. take() must run inside the store's transaction, so the count and
// the call it allows are one step.
import type { EventStore, RateWindow } from "../src/store/event-log.ts";

export const CALLS_PER_MINUTE = 60;

export type RateDecision =
  | { ok: true; closed: RateWindow[] }
  // `firstDenial` is true for the first call this window denies. Only that
  // one is logged on its own.
  | { ok: false; retryAfterSeconds: number; firstDenial: boolean; closed: RateWindow[] };

export class RateLimiter {
  readonly #store: EventStore;
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(store: EventStore, options: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.#store = store;
    this.#limit = options.limit ?? CALLS_PER_MINUTE;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  get limit(): number {
    return this.#limit;
  }

  // Counts the call when it is allowed. Also returns the key's earlier
  // windows, which it removes, so the caller can log a summary of their
  // denied calls.
  take(key: string): RateDecision {
    const now = this.#now();
    const start = Math.floor(now / this.#windowMs) * this.#windowMs;
    const closed = this.#store.closeRateWindows(key, start);
    if (this.#store.rateWindow(key, start).calls >= this.#limit) {
      const w = this.#store.bumpRateWindow(key, start, "denied");
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((start + this.#windowMs - now) / 1000)), firstDenial: w.denied === 1, closed };
    }
    this.#store.bumpRateWindow(key, start, "calls");
    return { ok: true, closed };
  }
}
