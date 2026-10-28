// A simple per-process limit on MCP tool calls (0009, design 4): at most
// CALLS_PER_MINUTE calls in each fixed one-minute window. Each server
// process counts its own calls in memory. It guards against a runaway
// agent loop, not against a person who can open the database file.
export const CALLS_PER_MINUTE = 60;

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number; firstDenial: boolean };

export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #window = -1;
  #calls = 0;
  #denied = 0;

  constructor(options: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.#limit = options.limit ?? CALLS_PER_MINUTE;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  get limit(): number {
    return this.#limit;
  }

  // Counts the call when it is allowed. `firstDenial` is true for the first
  // call a window refuses, which is the only one the access log records on
  // its own.
  take(): RateDecision {
    const now = this.#now();
    const window = Math.floor(now / this.#windowMs) * this.#windowMs;
    if (window !== this.#window) {
      this.#window = window;
      this.#calls = 0;
      this.#denied = 0;
    }
    if (this.#calls >= this.#limit) {
      this.#denied++;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((window + this.#windowMs - now) / 1000)), firstDenial: this.#denied === 1 };
    }
    this.#calls++;
    return { ok: true };
  }
}
