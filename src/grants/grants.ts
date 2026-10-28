// Grants let an agent reach the case through the MCP server. The user
// creates, names and revokes them in the app. No MCP tool manages grants, so
// an agent cannot widen its own access.
//
// A token is `appt_` and then 32 random bytes in base64url (43 characters).
// The fixed prefix lets the secret scan find a token with no false hits on
// ordinary text. A token is shown once at creation and stored only as its
// SHA-256 hash. A revoked grant stays as a record with a
// revoked event. Each grant is one stream, `grant:<id>`, and every write
// states its expected version.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { InvalidRequestError, NotFoundError } from "../intake/service.ts";
import { ACCESS_LOG_STREAM, projectAccessLog, rateSummaryEvents } from "../records/events.ts";
import type { EventStore, StoredEvent } from "../store/event-log.ts";

export const TIERS = ["read", "annotate", "propose"] as const;
export const Tier = z.enum(TIERS);
export type Tier = z.infer<typeof Tier>;

// Each tier includes the tiers before it.
export function tierAllows(tier: Tier, needed: Tier): boolean {
  return TIERS.indexOf(tier) >= TIERS.indexOf(needed);
}

export const TOKEN_PREFIX = "appt_";
// The shape of a token. The server still accepts only a token whose hash is
// stored, whatever its shape.
export const TOKEN_PATTERN = /^appt_[A-Za-z0-9_-]{43}$/;
export const newGrantToken = () => `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

export const GRANT_PREFIX = "grant:";
export const grantStream = (id: string) => `${GRANT_PREFIX}${id}`;

// The name appears in the app, in the case history and in source labels
// such as "reported by you through <name>". Letters, digits, spaces and a
// few marks only, so it cannot carry markup or control characters.
export const GrantName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._'()-]*$/u, "Use letters, digits, spaces and . _ ' ( ) - only.");

export type GrantEvent =
  | { type: "grant_created"; data: { name: string; tier: Tier; token_sha256: string } }
  | { type: "grant_revoked"; data: Record<string, never> };

export type GrantView = {
  id: string;
  name: string;
  tier: Tier;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  version: number;
};

type GrantRecord = GrantView & { tokenHash: Buffer };

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function project(events: StoredEvent[]): Map<string, GrantRecord> {
  const grants = new Map<string, GrantRecord>();
  for (const e of events) {
    if (!e.streamId.startsWith(GRANT_PREFIX)) continue;
    const id = e.streamId.slice(GRANT_PREFIX.length);
    const event = { type: e.type, data: e.data } as GrantEvent;
    if (event.type === "grant_created") {
      grants.set(id, {
        id,
        name: event.data.name,
        tier: event.data.tier,
        status: "active",
        createdAt: e.recordedAt,
        revokedAt: null,
        version: e.version,
        tokenHash: Buffer.from(event.data.token_sha256, "hex"),
      });
      continue;
    }
    const g = grants.get(id);
    if (!g) continue;
    g.version = e.version;
    if (event.type === "grant_revoked") {
      g.status = "revoked";
      g.revokedAt = e.recordedAt;
    }
  }
  return grants;
}

const view = ({ tokenHash: _hash, ...g }: GrantRecord): GrantView => g;

export type GrantStoreOptions = {
  newId?: () => string;
  newToken?: () => string;
};

export class GrantStore {
  readonly #store: EventStore;
  readonly #newId: () => string;
  readonly #newToken: () => string;

  constructor(store: EventStore, options: GrantStoreOptions = {}) {
    this.#store = store;
    this.#newId = options.newId ?? (() => `g-${randomBytes(6).toString("hex")}`);
    this.#newToken = options.newToken ?? newGrantToken;
  }

  #all(): Map<string, GrantRecord> {
    return project(this.#store.readPrefix(GRANT_PREFIX));
  }

  #describe = (_streamId: string, events: StoredEvent[]) => {
    const g = [...project(events).values()][0];
    return g ? view(g) : null;
  };

  list(): GrantView[] {
    return [...this.#all().values()].map(view);
  }

  // When each grant last made a call, from the case's access log. Every
  // call counts, refused ones too. Delete case erases the access log, so a
  // grant has no last use in a new case until it calls again.
  lastUsed(): Map<string, string> {
    const last = new Map<string, string>();
    for (const e of projectAccessLog(this.#store.readStream(ACCESS_LOG_STREAM))) {
      if (e.grant_id !== null && (last.get(e.grant_id) ?? "") < e.at) last.set(e.grant_id, e.at);
    }
    return last;
  }

  get(id: string): GrantView {
    const g = this.#all().get(id);
    if (!g) throw new NotFoundError(`No grant ${id}.`);
    return view(g);
  }

  // Returns the token once. Only its hash is stored.
  create(name: string, tier: Tier): { grant: GrantView; token: string } {
    const parsedName = GrantName.safeParse(name);
    if (!parsedName.success) throw new InvalidRequestError(`Invalid grant name: ${parsedName.error.issues[0]!.message}`);
    const parsedTier = Tier.safeParse(tier);
    if (!parsedTier.success) throw new InvalidRequestError(`Invalid tier. Use one of: ${TIERS.join(", ")}.`);
    const taken = this.list().some((g) => g.status === "active" && g.name.toLowerCase() === parsedName.data.toLowerCase());
    if (taken) throw new InvalidRequestError(`An active grant is already named ${parsedName.data}.`);

    const id = this.#newId();
    const token = this.#newToken();
    const event: GrantEvent = {
      type: "grant_created",
      data: { name: parsedName.data, tier: parsedTier.data, token_sha256: hashToken(token) },
    };
    this.#store.append(grantStream(id), 0, [event], this.#describe);
    return { grant: this.get(id), token };
  }

  revoke(id: string, expectedVersion: number): GrantView {
    const current = this.get(id);
    if (current.status === "revoked" && current.version === expectedVersion) {
      throw new InvalidRequestError(`Grant ${id} is already revoked.`);
    }
    const event: GrantEvent = { type: "grant_revoked", data: {} };
    this.#store.transaction(() => {
      this.#store.append(grantStream(id), expectedVersion, [event], this.#describe);
      // The grant makes no more calls, so its rate-limit counts are closed
      // now and their denials summarized in the access log.
      const closed = this.#store.closeRateWindows(id, Number.MAX_SAFE_INTEGER);
      const summaries = rateSummaryEvents(closed, () => ({ grant_id: id, grant_name: current.name }));
      if (summaries.length > 0) this.#store.appendSystem(ACCESS_LOG_STREAM, summaries);
    });
    return this.get(id);
  }

  // The grant that holds this token, read from the store on every call.
  // Returns revoked grants too, so the caller can name the grant in the
  // case history. Compares hashes in constant time.
  findByToken(token: string): GrantView | null {
    if (token.length === 0) return null;
    const hash = Buffer.from(hashToken(token), "hex");
    let found: GrantRecord | null = null;
    for (const g of this.#all().values()) {
      if (g.tokenHash.length === hash.length && timingSafeEqual(g.tokenHash, hash)) found = g;
    }
    return found ? view(found) : null;
  }
}
