// Per-address limits for sign-in starts and judge code tries (0014,
// design item 3). Each address may take `limit` tries in a fixed window.
// Counts live in memory: a restart clears them, which costs an attacker a
// restart they cannot cause.
import { isIP } from "node:net";

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

// The address a request came from (review round 1, finding 4, and 0023
// fix round 1, finding 1). A forwarding header counts only behind the
// configured proxy, and only when the socket is loopback, since the proxy
// runs on this server:
//   cloudflare  CF-Connecting-IP
//   tailscale   X-Forwarded-For. Tailscale serve and Funnel proxy with Go's
//               ReverseProxy, which drops a client's own X-Forwarded-*
//               headers, then set X-Forwarded-For to the one address the
//               connection came from (ipn/ipnlocal/serve.go,
//               addProxyForwardedHeaders).
// Either header must hold one plain IP address that is not loopback. A
// header that is there but holds anything else, a list, or a loopback
// address gets FORWARDED_UNKNOWN: one address that every such request
// shares, so a made-up claim can neither spread its tries over many
// addresses nor pass as this server. With no proxy set, every forwarding
// header is ignored. Otherwise, and for every other header, the socket's
// own address. Only that is ever loopback.
export const FORWARDED_UNKNOWN = "0.0.0.0";

// One plain IP address, IPv4 or IPv6, in its usual form, or null.
export function parseIp(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 45) return null;
  const kind = isIP(value);
  if (kind === 4) return value;
  if (kind === 6 && !value.includes("%")) {
    const v = value.toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
    return mapped ? mapped[1]! : v;
  }
  return null;
}

const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0:0:0:0:0:0:0:1)$/i;

export const isLoopback = (address: string) => LOOPBACK.test(address);

export function clientAddress(headers: Record<string, string | string[] | undefined>, socketAddress: string | undefined, trusted: "none" | "cloudflare" | "tailscale"): string {
  const socket = socketAddress ?? "unknown";
  if (trusted === "none" || !LOOPBACK.test(socket)) return socket;
  const raw = headers[trusted === "cloudflare" ? "cf-connecting-ip" : "x-forwarded-for"];
  if (raw === undefined) return socket;
  const one = Array.isArray(raw) ? (raw.length === 1 ? raw[0]! : null) : raw;
  const ip = one === null ? null : parseIp(one);
  return ip === null || isLoopback(ip) ? FORWARDED_UNKNOWN : ip;
}

// The key an address's pool sign-ins are counted under (0023): an IPv4
// address as it is, an IPv6 address by its /64, the block one home or
// phone network is given, so rotating within it gains nothing.
export function addressBucket(address: string): string {
  const ip = parseIp(address);
  if (ip === null || isIP(ip) === 4) return ip ?? address;
  const [head = "", tail = ""] = ip.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = ip.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
