// Calls per grant in fixed one-minute windows, counted in the shared SQLite
// file. Every server process on the file shares the count, so a grant used
// by two clients, or a restarted client, still gets 60 calls a minute in
// total. take() and sweep() must run inside the store's transaction, so the
// count and the call it allows are one step.
import type { EventStore, RateWindow } from "../src/store/event-log.ts";

export const CALLS_PER_MINUTE = 60;

export type RateDecision =
  | { ok: true }
  // `firstDenial` is true for the first call this window denies. Only that
  // one is logged on its own.
  | { ok: false; retryAfterSeconds: number; firstDenial: boolean };

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

  #windowStart(now: number): number {
    return Math.floor(now / this.#windowMs) * this.#windowMs;
  }

  // Removes every key's windows that have ended and returns them, so the
  // caller can log a summary of their denied calls.
  sweep(): RateWindow[] {
    return this.#store.closeRateWindows(null, this.#windowStart(this.#now()));
  }

  // Counts the call when it is allowed.
  take(key: string): RateDecision {
    const now = this.#now();
    const start = this.#windowStart(now);
    if (this.#store.rateWindow(key, start).calls >= this.#limit) {
      const w = this.#store.bumpRateWindow(key, start, "denied");
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((start + this.#windowMs - now) / 1000)), firstDenial: w.denied === 1 };
    }
    this.#store.bumpRateWindow(key, start, "calls");
    return { ok: true };
  }
}
