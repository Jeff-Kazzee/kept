// Per-address limits for sign-in starts and judge code tries (0014,
// design item 3). Each address may take `limit` tries in a fixed window.
// Counts live in memory: a restart clears them, which costs an attacker a
// restart they cannot cause.
export type AddressDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export class AddressLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #counts = new Map<string, { window: number; count: number }>();

  constructor(options: { limit: number; windowMs: number; now?: () => number }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  take(address: string): AddressDecision {
    const now = this.#now();
    const window = Math.floor(now / this.#windowMs) * this.#windowMs;
    if (this.#counts.size > 10_000) {
      for (const [k, v] of this.#counts) if (v.window !== window) this.#counts.delete(k);
    }
    const entry = this.#counts.get(address);
    const current = entry && entry.window === window ? entry : { window, count: 0 };
    if (current.count >= this.#limit) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((window + this.#windowMs - now) / 1000)) };
    current.count++;
    this.#counts.set(address, current);
    return { ok: true };
  }
}

// The address a request came from. The app binds 127.0.0.1, so a request
// from outside comes through a proxy on this server, such as cloudflared,
// which names the client in CF-Connecting-IP. Without it, the first
// X-Forwarded-For entry, then the socket's own address.
export function clientAddress(headers: Record<string, string | string[] | undefined>, socketAddress: string | undefined): string {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const cf = one(headers["cf-connecting-ip"])?.trim();
  if (cf && cf.length <= 64) return cf;
  const xff = one(headers["x-forwarded-for"])?.split(",")[0]?.trim();
  if (xff && xff.length <= 64) return xff;
  return socketAddress ?? "unknown";
}
