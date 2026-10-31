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

  // Whether `address` may try now, without counting a try.
  check(address: string): AddressDecision {
    const now = this.#now();
    const window = Math.floor(now / this.#windowMs) * this.#windowMs;
    const entry = this.#counts.get(address);
    if (entry && entry.window === window && entry.count >= this.#limit) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((window + this.#windowMs - now) / 1000)) };
    return { ok: true };
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
// forwarding header counts only behind the configured proxy, and only when
// the socket is loopback, since the proxy runs on this server:
//   cloudflare  CF-Connecting-IP
//   tailscale   X-Forwarded-For. Tailscale serve and Funnel proxy with Go's
//               ReverseProxy, which drops a client's own X-Forwarded-*
//               headers, then set X-Forwarded-For to the one address the
//               connection came from (ipn/ipnlocal/serve.go,
//               addProxyForwardedHeaders). So one plain address is
//               trusted, and a list or anything else is not.
// Otherwise, and for every other header, the socket's own address.
const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

export const isLoopback = (address: string) => LOOPBACK.test(address);

const PLAIN_ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,39})$/;

export function clientAddress(headers: Record<string, string | string[] | undefined>, socketAddress: string | undefined, trusted: "none" | "cloudflare" | "tailscale"): string {
  const socket = socketAddress ?? "unknown";
  if (trusted === "none" || !LOOPBACK.test(socket)) return socket;
  const raw = headers[trusted === "cloudflare" ? "cf-connecting-ip" : "x-forwarded-for"];
  const value = (Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw)?.trim();
  if (trusted === "tailscale") return value && PLAIN_ADDRESS.test(value) ? value : socket;
  return value && value.length <= 64 ? value : socket;
}
