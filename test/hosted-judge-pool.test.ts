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
    const db = new DatabaseSync(path.join(h.dir, "hosted", "accounts.sqlite"));
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

describe("the pool cap under sign-ins from several processes at once", () => {
  it("never grants more than the pool", async () => {
    const dir = tempDir("pool-race-");
    const file = path.join(dir, "accounts.sqlite");
    const setup = new AccountsStore(file);
    // Five shares for twelve sign-ins, all inside the hourly limit.
    const { code, id } = setup.createJudgePool({ label: "Race", poolMicros: 5 * USD, shareMicros: USD, expiresAt: Date.now() + 86_400_000, totalCapMicros: 100 * USD });
    setup.close();
    const storeUrl = new URL("../src/hosted/store.ts", import.meta.url).href;
    const start = Date.now() + 1_500;
    const script = `
      import { AccountsStore } from ${JSON.stringify(storeUrl)};
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
    const run = () =>
      new Promise<{ ok: boolean; id?: string; code?: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          cwd: path.dirname(fileURLToPath(import.meta.url)),
          env: { ...process.env, POOL_FILE: file, POOL_CODE: code, POOL_START: String(start) },
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
    const results = await Promise.all(Array.from({ length: 12 }, run));
    const made = results.filter((r) => r.ok);
    expect(made).toHaveLength(5);
    expect(new Set(made.map((r) => r.id)).size).toBe(5);
    expect(results.filter((r) => !r.ok).map((r) => r.code)).toEqual(Array(7).fill("pool_empty"));
    const store = new AccountsStore(file);
    expect(store.listJudgePools()[0]).toMatchObject({ id, accounts: 5, grantedMicros: 5 * USD, leftMicros: 0 });
    for (const r of made) expect(store.balance(r.id!)).toBe(USD);
    store.close();
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

describe("a database made before shared passes", () => {
  it("keeps every code, account and ledger row, and then takes a pass", () => {
    const dir = tempDir("pool-migrate-");
    const file = path.join(dir, "accounts.sqlite");
    const at = Date.parse("2026-10-30T12:00:00Z");
    const now = () => Date.parse("2026-11-01T12:00:00Z");
    const codes = Array.from({ length: 11 }, (_, i) => `judge_${String(i).padStart(2, "0")}${"Q".repeat(41)}`);
    const old = new DatabaseSync(file);
    old.exec(OLD_SCHEMA);
    const accountId = `a${"1".repeat(32)}`;
    old.prepare("INSERT INTO accounts (id, kind, created_at) VALUES (?, 'judge', ?)").run(accountId, at);
    codes.forEach((code, i) => {
      old
        .prepare("INSERT INTO judge_codes (id, hash, label, cap, expires_at, created_at, account_id, redeemed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(`j${String(i).padStart(12, "0")}`, sha256(code), `Judge ${i}`, 5 * USD, at + 30 * 86_400_000, at, i === 0 ? accountId : null, i === 0 ? at : null);
    });
    old.prepare("INSERT INTO ledger (account_id, kind, amount, source, created_at) VALUES (?, 'grant', ?, ?, ?)").run(accountId, 5 * USD, "judge:j000000000000", at);
    old.prepare("INSERT INTO ledger (account_id, kind, amount, cost, created_at) VALUES (?, 'charge', ?, ?, ?)").run(accountId, 120_000, 40_000, at);
    old.close();

    const store = new AccountsStore(file, { now });
    const list = store.listJudgeCodes();
    expect(list).toHaveLength(11);
    expect(list[0]).toMatchObject({ id: "j000000000000", status: "redeemed", capMicros: 5 * USD, spentMicros: 120_000, accountKind: "judge" });
    expect(list.slice(1).every((c) => c.status === "unused")).toBe(true);
    expect(store.ledger(accountId).map((r) => [r.kind, r.amount])).toEqual([
      ["grant", 5 * USD],
      ["charge", 120_000],
    ]);
    expect(store.balance(accountId)).toBe(5 * USD - 120_000);
    expect(store.judgeTotals().committedMicros).toBe(55 * USD);
    // The old codes still sign in as before: the redeemed one to its
    // account, an unused one making its own.
    expect(store.redeemJudgeCode(codes[0]!).id).toBe(accountId);
    expect(store.redeemJudgeCode(codes[1]!).id).not.toBe(accountId);
    // And a pass works on the migrated file.
    const pool = store.createJudgePool({ label: "Judges", poolMicros: 10 * USD, shareMicros: 2 * USD, expiresAt: now() + 86_400_000, totalCapMicros: 100 * USD });
    expect(store.judgeSignIn(pool.code).pooled).toBe(true);
    expect(store.judgeTotals().committedMicros).toBe(65 * USD);
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
