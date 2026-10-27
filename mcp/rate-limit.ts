// Calls per grant in a sliding window, kept in the server process. A
// client that restarts the server starts a new window, which is acceptable
// because the client launches the server and pays for every restart.
export const CALLS_PER_MINUTE = 60;

export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #calls = new Map<string, number[]>();

  constructor(options: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.#limit = options.limit ?? CALLS_PER_MINUTE;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  // Counts the call when it is allowed. Returns the seconds to wait when it
  // is not.
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.#now();
    const recent = (this.#calls.get(key) ?? []).filter((t) => t > now - this.#windowMs);
    if (recent.length >= this.#limit) {
      this.#calls.set(key, recent);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + this.#windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.#calls.set(key, recent);
    return { ok: true };
  }
}
