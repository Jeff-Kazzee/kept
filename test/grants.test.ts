// SP4.4: the grant store and the grant command. Tokens are made at test
// time and never written to a file.
import { describe, expect, it } from "vitest";
import { runGrantCommand } from "../src/grants/cli.ts";
import { GrantStore, hashToken, tierAllows } from "../src/grants/grants.ts";
import { InvalidRequestError } from "../src/intake/service.ts";
import { EventStore, StaleEditError } from "../src/store/event-log.ts";

describe("grant store", () => {
  it("starts with no grants, so every tier is off by default", () => {
    expect(new GrantStore(new EventStore()).list()).toEqual([]);
  });

  it("creates a named grant with a tier and returns a 32-byte base64url token once", () => {
    const store = new EventStore();
    const grants = new GrantStore(store);
    const { grant, token } = grants.create("  Laptop assistant ", "annotate");
    expect(grant).toMatchObject({ name: "Laptop assistant", tier: "annotate", status: "active", version: 1, revokedAt: null });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    // Only the hash is stored. Neither the view nor any event holds the token.
    const stored = JSON.stringify(store.readAll());
    expect(stored).not.toContain(token);
    expect(stored).toContain(hashToken(token));
    expect(JSON.stringify(grants.list())).not.toContain(hashToken(token));
    expect(grants.findByToken(token)).toMatchObject({ id: grant.id, name: "Laptop assistant" });
    expect(grants.findByToken(`${token}x`)).toBeNull();
    expect(grants.findByToken("")).toBeNull();
    expect(grants.create("Phone assistant", "read").token).not.toBe(token);
  });

  it("checks names and tiers", () => {
    const grants = new GrantStore(new EventStore());
    expect(() => grants.create("", "read")).toThrow(InvalidRequestError);
    expect(() => grants.create("<script>", "read")).toThrow(/letters, digits/);
    expect(() => grants.create("x".repeat(61), "read")).toThrow(InvalidRequestError);
    expect(() => grants.create("Agent", "admin" as never)).toThrow(/Invalid tier/);
    grants.create("Agent", "read");
    expect(() => grants.create("agent", "propose")).toThrow(/already named/);
  });

  it("revokes with an expected version and keeps the grant as a record", () => {
    const grants = new GrantStore(new EventStore());
    const { grant, token } = grants.create("Agent", "propose");
    expect(() => grants.revoke(grant.id, 0)).toThrow(StaleEditError);
    const revoked = grants.revoke(grant.id, 1);
    expect(revoked).toMatchObject({ status: "revoked", version: 2 });
    expect(revoked.revokedAt).not.toBeNull();
    expect(() => grants.revoke(grant.id, 2)).toThrow(/already revoked/);
    expect(grants.list()).toHaveLength(1);
    // The server can still name a revoked grant in the case history.
    expect(grants.findByToken(token)).toMatchObject({ status: "revoked" });
    // A revoked name can be used again.
    expect(grants.create("Agent", "read").grant.status).toBe("active");
  });

  it("orders tiers: read < annotate < propose", () => {
    expect(tierAllows("read", "read")).toBe(true);
    expect(tierAllows("read", "annotate")).toBe(false);
    expect(tierAllows("annotate", "read")).toBe(true);
    expect(tierAllows("annotate", "propose")).toBe(false);
    expect(tierAllows("propose", "annotate")).toBe(true);
  });
});

describe("grant command", () => {
  it("creates, lists and revokes, and prints the token only on create", () => {
    const grants = new GrantStore(new EventStore(), { newId: () => "g-test" });
    const out: string[] = [];
    expect(runGrantCommand(["--", "create", "--name", "Laptop assistant", "--tier", "read"], grants, (l) => out.push(l))).toBe(0);
    const token = out[2]!;
    expect(grants.findByToken(token)?.id).toBe("g-test");
    expect(out[0]).toBe('Created grant g-test "Laptop assistant" with the read tier.');

    const listed: string[] = [];
    expect(runGrantCommand(["list"], grants, (l) => listed.push(l))).toBe(0);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatch(/^g-test {2}active {3}read {6}Laptop assistant {2}created /);

    const revoked: string[] = [];
    expect(runGrantCommand(["revoke", "g-test"], grants, (l) => revoked.push(l))).toBe(0);
    expect(revoked).toEqual(['Revoked grant g-test "Laptop assistant". Its next call fails.']);
    expect([...listed, ...revoked].join("\n")).not.toContain(token);

    const usage: string[] = [];
    expect(runGrantCommand(["create", "--name", "x"], grants, (l) => usage.push(l))).toBe(2);
    expect(usage[0]).toMatch(/^Usage:/);
  });
});
