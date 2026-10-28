// SP4.4: the grant store and the grant command. Tokens are made at test
// time and never written to a file.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TokenFileError, runGrantCommand } from "../src/grants/cli.ts";
import { GrantStore, TOKEN_PATTERN, hashToken, tierAllows } from "../src/grants/grants.ts";
import { InvalidRequestError } from "../src/intake/service.ts";
import { ACCESS_LOG_STREAM } from "../src/records/events.ts";
import { EventStore, StaleEditError } from "../src/store/event-log.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grant-cli-"));
  dirs.push(dir);
  return dir;
};

describe("grant store", () => {
  it("starts with no grants, so every tier is off by default", () => {
    expect(new GrantStore(new EventStore()).list()).toEqual([]);
  });

  it("creates a named grant with a tier and returns a prefixed 32-byte base64url token once (G-b)", () => {
    const store = new EventStore();
    const grants = new GrantStore(store);
    const { grant, token } = grants.create("  Laptop assistant ", "annotate");
    expect(grant).toMatchObject({ name: "Laptop assistant", tier: "annotate", status: "active", version: 1, revokedAt: null });
    expect(token).toMatch(/^appt_[A-Za-z0-9_-]{43}$/);
    expect(token).toMatch(TOKEN_PATTERN);
    expect(Buffer.from(token.slice("appt_".length), "base64url")).toHaveLength(32);
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

  it("G-b: refuses a token of the right shape whose hash is not stored, and an old unprefixed token", () => {
    const store = new EventStore();
    // A grant made with the old format still works, because only the hash
    // decides. A token that matches no stored hash is refused, prefix or not.
    const old = randomBytes(32).toString("base64url");
    const grants = new GrantStore(store, { newToken: () => old });
    const { grant } = grants.create("Old agent", "read");
    expect(grants.findByToken(old)?.id).toBe(grant.id);
    expect(grants.findByToken(`appt_${randomBytes(32).toString("base64url")}`)).toBeNull();
    expect(grants.findByToken(`appt_${old}`)).toBeNull();
  });

  it("G-a: last used is the latest access log entry of each grant, refused calls included", () => {
    const store = new EventStore();
    const grants = new GrantStore(store);
    const a = grants.create("Agent A", "read").grant;
    const b = grants.create("Agent B", "read").grant;
    const entry = (grant_id: string, result: string) => ({ type: "tool_called", data: { grant_id, grant_name: "x", tool: "list_appointments", result, appointment_id: null } });
    store.appendSystem(ACCESS_LOG_STREAM, [entry(a.id, "ok")]);
    store.appendSystem(ACCESS_LOG_STREAM, [entry(a.id, "permission_denied")]);
    const used = grants.lastUsed();
    expect(used.get(a.id)).toBe(store.readStream(ACCESS_LOG_STREAM).at(-1)!.recordedAt);
    expect(used.has(b.id)).toBe(false);
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

  it("G-g: --token-file writes the token with mode 600, prints only the path, and never overwrites", () => {
    const grants = new GrantStore(new EventStore(), { newId: () => "g-file" });
    const file = path.join(tempDir(), "new-dir", "grant-token");
    const out: string[] = [];
    expect(runGrantCommand(["create", "--name", "Laptop assistant", "--tier", "annotate", "--token-file", file], grants, (l) => out.push(l))).toBe(0);
    const token = readFileSync(file, "utf8").trim();
    expect(token).toMatch(TOKEN_PATTERN);
    expect(grants.findByToken(token)?.id).toBe("g-file");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o077).toBe(0);
    expect(out).toEqual(['Created grant g-file "Laptop assistant" with the annotate tier.', `Token written to ${file} (readable by you only). It is not shown here.`]);
    expect(out.join("\n")).not.toContain(token);

    // A second create to the same path refuses and makes no grant.
    expect(() => runGrantCommand(["create", "--name", "Other", "--tier", "read", "--token-file", file], grants, () => {})).toThrow(TokenFileError);
    expect(readFileSync(file, "utf8").trim()).toBe(token);
    expect(grants.list()).toHaveLength(1);
  });

  it("G-g: --token-file refuses a symbolic link at the path, and a bad name leaves no file", () => {
    const dir = tempDir();
    const target = path.join(dir, "target");
    writeFileSync(target, "keep");
    const link = path.join(dir, "link");
    symlinkSync(target, link);
    const grants = new GrantStore(new EventStore());
    expect(() => runGrantCommand(["create", "--name", "A", "--tier", "read", "--token-file", link], grants, () => {})).toThrow(/already exists/);
    expect(readFileSync(target, "utf8")).toBe("keep");

    const file = path.join(dir, "token");
    expect(() => runGrantCommand(["create", "--name", "<bad>", "--tier", "read", "--token-file", file], grants, () => {})).toThrow(InvalidRequestError);
    expect(() => statSync(file)).toThrow();
    expect(grants.list()).toEqual([]);
    // --token-file belongs to create only.
    expect(runGrantCommand(["list", "--token-file", file], grants, () => {})).toBe(2);
  });
});
