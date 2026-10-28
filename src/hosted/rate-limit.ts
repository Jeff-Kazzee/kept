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

// The address a request came from (review round 1, finding 4). A
// forwarding header counts only behind the configured proxy: with
// APP_TRUSTED_PROXY=cloudflare, CF-Connecting-IP, and only when the socket
// is loopback, since cloudflared runs on this server. Otherwise, and for
// every other header, the socket's own address.
const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

export function clientAddress(headers: Record<string, string | string[] | undefined>, socketAddress: string | undefined, trusted: "none" | "cloudflare"): string {
  const socket = socketAddress ?? "unknown";
  if (trusted !== "cloudflare" || !LOOPBACK.test(socket)) return socket;
  const raw = headers["cf-connecting-ip"];
  const cf = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return cf && cf.length <= 64 ? cf : socket;
}
