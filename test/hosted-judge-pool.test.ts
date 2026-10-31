// Sprint 21 (0023): one shared judge pass, a pool. Each browser that signs
// in with it gets a new judge account, workspace and share, drawn from one
// capped pool, a few an hour. Revoke and grant on a pass, attaching one
// refused, the pool cap under sign-ins from several processes at once, the
// migration of a database made before pools, and the per-judge codes as
// they were.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runAdmin } from "../scripts/admin.ts";
import { addressBucket, clientAddress, countedAddress, FORWARDED_UNKNOWN, isLoopback, parseIp } from "../src/hosted/rate-limit.ts";
import { JUDGE_SHARED_TRY_LIMIT, JUDGE_TRY_LIMIT } from "../server/hosted.ts";
import { AccountsStore, HOUR_MS, JUDGE_CODE, JudgeCodeError, POOL_ACCOUNTS_PER_HOUR, POOL_EMPTY_TEXT, accountsPath, sha256 } from "../src/hosted/store.ts";
import { fixtureMessage } from "./helpers.ts";
import { startHosted, type Browser, type Hosted } from "./hosted-helpers.ts";

let h: Hosted | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const USD = 1_000_000;
const ctx = (accountId: string) => ({ accountId, workspace: accountId, route: "chat", turn: null, model: "m" });
const gen = (state: { generation: number }) => ({ "X-Case-Generation": String(state.generation) });
const idOf = (b: Browser) => h!.app.store.session(b.cookies.get(`appt_session_${h!.port}`)!)!.account.id;

describe("signing in with a shared judge pass", () => {
  it("each browser gets its own judge account, workspace and share, and the same browser keeps its own", async () => {
    h = await startHosted();
    const pool = h.judgePool("Judges", 3, 1);
    expect(pool.code).toMatch(JUDGE_CODE);
    const a = h.browser();
    const b = h.browser();
    const ra = await a.call("POST", "/api/session/judge", { code: pool.code });
    expect(ra.status).toBe(200);
    expect(ra.body).toMatchObject({ signedIn: true, account: { kind: "judge", email: null, pool: true }, balanceMicros: USD, balance: "$1.00" });
    const rb = await b.call("POST", "/api/session/judge", { code: `  ${pool.code} ` });
    expect(rb.body).toMatchObject({ signedIn: true, account: { kind: "judge", pool: true }, balanceMicros: USD });
    const idA = idOf(a);
    const idB = idOf(b);
    expect(idA).not.toBe(idB);
    expect(ra.body.account.owner).not.toBe(rb.body.account.owner);
    for (const id of [idA, idB]) expect(h.app.store.ledger(id)).toEqual([expect.objectContaining({ kind: "grant", amount: USD, source: `judge-pool:${pool.id}` })]);

    // Separate cases: A's message is not in B's case.
    const sa = (await a.call("GET", "/api/state")).body;
    expect((await a.call("POST", "/api/messages", fixtureMessage("m2"), gen(sa))).status).toBe(200);
    expect((await a.call("GET", "/api/state")).body.messages).toHaveLength(1);
    expect((await b.call("GET", "/api/state")).body.messages).toEqual([]);

    // The same browser signing in again keeps its account: no new one, no
    // second share.
    const again = await a.call("POST", "/api/session/judge", { code: pool.code });
    expect(again.status).toBe(200);
    expect(idOf(a)).toBe(idA);
    expect((await a.call("GET", "/api/state")).body.messages).toHaveLength(1);
    expect(h.app.store.listJudgePools()[0]).toMatchObject({ accounts: 2, grantedMicros: 2 * USD, leftMicros: USD, status: "open" });
    // The pass's accounts are not listed as codes.
    expect(h.app.store.listJudgeCodes()).toEqual([]);
    // The session view says so after a reload too.
    expect((await b.call("GET", "/api/session")).body.account.pool).toBe(true);
    // The code is in no log line.
    expect(h.logs.join("\n")).not.toContain(pool.code);
  });

  it("refuses with a clear message once less than one share is left", async () => {
    h = await startHosted();
    const pool = h.judgePool("Judges", 2.5, 1);
    for (let i = 0; i < 2; i++) expect((await h.browser().call("POST", "/api/session/judge", { code: pool.code })).status).toBe(200);
    const late = await h.browser().call("POST", "/api/session/judge", { code: pool.code });
    expect(late.status).toBe(409);
    expect(late.body).toEqual({ error: "judge_pool_empty", message: POOL_EMPTY_TEXT });
    expect(late.headers["set-cookie"]).toBeUndefined();
    expect(h.app.store.listJudgePools()[0]).toMatchObject({ accounts: 2, grantedMicros: 2 * USD, leftMicros: 0.5 * USD, status: "used_up" });
  });

  it("a pass cannot be added to an email account, and a pass's account takes no code", async () => {
    h = await startHosted();
    const pool = h.judgePool();
    const u = h.browser();
    await h.signUp(u);
    const r = await u.call("POST", "/api/account/judge-code", { code: pool.code });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("judge_pool_attach");
    expect(r.body.message).toMatch(/shared judge pass/);
    expect(h.app.store.balance(await h.accountOf(u))).toBe(0);
    expect(h.app.store.listJudgePools()[0]!.accounts).toBe(0);
    const j = h.browser();
    await j.call("POST", "/api/session/judge", { code: pool.code });
    expect((await j.call("POST", "/api/account/judge-code", { code: h.judgeCode("x", 1).code })).body.error).toBe("judge_judge_account");
    expect((await j.call("POST", "/api/account/judge-code", { code: pool.code })).body.error).toBe("judge_pool_attach");
    expect((await j.call("GET", "/api/usage")).body.canAddCode).toBe(false);
  });

  it("makes at most the hourly number of accounts per pass, and a few per address", async () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    h = await startHosted({ now: () => now });
    const pool = h.judgePool("Judges", 20, 1);
    // From loopback with no forwarded address, only the pass's own limit.
    const first = h.browser();
    expect((await first.call("POST", "/api/session/judge", { code: pool.code })).status).toBe(200);
    for (let i = 1; i < POOL_ACCOUNTS_PER_HOUR; i++) expect((await h.browser().call("POST", "/api/session/judge", { code: pool.code })).status).toBe(200);
    const over = await h.browser().call("POST", "/api/session/judge", { code: pool.code });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("judge_pool_throttled");
    // A browser that already has its account from the pass still gets it.
    const own = idOf(first);
    expect((await first.call("POST", "/api/session/judge", { code: pool.code })).status).toBe(200);
    expect(idOf(first)).toBe(own);
    now += HOUR_MS + 1;
    // Per address, as the trusted proxy gives it: two an hour.
    const ip = { "CF-Connecting-IP": "203.0.113.9" };
    expect((await h.browser().call("POST", "/api/session/judge", { code: pool.code }, ip)).status).toBe(200);
    expect((await h.browser().call("POST", "/api/session/judge", { code: pool.code }, ip)).status).toBe(200);
    const third = await h.browser().call("POST", "/api/session/judge", { code: pool.code }, ip);
    expect(third.status).toBe(429);
    expect(third.body.error).toBe("judge_pool_throttled");
    expect((await h.browser().call("POST", "/api/session/judge", { code: pool.code }, { "CF-Connecting-IP": "203.0.113.10" })).status).toBe(200);
    // A per-judge code from the same address is not held back by it.
    expect((await h.browser().call("POST", "/api/session/judge", { code: h.judgeCode("Ada", 1).code }, ip)).status).toBe(200);
    expect(h.app.store.listJudgePools()[0]!.accounts).toBe(POOL_ACCOUNTS_PER_HOUR + 3);
  });

  it("revoking a pass ends its accounts' sessions, takes their unspent share, and refuses new sign-ins", async () => {
    h = await startHosted();
    const pool = h.judgePool("Judges", 3, 1);
    const a = h.browser();
    const b = h.browser();
    await a.call("POST", "/api/session/judge", { code: pool.code });
    await b.call("POST", "/api/session/judge", { code: pool.code });
    const idA = idOf(a);
    const idB = idOf(b);
    const store = h.app.store;
    // A spent 0.25. B has a call in flight when the pass is revoked.
    const holdA = store.hold(ctx(idA), 250_000, 10_000, 20 * USD);
    expect(holdA.ok).toBe(true);
    store.settle((holdA as { holdId: number }).holdId, null);
    const holdB = store.hold(ctx(idB), 400_000, 10_000, 20 * USD);
    expect(holdB.ok).toBe(true);
    store.revokeJudgeCode(pool.id);
    expect((await a.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect(store.balance(idA)).toBe(0);
    expect(store.ledger(idA).at(-1)).toMatchObject({ kind: "adjust", amount: -750_000 });
    // B's share is owed while its call runs: nothing to spend, and taken
    // once the call settles.
    expect(store.balance(idB)).toBe(0);
    expect(store.hold(ctx(idB), 1, 1, 20 * USD)).toEqual({ ok: false, reason: "credits" });
    store.settle((holdB as { holdId: number }).holdId, { usage: { input: 1, cachedInput: 0, output: 1, reasoning: 0 }, amountMicros: 100_000, costMicros: 5_000 });
    expect(store.balance(idB)).toBe(0);
    expect(store.ledger(idB).at(-1)).toMatchObject({ kind: "adjust", amount: -900_000 });
    const refused = await h.browser().call("POST", "/api/session/judge", { code: pool.code });
    expect(refused.body.error).toBe("judge_revoked");
    expect(store.listJudgePools()[0]).toMatchObject({ status: "revoked", spentMicros: 350_000 });
    // A revoked pass counts only what its accounts spent.
    expect(store.judgeTotals().committedMicros).toBe(350_000);
    // Again is a no-op.
    store.revokeJudgeCode(pool.id);
    expect(store.ledger(idA).filter((r) => r.kind === "adjust")).toHaveLength(1);
  });

  it("grant raises a pass's pool within the total cap, and never on one of its accounts", async () => {
    h = await startHosted({ env: { APP_JUDGE_TOTAL_CAP_USD: "5" } });
    const pool = h.judgePool("Judges", 1, 1);
    expect((await h.browser().call("POST", "/api/session/judge", { code: pool.code })).status).toBe(200);
    expect((await h.browser().call("POST", "/api/session/judge", { code: pool.code })).body.error).toBe("judge_pool_empty");
    const store = h.app.store;
    expect(() => store.grantJudgeCode(pool.id, 5 * USD, 5 * USD)).toThrow(/total cap/);
    store.grantJudgeCode(pool.id, 2 * USD, 5 * USD);
    expect(store.judgeTotals().committedMicros).toBe(3 * USD);
    const b = h.browser();
    expect((await b.call("POST", "/api/session/judge", { code: pool.code })).body.balanceMicros).toBe(USD);
    // A pass's account is a row of its own, and grant on it is refused.
    const db = new DatabaseSync(path.join(h.dir, "hosted", "accounts.sqlite"), { readOnly: true, timeout: 5_000 });
    const member = String((db.prepare("SELECT id FROM judge_codes WHERE account_id = ?").get(idOf(b)) as { id: string }).id);
    db.close();
    expect(() => store.grantJudgeCode(member, USD, 5 * USD)).toThrow(JudgeCodeError);
    expect(store.balance(idOf(b))).toBe(USD);
    // A new code cannot pass the cap the pool already holds.
    expect(() => h!.judgeCode("x", 3)).toThrow(/total cap/);
    store.revokeJudgeCode(pool.id);
    expect(() => store.grantJudgeCode(pool.id, USD, 5 * USD)).toThrow(/revoked/);
  });

  it("an expired pass signs in nobody, and its accounts' sessions end", async () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    h = await startHosted({ now: () => now });
    const pool = h.judgePool("Judges", 3, 1, 2);
    const a = h.browser();
    await a.call("POST", "/api/session/judge", { code: pool.code });
    now += 2 * 86_400_000 + 1;
    expect((await a.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect((await h.browser().call("POST", "/api/session/judge", { code: pool.code })).body.error).toBe("judge_expired");
    expect(h.app.store.listJudgePools()[0]!.status).toBe("expired");
  });
});

describe("fix round 1", () => {
  const KEY = "k".repeat(43);

  it("finding 1: a forwarded address is one plain address that is not loopback, or the shared one, and with no proxy every header is ignored", async () => {
    expect(clientAddress({ "cf-connecting-ip": "203.0.113.9" }, "127.0.0.1", "cloudflare")).toBe("203.0.113.9");
    for (const claim of ["127.0.0.1", "::1", "::ffff:127.0.0.2", "junk", "203.0.113.9, 198.51.100.1", "x".repeat(64), "", "fe80::1%eth0"]) {
      expect(clientAddress({ "cf-connecting-ip": claim }, "127.0.0.1", "cloudflare")).toBe(FORWARDED_UNKNOWN);
      expect(clientAddress({ "x-forwarded-for": claim }, "::1", "tailscale")).toBe(FORWARDED_UNKNOWN);
    }
    expect(clientAddress({ "cf-connecting-ip": ["203.0.113.9", "203.0.113.10"] }, "127.0.0.1", "cloudflare")).toBe(FORWARDED_UNKNOWN);
    // Only a socket with no forwarding header is this server's own.
    expect(clientAddress({}, "127.0.0.1", "cloudflare")).toBe("127.0.0.1");
    for (const claim of ["127.0.0.1", "203.0.113.9", "junk"]) {
      expect(clientAddress({ "cf-connecting-ip": claim, "x-forwarded-for": claim }, "127.0.0.1", "none")).toBe("127.0.0.1");
    }
    expect(isLoopback(FORWARDED_UNKNOWN)).toBe(false);
    expect(parseIp("2001:DB8::7")).toBe("2001:db8::7");
    expect(parseIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressBucket("2001:db8:1:2:3:4:5:6")).toBe(addressBucket("2001:db8:1:2:ffff::1"));
    expect(addressBucket("2001:db8:1:2::")).not.toBe(addressBucket("2001:db8:1:3::"));

    // Fix round 2: only one plain client IP is counted per address.
    expect(countedAddress("203.0.113.9")).toBe("203.0.113.9");
    for (const a of [FORWARDED_UNKNOWN, "127.0.0.1", "::1", "unknown", ""]) expect(countedAddress(a)).toBeNull();
  });

  it("fix round 2: the shared unknown address is not counted per address, for accounts or for code tries", async () => {
    h = await startHosted();
    const pool = h.judgePool("Judges", 20, 1);
    // Loopback and junk claims all become the shared address. They are
    // bound by the pass's 6 an hour, not by 2 an address.
    const tries: number[] = [];
    for (const claim of ["127.0.0.1", "junk", "::1", "a, b", "x", "0.0.0.0", "y"]) tries.push((await h.browser().call("POST", "/api/session/judge", { code: pool.code }, { "CF-Connecting-IP": claim })).status);
    expect(tries).toEqual([...Array(POOL_ACCOUNTS_PER_HOUR).fill(200), 429]);
    // Code tries with no counted address share the wider ceiling, so more
    // than 10 wrong tries lock no one out.
    const second = h.judgePool("Second", 5, 1);
    const wrong: number[] = [];
    for (let i = 0; i < JUDGE_TRY_LIMIT.limit + 5; i++) wrong.push((await h.browser().call("POST", "/api/session/judge", { code: `judge_${"W".repeat(43)}` }, { "CF-Connecting-IP": "junk" })).status);
    expect(wrong.every((st) => st === 404)).toBe(true);
    expect((await h.browser().call("POST", "/api/session/judge", { code: second.code }, { "CF-Connecting-IP": "junk" })).status).toBe(200);
    // A real address is its own, with its own limits.
    expect((await h.browser().call("POST", "/api/session/judge", { code: second.code }, { "CF-Connecting-IP": "203.0.113.20" })).status).toBe(200);
    expect((await h.browser().call("POST", "/api/session/judge", { code: second.code }, { "CF-Connecting-IP": "203.0.113.20" })).status).toBe(200);
    expect((await h.browser().call("POST", "/api/session/judge", { code: second.code }, { "CF-Connecting-IP": "203.0.113.20" })).body.error).toBe("judge_pool_throttled");
  });

  it("fix round 2: the shared ceiling for code tries holds", async () => {
    h = await startHosted();
    const statuses: number[] = [];
    for (let i = 0; i < JUDGE_SHARED_TRY_LIMIT.limit + 1; i++) statuses.push((await h.raw("POST", "/api/session/judge", { "Content-Type": "application/json", Origin: `http://127.0.0.1:${h.port}`, "X-Appointments-App": "1" }, { code: "x" })).status);
    expect(statuses.slice(0, JUDGE_SHARED_TRY_LIMIT.limit).every((st) => st === 404)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // A counted address still has its own tries.
    expect((await h.browser().call("POST", "/api/session/judge", { code: "x" }, { "CF-Connecting-IP": "203.0.113.70" })).status).toBe(404);
  }, 30_000);

  it("finding 1: with no proxy set, forwarding headers are ignored and loopback counts only against the pass", async () => {
    h = await startHosted({ env: { APP_TRUSTED_PROXY: "none" } });
    const pool = h.judgePool("Judges", 10, 1);
    const tries: number[] = [];
    for (let i = 0; i < POOL_ACCOUNTS_PER_HOUR + 1; i++) tries.push((await h.browser().call("POST", "/api/session/judge", { code: pool.code }, { "CF-Connecting-IP": "203.0.113.30", "X-Forwarded-For": "203.0.113.30" })).status);
    expect(tries).toEqual([...Array(POOL_ACCOUNTS_PER_HOUR).fill(200), 429]);
  });

  it("finding 2: a retried or doubled first sign-in with the same key gives one account and one share", async () => {
    h = await startHosted();
    const pool = h.judgePool("Judges", 10, 1);
    const a1 = h.browser();
    const a2 = h.browser();
    // Two at once, neither with a cookie, as a double click or a retry.
    const [r1, r2] = await Promise.all([a1.call("POST", "/api/session/judge", { code: pool.code, key: KEY }), a2.call("POST", "/api/session/judge", { code: pool.code, key: KEY })]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(idOf(a1)).toBe(idOf(a2));
    // Each got its own session.
    expect(a1.cookies.get(`appt_session_${h.port}`)).not.toBe(a2.cookies.get(`appt_session_${h.port}`));
    expect(h.app.store.listJudgePools()[0]).toMatchObject({ accounts: 1, grantedMicros: USD });
    // Only the key's hash, bound to the pass, is stored.
    const keyOf = (accountId: string) => {
      const db = new DatabaseSync(path.join(h!.dir, "hosted", "accounts.sqlite"), { readOnly: true, timeout: 5_000 });
      const r = db.prepare("SELECT signin_key FROM judge_codes WHERE account_id = ?").get(accountId) as { signin_key: string | null };
      db.close();
      return r.signin_key;
    };
    const first = idOf(a2);
    expect(keyOf(first)).toBe(sha256(`judge-pool-signin:${pool.id}:${KEY}`));
    expect(keyOf(first)).not.toContain(KEY);
    // Fix round 2: signing out ends the key. The same key then makes a new
    // account, and the old one stays signed in only where it still is.
    await a1.call("POST", "/api/session/signout", {});
    expect(keyOf(first)).toBeNull();
    expect((await a2.call("GET", "/api/session")).body.signedIn).toBe(true);
    const back = h.browser();
    await back.call("POST", "/api/session/judge", { code: pool.code, key: KEY });
    expect(idOf(back)).not.toBe(first);
    // A sign-in to another account in that browser ends the key too: here
    // a per-judge code, then a retry with the key and no cookie.
    const rebound = idOf(back);
    expect(keyOf(rebound)).toBe(sha256(`judge-pool-signin:${pool.id}:${KEY}`));
    await back.call("POST", "/api/session/judge", { code: h.judgeCode("Bo", 1).code, key: KEY });
    expect(keyOf(rebound)).toBeNull();
    // Signing in with the pass again from its own session keeps the key.
    const keeper = h.browser();
    await keeper.call("POST", "/api/session/judge", { code: pool.code, key: "q".repeat(43) });
    await keeper.call("POST", "/api/session/judge", { code: pool.code, key: "q".repeat(43) });
    expect(keyOf(idOf(keeper))).toBe(sha256(`judge-pool-signin:${pool.id}:${"q".repeat(43)}`));
    // Another key, or none, is another browser.
    const other = h.browser();
    await other.call("POST", "/api/session/judge", { code: pool.code, key: "o".repeat(43) });
    const none = h.browser();
    await none.call("POST", "/api/session/judge", { code: pool.code });
    expect(new Set([idOf(a2), idOf(other), idOf(none)]).size).toBe(3);
    expect(keyOf(idOf(none))).toBeNull();
    // The key is bound to its pass: on another pass it makes a new account.
    const second = h.judgePool("Others", 3, 1);
    await a2.call("POST", "/api/session/judge", { code: pool.code, key: KEY });
    const elsewhere = h.browser();
    await elsewhere.call("POST", "/api/session/judge", { code: second.code, key: KEY });
    expect(idOf(elsewhere)).not.toBe(idOf(a2));
    // A per-judge code ignores it.
    const coded = h.browser();
    await coded.call("POST", "/api/session/judge", { code: h.judgeCode("Ada", 1).code, key: KEY });
    expect(idOf(coded)).not.toBe(idOf(a2));
    // A key of another shape is refused before anything happens.
    for (const key of ["short", "k".repeat(44), "k".repeat(42) + "!", 7]) expect((await h.browser().call("POST", "/api/session/judge", { code: pool.code, key })).status).toBe(400);
    // The key is in no log line, and only its hash is kept.
    expect(h.logs.join("\n")).not.toContain(KEY);
  });

  it("finding 2: once the key's account is deleted, the key makes a new one", async () => {
    h = await startHosted();
    const pool = h.judgePool("Judges", 10, 1);
    const a = h.browser();
    await a.call("POST", "/api/session/judge", { code: pool.code, key: KEY });
    const first = idOf(a);
    expect((await a.call("POST", "/api/account/delete", { confirmation: "DELETE" })).status).toBe(200);
    const b = h.browser();
    expect((await b.call("POST", "/api/session/judge", { code: pool.code, key: KEY })).status).toBe(200);
    expect(idOf(b)).not.toBe(first);
    expect(h.app.store.listJudgePools()[0]!.accounts).toBe(2);
  });

  it("fix round 2: a key whose account was revoked is refused and keeps its binding", () => {
    const file = path.join(tempDir("pool-key-revoked-"), "accounts.sqlite");
    const store = new AccountsStore(file);
    const pool = store.createJudgePool({ label: "J", poolMicros: 5 * USD, shareMicros: USD, expiresAt: Date.now() + 86_400_000, totalCapMicros: 100 * USD });
    const id = store.judgeSignIn(pool.code, { key: KEY }).account.id;
    store.close();
    // Not reachable through the admin (finding 4), so set by hand.
    const db = new DatabaseSync(file);
    db.prepare("UPDATE judge_codes SET revoked_at = ? WHERE account_id = ?").run(Date.now(), id);
    db.close();
    const again = new AccountsStore(file);
    expect(() => again.judgeSignIn(pool.code, { key: KEY })).toThrow(expect.objectContaining({ code: "revoked" }));
    expect(again.listJudgePools()[0]!.accounts).toBe(1);
    again.close();
    const check = new DatabaseSync(file, { readOnly: true });
    expect((check.prepare("SELECT signin_key FROM judge_codes WHERE account_id = ?").get(id) as { signin_key: string }).signin_key).toBe(sha256(`judge-pool-signin:${pool.id}:${KEY}`));
    check.close();
  });

  it("finding 3: a judge account takes no new hold once its pass or code expired or was revoked", () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    const store = new AccountsStore(path.join(tempDir("pool-hold-"), "accounts.sqlite"), { now: () => now });
    const pool = store.createJudgePool({ label: "J", poolMicros: 5 * USD, shareMicros: USD, expiresAt: now + 86_400_000, totalCapMicros: 100 * USD });
    const pooled = store.judgeSignIn(pool.code).account.id;
    const code = store.createJudgeCode({ label: "C", capMicros: USD, expiresAt: now + 3 * 86_400_000, totalCapMicros: 100 * USD });
    const coded = store.redeemJudgeCode(code.code).id;
    // A hold taken before the pass expires still settles after it.
    const before = store.hold(ctx(pooled), 300_000, 10, 20 * USD);
    expect(before.ok).toBe(true);
    now += 86_400_000;
    expect(store.hold(ctx(pooled), 1000, 10, 20 * USD)).toEqual({ ok: false, reason: "credits" });
    expect(store.settle((before as { holdId: number }).holdId, { usage: { input: 10, cachedInput: 0, output: 5, reasoning: 0 }, amountMicros: 120_000, costMicros: 40_000 })).toEqual({ charged: 120_000 });
    expect(store.ledger(pooled).map((r) => [r.kind, r.amount])).toEqual([
      ["grant", USD],
      ["hold", 300_000],
      ["charge", 120_000],
      ["release", 180_000],
    ]);
    expect(store.balance(pooled)).toBe(USD - 120_000);
    expect(store.hold(ctx(coded), 1000, 10, 20 * USD).ok).toBe(true);
    store.revokeJudgeCode(code.id);
    expect(store.hold(ctx(coded), 1000, 10, 20 * USD)).toEqual({ ok: false, reason: "credits" });
    store.close();
  });

  it("finding 4: one of a pass's accounts is not revoked alone", async () => {
    h = await startHosted();
    const pool = h.judgePool("Judges", 3, 1);
    const a = h.browser();
    await a.call("POST", "/api/session/judge", { code: pool.code });
    const db = new DatabaseSync(path.join(h.dir, "hosted", "accounts.sqlite"), { readOnly: true, timeout: 5_000 });
    const member = String((db.prepare("SELECT id FROM judge_codes WHERE account_id = ?").get(idOf(a)) as { id: string }).id);
    db.close();
    let refused: unknown = null;
    try {
      h.app.store.revokeJudgeCode(member);
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(JudgeCodeError);
    expect((refused as JudgeCodeError).code).toBe("pool_member");
    expect((refused as JudgeCodeError).message).toContain(pool.id);
    expect((await a.call("GET", "/api/session")).body.signedIn).toBe(true);
  });

  it("finding 5: the per-address count is a sliding hour kept in the database, across processes", () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    const file = path.join(tempDir("pool-address-"), "accounts.sqlite");
    const one = new AccountsStore(file, { now: () => now });
    const p1 = one.createJudgePool({ label: "A", poolMicros: 10 * USD, shareMicros: USD, expiresAt: now + 86_400_000, totalCapMicros: 100 * USD });
    const p2 = one.createJudgePool({ label: "B", poolMicros: 10 * USD, shareMicros: USD, expiresAt: now + 86_400_000, totalCapMicros: 100 * USD });
    one.judgeSignIn(p1.code, { address: "203.0.113.40" });
    now += 50 * 60_000;
    one.judgeSignIn(p1.code, { address: "203.0.113.40" });
    one.close();
    // Neither loopback nor the shared unknown address is counted.
    for (let i = 0; i < 3; i++) one.judgeSignIn(p1.code, { address: i % 2 ? "127.0.0.1" : FORWARDED_UNKNOWN });
    // Another process, another pass: the same address is full.
    const two = new AccountsStore(file, { now: () => now });
    expect(() => two.judgeSignIn(p2.code, { address: "203.0.113.40" })).toThrow(expect.objectContaining({ code: "pool_throttled" }));
    // An IPv6 address counts by its /64.
    two.judgeSignIn(p2.code, { address: "2001:db8:1:2::1" });
    two.judgeSignIn(p2.code, { address: "2001:db8:1:2::2" });
    expect(() => two.judgeSignIn(p2.code, { address: "2001:db8:1:2:ffff::3" })).toThrow(expect.objectContaining({ code: "pool_throttled" }));
    // Sliding: an hour after the first sign-in, one more fits, not two.
    now += 10 * 60_000 + 1;
    two.judgeSignIn(p2.code, { address: "203.0.113.40" });
    expect(() => two.judgeSignIn(p2.code, { address: "203.0.113.40" })).toThrow(expect.objectContaining({ code: "pool_throttled" }));
    // The sweep forgets addresses whose hour is over.
    now += HOUR_MS;
    two.sweepSessions();
    two.close();
    const db = new DatabaseSync(file, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) AS n FROM judge_codes WHERE signin_address IS NOT NULL").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

// Runs `script` in `count` node processes at once, each with `env`, and
// gives back the last JSON line each printed.
function inProcesses(count: number, script: string, env: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const run = () =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", () => {
        try {
          resolve(JSON.parse(out.trim().split("\n").at(-1)!));
        } catch {
          reject(new Error(`A child gave no answer: ${err.slice(0, 500)}`));
        }
      });
    });
  return Promise.all(Array.from({ length: count }, run));
}

const STORE_URL = new URL("../src/hosted/store.ts", import.meta.url).href;

describe("the pool cap under sign-ins from several processes at once", () => {
  // Each process opens the file, waits for the same moment, then signs in.
  const script = `
    import { AccountsStore } from ${JSON.stringify(STORE_URL)};
    const store = new AccountsStore(process.env.POOL_FILE);
    store.account("a" + "0".repeat(32));
    while (Date.now() < Number(process.env.POOL_START)) {}
    try {
      const r = store.judgeSignIn(process.env.POOL_CODE);
      console.log(JSON.stringify({ ok: true, id: r.account.id }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, code: e.code ?? e.name }));
    }
    store.close();`;

  const race = async (shares: number, tries: number) => {
    const file = path.join(tempDir("pool-race-"), "accounts.sqlite");
    const setup = new AccountsStore(file);
    const { code, id } = setup.createJudgePool({ label: "Race", poolMicros: shares * USD, shareMicros: USD, expiresAt: Date.now() + 86_400_000, totalCapMicros: 100 * USD });
    setup.close();
    const results = await inProcesses(tries, script, { POOL_FILE: file, POOL_CODE: code, POOL_START: String(Date.now() + 1_500) });
    const made = results.filter((r) => r.ok);
    const store = new AccountsStore(file);
    const pool = store.listJudgePools()[0]!;
    const balances = made.map((r) => store.balance(String(r.id)));
    store.close();
    return { id, made, refused: results.filter((r) => !r.ok).map((r) => r.code), pool, balances };
  };

  it("never grants more than the pool", async () => {
    // Five shares for twelve sign-ins, all inside the hourly limit.
    const r = await race(5, 12);
    expect(r.made).toHaveLength(5);
    expect(new Set(r.made.map((m) => m.id)).size).toBe(5);
    expect(r.refused).toEqual(Array(7).fill("pool_empty"));
    expect(r.pool).toMatchObject({ id: r.id, accounts: 5, grantedMicros: 5 * USD, leftMicros: 0 });
    expect(r.balances).toEqual(Array(5).fill(USD));
  }, 30_000);

  it("never makes more than the hourly limit", async () => {
    // Fix round 1, finding 6: eight shares for twelve sign-ins, so the
    // hourly limit binds first.
    const r = await race(8, 12);
    expect(r.made).toHaveLength(POOL_ACCOUNTS_PER_HOUR);
    expect(r.refused).toEqual(Array(12 - POOL_ACCOUNTS_PER_HOUR).fill("pool_throttled"));
    expect(r.pool).toMatchObject({ accounts: POOL_ACCOUNTS_PER_HOUR, grantedMicros: POOL_ACCOUNTS_PER_HOUR * USD, leftMicros: (8 - POOL_ACCOUNTS_PER_HOUR) * USD });
  }, 30_000);
});

describe("the admin command for a shared pass", () => {
  const adminEnv = (extra: Record<string, string> = {}) => ({ APP_DB: path.join(tempDir("admin-pool-"), "app.sqlite"), APP_JUDGE_TOTAL_CAP_USD: "100", ...extra });
  const now = () => Date.parse("2026-11-01T12:00:00Z");

  it("create-pool prints the code once, and list, grant and revoke work on the pass", () => {
    const env = adminEnv();
    const made = runAdmin(["judges", "create-pool", "--label", "Judges", "--pool-usd", "30", "--per-judge-usd", "3", "--expires", "2026-11-30"], env, now);
    expect(made.code).toBe(0);
    expect(made.out[0]).toMatch(/^Made shared judge pass p[0-9a-f]{12} for "Judges", pool \$30\.00, \$3\.00 per judge \(10 accounts\), works through 2026-11-30 UTC\.$/);
    const code = made.out.find((l) => JUDGE_CODE.test(l))!;
    expect(code).toBeTruthy();
    const id = made.out[0]!.split(" ")[4]!;
    const store = new AccountsStore(accountsPath(env), { now });
    store.judgeSignIn(code);
    store.close();
    const list = runAdmin(["judges", "list"], env, now);
    expect(list.out.join("\n")).not.toContain(code);
    expect(list.out[0]).toBe(`${id}  "Judges"  shared pass, pool $30.00  $3.00 per judge  1 account(s)  granted $3.00  left $27.00  spent $0.00  open  through 2026-11-30`);
    expect(list.out.at(-1)).toBe("Committed $30.00 of the $100.00 total cap.");
    expect(runAdmin(["judges", "create-pool", "--label", "Big", "--pool-usd", "71", "--per-judge-usd", "1", "--expires", "2026-11-30"], env, now).code).toBe(1);
    expect(runAdmin(["judges", "create-pool", "--label", "Odd", "--pool-usd", "1", "--per-judge-usd", "2", "--expires", "2026-11-30"], env, now).err[0]).toMatch(/more than the pool/);
    expect(runAdmin(["judges", "create-pool", "--label", "No share", "--pool-usd", "1", "--expires", "2026-11-30"], env, now).code).toBe(2);
    expect(runAdmin(["judges", "grant", "--id", id, "--usd", "5"], env, now).out[0]).toBe(`Added $5.00 to the pool of shared judge pass ${id}.`);
    expect(runAdmin(["judges", "list"], env, now).out[0]).toContain("pool $35.00");
    expect(runAdmin(["judges", "revoke", "--id", id], env, now).out[0]).toBe(`Revoked shared judge pass ${id} and every account it made.`);
    expect(runAdmin(["judges", "list"], env, now).out).toEqual([
      `${id}  "Judges"  shared pass, pool $35.00  $3.00 per judge  1 account(s)  granted $3.00  left $32.00  spent $0.00  revoked  through 2026-11-30`,
      "Committed $0.00 of the $100.00 total cap.",
    ]);
  });

  it("refuses create-pool while the total cap is unset", () => {
    const r = runAdmin(["judges", "create-pool", "--label", "J", "--pool-usd", "3", "--per-judge-usd", "1", "--expires", "2026-11-30"], adminEnv({ APP_JUDGE_TOTAL_CAP_USD: "" }), now);
    expect(r.code).toBe(2);
    expect(r.err[0]).toMatch(/APP_JUDGE_TOTAL_CAP_USD is not set/);
  });
});

// The accounts schema before sprint 21, as `dev` 058f69a made it, with the
// columns that earlier migrations add already there.
const OLD_SCHEMA = `
CREATE TABLE accounts (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('google', 'judge', 'user')), google_sub TEXT UNIQUE, auth_user TEXT UNIQUE, email TEXT, name TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER, closed_user TEXT) STRICT;
CREATE TABLE sessions (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts (id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts (id),
  kind TEXT NOT NULL CHECK (kind IN ('grant', 'hold', 'charge', 'release', 'refund', 'adjust')),
  amount INTEGER NOT NULL, cost INTEGER NOT NULL DEFAULT 0, hold_id INTEGER, open INTEGER NOT NULL DEFAULT 0, source TEXT, workspace TEXT, route TEXT, turn TEXT, model TEXT,
  input INTEGER NOT NULL DEFAULT 0, cached_input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
  uncollected INTEGER NOT NULL DEFAULT 0, whole_hold INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, CHECK (kind = 'adjust' OR amount >= 0)) STRICT;
CREATE TABLE judge_codes (
  id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, cap INTEGER NOT NULL CHECK (cap > 0), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  revoked_at INTEGER, account_id TEXT UNIQUE REFERENCES accounts (id), redeemed_at INTEGER, revoke_due INTEGER NOT NULL DEFAULT 0, revoke_hold_max INTEGER NOT NULL DEFAULT 0) STRICT;`;

// An old-schema file: 11 codes, a judge account with a grant, a charge, a
// session and an open hold, a revoked code whose account still owes its
// credit behind an open hold, and a code on an email account.
function oldDatabase(file: string) {
  const at = Date.parse("2026-10-30T12:00:00Z");
  const codes = Array.from({ length: 11 }, (_, i) => `judge_${String(i).padStart(2, "0")}${"Q".repeat(41)}`);
  const judge = `a${"1".repeat(32)}`;
  const revoked = `a${"2".repeat(32)}`;
  const user = `a${"3".repeat(32)}`;
  const authUser = "U".repeat(32);
  const token = "T".repeat(43);
  const db = new DatabaseSync(file);
  // As the app made it: in WAL.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(OLD_SCHEMA);
  db.prepare("INSERT INTO accounts (id, kind, created_at) VALUES (?, 'judge', ?)").run(judge, at);
  db.prepare("INSERT INTO accounts (id, kind, created_at) VALUES (?, 'judge', ?)").run(revoked, at);
  db.prepare("INSERT INTO accounts (id, kind, auth_user, email, name, created_at) VALUES (?, 'user', ?, 'dana@example.com', 'Dana Demo', ?)").run(user, authUser, at);
  const owner = [judge, null, revoked, user];
  codes.forEach((code, i) => {
    db.prepare("INSERT INTO judge_codes (id, hash, label, cap, expires_at, created_at, account_id, redeemed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      `j${String(i).padStart(12, "0")}`,
      sha256(code),
      `Judge ${i}`,
      5 * USD,
      at + 30 * 86_400_000,
      at,
      owner[i] ?? null,
      owner[i] ? at : null,
    );
  });
  const row = (sql: string, ...v: Array<string | number>) => Number(db.prepare(sql).run(...v).lastInsertRowid);
  for (const [account, id] of [
    [judge, "j000000000000"],
    [revoked, "j000000000002"],
    [user, "j000000000003"],
  ] as const)
    row("INSERT INTO ledger (account_id, kind, amount, source, created_at) VALUES (?, 'grant', ?, ?, ?)", account, 5 * USD, `judge:${id}`, at);
  row("INSERT INTO ledger (account_id, kind, amount, cost, created_at) VALUES (?, 'charge', ?, ?, ?)", judge, 120_000, 40_000, at);
  const judgeHold = row("INSERT INTO ledger (account_id, kind, amount, cost, open, workspace, route, model, created_at) VALUES (?, 'hold', ?, ?, 1, ?, 'chat', 'm', ?)", judge, 300_000, 100_000, judge, at);
  const revokedHold = row("INSERT INTO ledger (account_id, kind, amount, cost, open, workspace, route, model, created_at) VALUES (?, 'hold', ?, ?, 1, ?, 'chat', 'm', ?)", revoked, 200_000, 50_000, revoked, at);
  db.prepare("UPDATE judge_codes SET revoked_at = ?, revoke_due = ?, revoke_hold_max = ? WHERE id = 'j000000000002'").run(at, 5 * USD, revokedHold);
  db.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), judge, at, at + 30 * 86_400_000);
  db.close();
  return { codes, judge, revoked, user, authUser, token, judgeHold, revokedHold };
}

describe("a database made before shared passes", () => {
  it("keeps every code, account, session, hold, owed credit and ledger row, and then takes a pass", () => {
    const file = path.join(tempDir("pool-migrate-"), "accounts.sqlite");
    const now = () => Date.parse("2026-11-01T12:00:00Z");
    const old = oldDatabase(file);

    const store = new AccountsStore(file, { now });
    const list = store.listJudgeCodes();
    expect(list).toHaveLength(11);
    expect(list[0]).toMatchObject({ id: "j000000000000", status: "redeemed", capMicros: 5 * USD, spentMicros: 120_000, accountKind: "judge" });
    expect(list[2]).toMatchObject({ id: "j000000000002", status: "revoked", accountKind: "judge" });
    expect(list[3]).toMatchObject({ id: "j000000000003", status: "redeemed", accountKind: "user" });
    expect(list.filter((c) => c.status === "unused")).toHaveLength(8);
    // The session still signs in, the email account is still its user's.
    expect(store.session(old.token)?.account.id).toBe(old.judge);
    expect(store.accountOfUser(old.authUser)?.id).toBe(old.user);
    expect(store.balance(old.user)).toBe(5 * USD);
    // The judge account's open hold is still held, and settles.
    expect(store.ledger(old.judge).map((r) => [r.kind, r.amount, r.open])).toEqual([
      ["grant", 5 * USD, false],
      ["charge", 120_000, false],
      ["hold", 300_000, true],
    ]);
    expect(store.balance(old.judge)).toBe(5 * USD - 120_000 - 300_000);
    store.settle(old.judgeHold, null);
    expect(store.balance(old.judge)).toBe(5 * USD - 420_000);
    // The revoked code's credit is still owed behind its hold, and leaves
    // once the hold settles.
    expect(store.balance(old.revoked)).toBe(0);
    store.settle(old.revokedHold, { usage: { input: 1, cachedInput: 0, output: 1, reasoning: 0 }, amountMicros: 100_000, costMicros: 20_000 });
    expect(store.balance(old.revoked)).toBe(0);
    expect(store.ledger(old.revoked).at(-1)).toMatchObject({ kind: "adjust", amount: -4_900_000, source: "judge_revoked:j000000000002" });
    // Committed: 10 standing codes and the revoked one's spend.
    expect(store.judgeTotals().committedMicros).toBe(50 * USD + 100_000);
    // The old codes still sign in as before: the redeemed one to its
    // account, an unused one making its own, the email account's refused.
    expect(store.redeemJudgeCode(old.codes[0]!).id).toBe(old.judge);
    expect(store.redeemJudgeCode(old.codes[1]!).id).not.toBe(old.judge);
    expect(() => store.redeemJudgeCode(old.codes[3]!)).toThrow(JudgeCodeError);
    // And a pass works on the migrated file.
    const pool = store.createJudgePool({ label: "Judges", poolMicros: 10 * USD, shareMicros: 2 * USD, expiresAt: now() + 86_400_000, totalCapMicros: 100 * USD });
    expect(store.judgeSignIn(pool.code).pooled).toBe(true);
    store.close();
    // Opening again changes nothing.
    const again = new AccountsStore(file, { now });
    expect(again.listJudgeCodes()).toHaveLength(11);
    expect(again.listJudgePools()[0]).toMatchObject({ accounts: 1, grantedMicros: 2 * USD });
    again.close();
    const check = new DatabaseSync(file);
    expect((check.prepare("PRAGMA foreign_key_check").all() as unknown[]).length).toBe(0);
    expect((check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    check.close();
  });

  it("migrates once when several processes open the old file at the same moment", async () => {
    const file = path.join(tempDir("pool-migrate-race-"), "accounts.sqlite");
    oldDatabase(file);
    const script = `
      import { AccountsStore } from ${JSON.stringify(STORE_URL)};
      while (Date.now() < Number(process.env.POOL_START)) {}
      try {
        const store = new AccountsStore(process.env.POOL_FILE);
        console.log(JSON.stringify({ ok: true, codes: store.listJudgeCodes().length }));
        store.close();
      } catch (e) {
        console.log(JSON.stringify({ ok: false, error: e.name }));
      }`;
    const results = await inProcesses(8, script, { POOL_FILE: file, POOL_START: String(Date.now() + 1_500) });
    expect(results).toEqual(Array(8).fill({ ok: true, codes: 11 }));
    const db = new DatabaseSync(file);
    const cols = (db.prepare("PRAGMA table_info(judge_codes)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols.filter((c) => c === "pool_id" || c === "signin_key" || c === "signin_address")).toEqual(["pool_id", "signin_key", "signin_address"]);
    db.close();
  }, 30_000);
});

describe("per-judge codes beside a pass", () => {
  it("sign in, reopen and attach exactly as before", async () => {
    h = await startHosted();
    h.judgePool("Judges", 3, 1);
    const { code, id } = h.judgeCode("Judge Ada", 5);
    const b1 = h.browser();
    const first = await b1.call("POST", "/api/session/judge", { code });
    expect(first.body).toMatchObject({ signedIn: true, account: { kind: "judge", email: null }, balanceMicros: 5 * USD });
    expect(first.body.account.pool).toBeUndefined();
    const b2 = h.browser();
    await b2.call("POST", "/api/session/judge", { code });
    expect(idOf(b1)).toBe(idOf(b2));
    expect(h.app.store.ledger(idOf(b1))).toEqual([expect.objectContaining({ kind: "grant", amount: 5 * USD, source: `judge:${id}` })]);
    expect(h.app.store.listJudgeCodes()).toEqual([expect.objectContaining({ id, status: "redeemed", accountKind: "judge" })]);
    const g = h.browser();
    await h.signUp(g);
    expect((await g.call("POST", "/api/account/judge-code", { code: h.judgeCode("Bo", 2).code })).body.balanceMicros).toBe(2 * USD);
    expect(h.app.store.judgeTotals().committedMicros).toBe(10 * USD);
  });
});
