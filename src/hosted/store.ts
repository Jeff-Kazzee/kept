// The hosted mode's central database (0014, design items 3 to 5):
// accounts, judge sessions, the usage credits ledger and the judge codes,
// in data/hosted/accounts.sqlite. Sign-up, passwords, passkeys and the
// sessions of those accounts are Better Auth's, in its own file beside
// this one (auth.ts, 0020). An account here points at its Better Auth user
// by that user's id, and nothing else of Better Auth's is kept here. Each account's case, settings and Google
// connection live apart, in its own workspace folder (workspaces.ts).
//
// The file follows the secrets store's patterns (0010): mode 600, owned by
// the user that runs the app, a symbolic link refused before and after the
// open, WAL with a busy timeout, and every change one BEGIN IMMEDIATE
// transaction, so a check and the write that depends on it are one step
// across processes too, such as the app and `pnpm admin`.
//
// Secrets are never stored: a session token and a judge code are kept as
// their SHA-256 hashes only. Nothing here logs, and no error message holds
// a value from the file.
//
// Money is in micro-dollars, as integers. The ledger's rows:
//   grant    credit from a judge code or a purchase, with its source
//   hold     reserved before a model call, open until the call settles
//   charge   the call's cost at the person's price, from its usage
//   release  the unused part of a hold, a record only
//   refund   credit given back by the admin
//   adjust   a signed correction by the admin, or a revoked code's rest
// The balance is grants, refunds and adjustments, minus charges, minus
// the holds still open. A hold is taken only when the balance covers it,
// and a charge never takes more than its own hold or the balance, so the
// balance never goes below zero.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TokenUsage } from "../model/request.ts";
import { appDbPath } from "../paths.ts";
import { checkPrivateFile } from "./db-file.ts";

export const ACCOUNTS_FILE_NAME = "accounts.sqlite";

// data/hosted/accounts.sqlite, beside the event log's folder.
export function accountsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(appDbPath(env)), "hosted", ACCOUNTS_FILE_NAME);
}

// The folder that holds every account's workspace.
export function workspacesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(appDbPath(env)), "accounts");
}

export const ACCOUNT_ID = /^a[0-9a-f]{32}$/;
export const JUDGE_CODE_ID = /^j[0-9a-f]{12}$/;
// A judge code: "judge_" and 43 base64url characters, 256 random bits.
// The secret scan knows this shape (scripts/scan-secrets.ts).
export const JUDGE_CODE = /^judge_[A-Za-z0-9_-]{43}$/;
export const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
// A hold whose call never settled, because the process stopped, is
// charged in full after this long. The model call times out after 60 s.
export const STALE_HOLD_MS = 10 * 60_000;

// "user": an account with an email and a password, and maybe passkeys,
// from Better Auth (0020). "judge": a judge code that is its own sign-in.
// "google": an account from Sign in with Google, before 0020. It cannot
// sign in any more, and is kept for the ledger.
export type AccountKind = "user" | "judge" | "google";
export type Account = { id: string; kind: AccountKind; email: string | null; name: string | null; createdAt: number; deleted: boolean };

export type LedgerKind = "grant" | "hold" | "charge" | "release" | "refund" | "adjust";

// What a charge was for, so the usage page can show it.
export type CallContext = { accountId: string; workspace: string; route: string; turn: string | null; model: string };

export type ChargeRow = {
  id: number;
  at: number;
  route: string;
  turn: string | null;
  model: string;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  amountMicros: number;
  // True when the charge is the whole hold, because the call reported no
  // usage.
  wholeHold: boolean;
};

export type JudgeCodeStatus = "unused" | "redeemed" | "revoked" | "expired";
export type JudgeCodeRow = {
  id: string;
  label: string;
  capMicros: number;
  spentMicros: number;
  status: JudgeCodeStatus;
  expiresAt: number;
  createdAt: number;
  // "judge" for a code that is its own sign-in, "user" (or "google",
  // before 0020) when attached to an account, null while unused.
  accountKind: AccountKind | null;
};

export class AccountsFileError extends Error {
  override name = "AccountsFileError";
}

export class AccountsBusyError extends Error {
  override name = "AccountsBusyError";
  constructor() {
    super("The accounts database stayed busy in another process.");
  }
}

// A judge code action the rules refuse. `code` is fixed, for the page and
// the admin command.
export class JudgeCodeError extends Error {
  override name = "JudgeCodeError";
  readonly code: "not_found" | "revoked" | "expired" | "used" | "total_cap" | "attached" | "account_deleted" | "judge_account" | "has_code";
  constructor(code: JudgeCodeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export const BUSY_TIMEOUT_MS = 5_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('google', 'judge', 'user')),
  google_sub TEXT UNIQUE,
  auth_user TEXT UNIQUE,
  email TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  kind TEXT NOT NULL CHECK (kind IN ('grant', 'hold', 'charge', 'release', 'refund', 'adjust')),
  amount INTEGER NOT NULL,
  cost INTEGER NOT NULL DEFAULT 0,
  hold_id INTEGER,
  open INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  workspace TEXT,
  route TEXT,
  turn TEXT,
  model TEXT,
  input INTEGER NOT NULL DEFAULT 0,
  cached_input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  uncollected INTEGER NOT NULL DEFAULT 0,
  whole_hold INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK (kind = 'adjust' OR amount >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS ledger_account ON ledger (account_id, kind);
CREATE INDEX IF NOT EXISTS ledger_open ON ledger (open) WHERE open = 1;
CREATE INDEX IF NOT EXISTS ledger_day ON ledger (kind, created_at);
CREATE TABLE IF NOT EXISTS judge_codes (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  cap INTEGER NOT NULL CHECK (cap > 0),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  account_id TEXT UNIQUE REFERENCES accounts (id),
  redeemed_at INTEGER,
  revoke_due INTEGER NOT NULL DEFAULT 0,
  revoke_hold_max INTEGER NOT NULL DEFAULT 0
) STRICT;`;

// A Better Auth user id: its own ids are 32 letters and digits.
export const AUTH_USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

// A database made before 0020 allows only 'google' and 'judge' accounts,
// and has no auth_user column. SQLite cannot change a CHECK, so the
// accounts table is made again, in one transaction, with every row kept
// (SQLite's own steps for a table change, with foreign keys off).
function migrateAccounts(db: DatabaseSync): void {
  const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get() as Row | undefined)?.sql ?? "");
  if (sql.includes("'user'")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE accounts_0020 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('google', 'judge', 'user')),
  google_sub TEXT UNIQUE,
  auth_user TEXT UNIQUE,
  email TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
INSERT INTO accounts_0020 (id, kind, google_sub, email, name, created_at, deleted_at) SELECT id, kind, google_sub, email, name, created_at, deleted_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_0020 RENAME TO accounts;`);
      if ((db.prepare("PRAGMA foreign_key_check").all() as Row[]).length > 0) throw new Error("foreign keys");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const isBusy = (err: unknown) => {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === 5;
};

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randomId = (prefix: string, bytes: number) => `${prefix}${randomBytes(bytes).toString("hex")}`;
export const newJudgeCode = () => `judge_${randomBytes(32).toString("base64url")}`;

// The start of the UTC day that holds `at`.
export const dayStart = (at: number) => Math.floor(at / 86_400_000) * 86_400_000;

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);

export type HoldResult = { ok: true; holdId: number } | { ok: false; reason: "credits" | "daily_cap" };

export class AccountsStore {
  readonly file: string;
  readonly #now: () => number;
  #db: DatabaseSync | null = null;

  constructor(file: string, options: { now?: () => number } = {}) {
    this.file = file;
    this.#now = options.now ?? Date.now;
  }

  now(): number {
    return this.#now();
  }

  #open(): DatabaseSync {
    if (this.#db) return this.#db;
    this.#checkPath(true);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.file, { timeout: BUSY_TIMEOUT_MS });
    } catch (err) {
      throw new AccountsFileError(`The accounts database could not be opened (${(err as { code?: string }).code ?? "unknown"}): ${this.file}`);
    }
    try {
      this.#checkPath(false);
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
      db.exec(SCHEMA);
      migrateAccounts(db);
      // A database made before review round 1 gains the revoke column.
      const cols = (db.prepare("PRAGMA table_info(judge_codes)").all() as Row[]).map((c) => String(c.name));
      if (!cols.includes("revoke_due")) db.exec("ALTER TABLE judge_codes ADD COLUMN revoke_due INTEGER NOT NULL DEFAULT 0");
      if (!cols.includes("revoke_hold_max")) db.exec("ALTER TABLE judge_codes ADD COLUMN revoke_hold_max INTEGER NOT NULL DEFAULT 0");
    } catch (err) {
      db.close();
      if (err instanceof AccountsFileError) throw err;
      if (isBusy(err)) throw new AccountsBusyError();
      throw new AccountsFileError(`The accounts database is not one this app made: ${this.file}`);
    }
    this.#db = db;
    return db;
  }

  #checkPath(create: boolean): void {
    checkPrivateFile(this.file, "The accounts database", create, (m) => new AccountsFileError(m));
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  #read<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.#open();
    try {
      return fn(db);
    } catch (err) {
      if (isBusy(err)) throw new AccountsBusyError();
      throw err;
    }
  }

  #tx<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.#open();
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      if (isBusy(err)) throw new AccountsBusyError();
      throw err;
    }
    try {
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      if (isBusy(err)) throw new AccountsBusyError();
      throw err;
    }
  }

  // ---- Accounts ----

  #account(db: DatabaseSync, id: string): Account | null {
    const r = db.prepare("SELECT id, kind, email, name, created_at, deleted_at FROM accounts WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    return { id: String(r.id), kind: r.kind as AccountKind, email: (r.email as string | null) ?? null, name: (r.name as string | null) ?? null, createdAt: num(r.created_at), deleted: r.deleted_at !== null };
  }

  account(id: string): Account | null {
    if (!ACCOUNT_ID.test(id)) return null;
    return this.#read((db) => this.#account(db, id));
  }

  // The account of a Google sign-in, made on the first one. Email and name
  // follow what Google last said.
  googleAccount(identity: { sub: string; email: string; name: string | null }): Account {
    return this.#tx((db) => {
      const found = db.prepare("SELECT id FROM accounts WHERE google_sub = ? AND deleted_at IS NULL").get(identity.sub) as Row | undefined;
      if (found) {
        db.prepare("UPDATE accounts SET email = ?, name = ? WHERE id = ?").run(identity.email, identity.name, String(found.id));
        return this.#account(db, String(found.id))!;
      }
      const id = randomId("a", 16);
      db.prepare("INSERT INTO accounts (id, kind, google_sub, email, name, created_at) VALUES (?, 'google', ?, ?, ?, ?)").run(id, identity.sub, identity.email, identity.name, this.#now());
      return this.#account(db, id)!;
    });
  }

  // The account of a Better Auth user, made the first time the user is
  // seen (0020, B5). Email and name follow Better Auth's. A read only,
  // unless the account is new or they changed.
  userAccount(identity: { userId: string; email: string; name: string | null }): Account {
    if (!AUTH_USER_ID.test(identity.userId)) throw new Error("no such user");
    const name = identity.name && identity.name.trim() !== "" ? identity.name.trim().slice(0, 200) : null;
    const email = identity.email.slice(0, 320);
    const found = this.#read((db) => db.prepare("SELECT id, email, name FROM accounts WHERE auth_user = ? AND deleted_at IS NULL").get(identity.userId) as Row | undefined);
    if (found && found.email === email && (found.name ?? null) === name) return this.account(String(found.id))!;
    return this.#tx((db) => {
      const again = db.prepare("SELECT id FROM accounts WHERE auth_user = ? AND deleted_at IS NULL").get(identity.userId) as Row | undefined;
      if (again) {
        db.prepare("UPDATE accounts SET email = ?, name = ? WHERE id = ?").run(email, name, String(again.id));
        return this.#account(db, String(again.id))!;
      }
      const id = randomId("a", 16);
      db.prepare("INSERT INTO accounts (id, kind, auth_user, email, name, created_at) VALUES (?, 'user', ?, ?, ?, ?)").run(id, identity.userId, email, name, this.#now());
      return this.#account(db, id)!;
    });
  }

  // The account of a Better Auth user, or null, never made.
  accountOfUser(userId: string): Account | null {
    if (!AUTH_USER_ID.test(userId)) return null;
    return this.#read((db) => {
      const r = db.prepare("SELECT id FROM accounts WHERE auth_user = ? AND deleted_at IS NULL").get(userId) as Row | undefined;
      return r ? this.#account(db, String(r.id)) : null;
    });
  }

  // Delete account: the sessions go, and the account keeps only what the
  // ledger needs. Its email, name, Google subject and Better Auth user are
  // removed. Ledger rows stay, for accounting.
  deleteAccount(id: string): void {
    this.#tx((db) => {
      db.prepare("DELETE FROM sessions WHERE account_id = ?").run(id);
      db.prepare("UPDATE accounts SET email = NULL, name = NULL, google_sub = NULL, auth_user = NULL, deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(this.#now(), id);
    });
  }

  // ---- Sessions ----

  // A new session. Returns the token once. Only its hash is kept.
  createSession(accountId: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const now = this.#now();
    const expiresAt = now + SESSION_TTL_MS;
    this.#tx((db) => {
      const a = this.#account(db, accountId);
      if (!a || a.deleted) throw new Error("no such account");
      db.prepare("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), accountId, now, expiresAt);
    });
    return { token, expiresAt };
  }

  // The account a session token belongs to, or null when the token is
  // unknown, expired or ended, the account was deleted, or the account is
  // a judge account whose code was revoked or expired.
  session(token: string | null): { account: Account; expiresAt: number } | null {
    if (!token || !SESSION_TOKEN.test(token)) return null;
    const hash = sha256(token);
    return this.#read((db) => {
      const r = db.prepare("SELECT hash, account_id, expires_at FROM sessions WHERE hash = ?").get(hash) as Row | undefined;
      if (!r || !timingSafeEqual(Buffer.from(String(r.hash)), Buffer.from(hash))) return null;
      const now = this.#now();
      let expiresAt = num(r.expires_at);
      if (expiresAt <= now) return null;
      const account = this.#account(db, String(r.account_id));
      if (!account || account.deleted) return null;
      if (account.kind === "judge") {
        const code = db.prepare("SELECT expires_at, revoked_at FROM judge_codes WHERE account_id = ?").get(account.id) as Row | undefined;
        if (!code || code.revoked_at !== null || num(code.expires_at) <= now) return null;
        expiresAt = Math.min(expiresAt, num(code.expires_at));
      }
      return { account, expiresAt };
    });
  }

  endSession(token: string | null): void {
    if (!token || !SESSION_TOKEN.test(token)) return;
    this.#tx((db) => db.prepare("DELETE FROM sessions WHERE hash = ?").run(sha256(token)));
  }

  // Removes expired sessions. Called now and then.
  sweepSessions(): number {
    return this.#tx((db) => Number(db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(this.#now()).changes));
  }

  // ---- Ledger ----

  #balance(db: DatabaseSync, accountId: string): number {
    const r = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN kind IN ('grant', 'refund', 'adjust') THEN amount END), 0) AS credit,
           COALESCE(SUM(CASE WHEN kind = 'charge' THEN amount END), 0) AS spent,
           COALESCE(SUM(CASE WHEN kind = 'hold' AND open = 1 THEN amount END), 0) AS held
         FROM ledger WHERE account_id = ?`,
      )
      .get(accountId) as Row;
    return num(r.credit) - num(r.spent) - num(r.held);
  }

  // The balance a person may spend: what a revoked code still owes the
  // account is not part of it.
  balance(accountId: string): number {
    return this.#read((db) => {
      const due = this.#due(db, accountId);
      return due === 0 ? this.#balance(db, accountId) : Math.max(0, this.#balance(db, accountId) - due);
    });
  }

  // The model cost of the UTC day so far: every charge's cost and every
  // open hold's upper bound, across all accounts.
  #dayCost(db: DatabaseSync, now: number): number {
    const r = db
      .prepare(
        `SELECT COALESCE(SUM(cost), 0) AS cost FROM ledger
         WHERE (kind = 'charge' AND created_at >= ?) OR (kind = 'hold' AND open = 1)`,
      )
      .get(dayStart(now)) as Row;
    return num(r.cost);
  }

  dayCost(): number {
    return this.#read((db) => this.#dayCost(db, this.#now()));
  }

  #insert(db: DatabaseSync, row: Partial<Record<string, string | number | null>> & { account_id: string; kind: LedgerKind; amount: number }): number {
    const cols = Object.keys(row);
    const values = Object.values(row) as Array<string | number | null>;
    const r = db.prepare(`INSERT INTO ledger (${cols.join(", ")}, created_at) VALUES (${cols.map(() => "?").join(", ")}, ?)`).run(...values, this.#now());
    return Number(r.lastInsertRowid);
  }

  grant(accountId: string, amountMicros: number, source: string): void {
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new Error("A grant is a whole number of micro-dollars above zero.");
    this.#tx((db) => {
      if (!this.#account(db, accountId)) throw new Error("no such account");
      this.#insert(db, { account_id: accountId, kind: "grant", amount: amountMicros, source });
    });
  }

  // Admin only. A refund adds credit back. An adjustment is signed, and a
  // negative one takes no more than the balance.
  refund(accountId: string, amountMicros: number, source: string): void {
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new Error("A refund is a whole number of micro-dollars above zero.");
    this.#tx((db) => {
      if (!this.#account(db, accountId)) throw new Error("no such account");
      this.#insert(db, { account_id: accountId, kind: "refund", amount: amountMicros, source });
    });
  }

  adjust(accountId: string, amountMicros: number, source: string): number {
    if (!Number.isSafeInteger(amountMicros) || amountMicros === 0) throw new Error("An adjustment is a whole number of micro-dollars, not zero.");
    return this.#tx((db) => {
      if (!this.#account(db, accountId)) throw new Error("no such account");
      const amount = amountMicros < 0 ? -Math.min(-amountMicros, Math.max(0, this.#balance(db, accountId))) : amountMicros;
      if (amount !== 0) this.#insert(db, { account_id: accountId, kind: "adjust", amount, source });
      return amount;
    });
  }

  // Reserves `amountMicros` before a model call. Refused, with nothing
  // written, when the balance cannot cover it or the day's model cost
  // would pass `dailyCapMicros`.
  hold(ctx: CallContext, amountMicros: number, costMicros: number, dailyCapMicros: number): HoldResult {
    if (!Number.isSafeInteger(amountMicros) || amountMicros < 0 || !Number.isSafeInteger(costMicros) || costMicros < 0) throw new Error("A hold is a whole number of micro-dollars.");
    return this.#tx((db): HoldResult => {
      const account = this.#account(db, ctx.accountId);
      if (!account || account.deleted) return { ok: false, reason: "credits" };
      if (this.#dayCost(db, this.#now()) + costMicros > dailyCapMicros) return { ok: false, reason: "daily_cap" };
      // A revoked code's credit still inside open holds is not there to
      // spend (review round 1, finding 2).
      if (this.#balance(db, ctx.accountId) - this.#due(db, ctx.accountId) < amountMicros) return { ok: false, reason: "credits" };
      const holdId = this.#insert(db, {
        account_id: ctx.accountId,
        kind: "hold",
        amount: amountMicros,
        cost: costMicros,
        open: 1,
        workspace: ctx.workspace,
        route: ctx.route,
        turn: ctx.turn,
        model: ctx.model,
      });
      return { ok: true, holdId };
    });
  }

  // Closes a hold with a charge. `charge` is the call's price from its
  // usage, or null to charge the whole hold. A charge above the balance
  // and the hold is cut to what is there, and the rest is kept as
  // uncollected, so Jeff's real cost stays on record. The unused part of
  // the hold is written as a release. A hold that is already closed is
  // left as it is.
  settle(holdId: number, charge: { usage: TokenUsage; amountMicros: number; costMicros: number } | null): { charged: number } {
    return this.#tx((db) => {
      const h = db.prepare("SELECT * FROM ledger WHERE id = ? AND kind = 'hold'").get(holdId) as Row | undefined;
      if (!h || num(h.open) !== 1) return { charged: 0 };
      const holdAmount = num(h.amount);
      const accountId = String(h.account_id);
      db.prepare("UPDATE ledger SET open = 0 WHERE id = ?").run(holdId);
      const available = Math.max(0, this.#balance(db, accountId));
      const wanted = charge ? charge.amountMicros : holdAmount;
      // Never more than the hold (review round 1, finding 1), nor than
      // the balance.
      const charged = Math.min(wanted, holdAmount, available);
      const usage = charge?.usage ?? { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
      const ctx = { workspace: h.workspace as string, route: h.route as string, turn: (h.turn as string | null) ?? null, model: h.model as string };
      this.#insert(db, {
        account_id: accountId,
        kind: "charge",
        amount: charged,
        cost: charge ? Math.min(charge.costMicros, num(h.cost)) : num(h.cost),
        hold_id: holdId,
        ...ctx,
        input: usage.input,
        cached_input: usage.cachedInput,
        output: usage.output,
        reasoning: usage.reasoning,
        uncollected: wanted - charged,
        whole_hold: charge ? 0 : 1,
      });
      if (holdAmount > charged) this.#insert(db, { account_id: accountId, kind: "release", amount: holdAmount - charged, hold_id: holdId, ...ctx });
      this.#collectDue(db, accountId, holdId, charged);
      return { charged };
    });
  }

  // Closes a hold with no charge, for a call that was never sent or that
  // the API refused before it ran.
  release(holdId: number): void {
    this.#tx((db) => {
      const h = db.prepare("SELECT * FROM ledger WHERE id = ? AND kind = 'hold'").get(holdId) as Row | undefined;
      if (!h || num(h.open) !== 1) return;
      db.prepare("UPDATE ledger SET open = 0 WHERE id = ?").run(holdId);
      this.#insert(db, {
        account_id: String(h.account_id),
        kind: "release",
        amount: num(h.amount),
        hold_id: holdId,
        workspace: h.workspace as string,
        route: h.route as string,
        turn: (h.turn as string | null) ?? null,
        model: h.model as string,
      });
      this.#collectDue(db, String(h.account_id), holdId, 0);
    });
  }

  // What revoked codes still owe the account: their unspent credit that
  // sat inside open holds when they were revoked.
  #due(db: DatabaseSync, accountId: string): number {
    const r = db.prepare("SELECT COALESCE(SUM(revoke_due), 0) AS due FROM judge_codes WHERE account_id = ? AND revoked_at IS NOT NULL").get(accountId) as Row;
    return num(r.due);
  }

  // After a hold closes (final review, finding 1). A hold that was open
  // when a code was revoked may have spent the code's credit: what it
  // charged counts against the code first, so it lowers what the code
  // owes. Once the last of those holds has closed, what is still owed
  // leaves the balance. It came back from those holds, and no hold since
  // could draw on it, so no other credit is taken.
  #collectDue(db: DatabaseSync, accountId: string, holdId: number, charged: number): void {
    // Most accounts owe nothing: one indexed read and done.
    const owed = db.prepare("SELECT id, revoke_due, revoke_hold_max FROM judge_codes WHERE account_id = ? AND revoked_at IS NOT NULL AND revoke_due > 0").all(accountId) as Row[];
    for (const c of owed) {
      const codeId = String(c.id);
      const holdMax = num(c.revoke_hold_max);
      let due = num(c.revoke_due);
      if (holdId <= holdMax) due = Math.max(0, due - charged);
      const waiting = db.prepare("SELECT 1 FROM ledger WHERE account_id = ? AND kind = 'hold' AND open = 1 AND id <= ?").get(accountId, holdMax);
      if (!waiting) {
        const take = Math.min(due, Math.max(0, this.#balance(db, accountId)));
        if (take > 0) this.#insert(db, { account_id: accountId, kind: "adjust", amount: -take, source: `judge_revoked:${codeId}` });
        due = 0;
      }
      db.prepare("UPDATE judge_codes SET revoke_due = ? WHERE id = ?").run(due, codeId);
    }
  }

  // Holds left open by a process that stopped mid-call are charged in
  // full: the call may have used tokens.
  settleStaleHolds(maxAgeMs = STALE_HOLD_MS): number {
    const ids = this.#read((db) =>
      (db.prepare("SELECT id FROM ledger WHERE kind = 'hold' AND open = 1 AND created_at <= ?").all(this.#now() - maxAgeMs) as Row[]).map((r) => num(r.id)),
    );
    for (const id of ids) this.settle(id, null);
    return ids.length;
  }

  // The account's recent charges, newest first.
  charges(accountId: string, limit = 50): ChargeRow[] {
    return this.#read((db) =>
      (
        db
          .prepare("SELECT id, created_at, route, turn, model, input, cached_input, output, reasoning, amount, whole_hold FROM ledger WHERE account_id = ? AND kind = 'charge' ORDER BY id DESC LIMIT ?")
          .all(accountId, limit) as Row[]
      ).map((r) => ({
        id: num(r.id),
        at: num(r.created_at),
        route: String(r.route ?? ""),
        turn: (r.turn as string | null) ?? null,
        model: String(r.model ?? ""),
        input: num(r.input),
        cachedInput: num(r.cached_input),
        output: num(r.output),
        reasoning: num(r.reasoning),
        amountMicros: num(r.amount),
        wholeHold: num(r.whole_hold) === 1,
      })),
    );
  }

  // Every ledger row of an account, oldest first, for tests and the admin.
  ledger(accountId: string): Array<{ id: number; kind: LedgerKind; amount: number; cost: number; open: boolean; holdId: number | null; source: string | null }> {
    return this.#read((db) =>
      (db.prepare("SELECT id, kind, amount, cost, open, hold_id, source FROM ledger WHERE account_id = ? ORDER BY id").all(accountId) as Row[]).map((r) => ({
        id: num(r.id),
        kind: r.kind as LedgerKind,
        amount: num(r.amount),
        cost: num(r.cost),
        open: num(r.open) === 1,
        holdId: r.hold_id === null ? null : num(r.hold_id),
        source: (r.source as string | null) ?? null,
      })),
    );
  }

  // ---- Judge codes ----

  // What a code may still cost: its cap while it stands, what it spent
  // once revoked.
  #judgeCommitted(db: DatabaseSync): number {
    let total = 0;
    for (const c of db.prepare("SELECT id, cap, revoked_at, account_id FROM judge_codes").all() as Row[]) {
      total += c.revoked_at === null ? num(c.cap) : this.#spent(db, c);
    }
    return total;
  }

  // What a code's account spent, up to the code's cap.
  #spent(db: DatabaseSync, c: Row): number {
    if (c.account_id === null) return 0;
    const r = db.prepare("SELECT COALESCE(SUM(amount), 0) AS spent FROM ledger WHERE account_id = ? AND kind = 'charge'").get(String(c.account_id)) as Row;
    return Math.min(num(c.cap), num(r.spent));
  }

  // A new code. Returns the code once. Only its hash is kept. Refused when
  // the caps of every standing code, and what revoked codes spent, would
  // pass `totalCapMicros`.
  createJudgeCode(input: { label: string; capMicros: number; expiresAt: number; totalCapMicros: number }): { id: string; code: string } {
    if (!Number.isSafeInteger(input.capMicros) || input.capMicros <= 0) throw new Error("The cap is an amount above zero.");
    const label = input.label.trim();
    if (label === "" || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error("The label is 1 to 80 characters, with no control characters.");
    if (input.expiresAt <= this.#now()) throw new Error("The expiry date is in the past.");
    const code = newJudgeCode();
    const id = randomId("j", 6);
    this.#tx((db) => {
      if (this.#judgeCommitted(db) + input.capMicros > input.totalCapMicros) throw new JudgeCodeError("total_cap", "That cap would pass the total cap for judge codes. Nothing was made.");
      db.prepare("INSERT INTO judge_codes (id, hash, label, cap, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, sha256(code), label, input.capMicros, input.expiresAt, this.#now());
    });
    return { id, code };
  }

  #status(c: Row, now: number): JudgeCodeStatus {
    if (c.revoked_at !== null) return "revoked";
    if (num(c.expires_at) <= now) return "expired";
    return c.account_id === null ? "unused" : "redeemed";
  }

  // Every code, never the code itself.
  listJudgeCodes(): JudgeCodeRow[] {
    return this.#read((db) => {
      const now = this.#now();
      return (db.prepare("SELECT * FROM judge_codes ORDER BY created_at, id").all() as Row[]).map((c) => {
        const account = c.account_id === null ? null : this.#account(db, String(c.account_id));
        return {
          id: String(c.id),
          label: String(c.label),
          capMicros: num(c.cap),
          spentMicros: this.#spent(db, c),
          status: this.#status(c, now),
          expiresAt: num(c.expires_at),
          createdAt: num(c.created_at),
          accountKind: account?.kind ?? null,
        };
      });
    });
  }

  judgeTotals(): { committedMicros: number } {
    return this.#read((db) => ({ committedMicros: this.#judgeCommitted(db) }));
  }

  // Revoked: the code no longer signs in or redeems, its judge account's
  // sessions end, and its unspent part leaves the account's balance.
  revokeJudgeCode(id: string): void {
    this.#tx((db) => {
      const c = db.prepare("SELECT * FROM judge_codes WHERE id = ?").get(id) as Row | undefined;
      if (!c) throw new JudgeCodeError("not_found", "No judge code has that id.");
      if (c.revoked_at !== null) return;
      db.prepare("UPDATE judge_codes SET revoked_at = ? WHERE id = ?").run(this.#now(), id);
      if (c.account_id === null) return;
      const accountId = String(c.account_id);
      const account = this.#account(db, accountId);
      if (account?.kind === "judge") db.prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId);
      // The unspent part leaves the balance. With no hold open it goes at
      // once. With holds open, those holds may still spend it, so all of
      // it is owed: no new hold may draw on it, what the open holds charge
      // counts against it first, and the rest goes once they close (review
      // round 1, finding 2, and the final review, finding 1).
      const unspent = num(c.cap) - this.#spent(db, c);
      const lastHold = db.prepare("SELECT MAX(id) AS id FROM ledger WHERE account_id = ? AND kind = 'hold' AND open = 1").get(accountId) as Row;
      if (lastHold.id === null) {
        const take = Math.min(unspent, Math.max(0, this.#balance(db, accountId)));
        if (take > 0) this.#insert(db, { account_id: accountId, kind: "adjust", amount: -take, source: `judge_revoked:${id}` });
      } else if (unspent > 0) {
        db.prepare("UPDATE judge_codes SET revoke_due = ?, revoke_hold_max = ? WHERE id = ?").run(unspent, num(lastHold.id), id);
      }
    });
  }

  // More credit on a code, within the total cap. A redeemed code's account
  // gets it at once.
  grantJudgeCode(id: string, amountMicros: number, totalCapMicros: number): void {
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new Error("The amount is above zero.");
    this.#tx((db) => {
      const c = db.prepare("SELECT * FROM judge_codes WHERE id = ?").get(id) as Row | undefined;
      if (!c) throw new JudgeCodeError("not_found", "No judge code has that id.");
      if (c.revoked_at !== null) throw new JudgeCodeError("revoked", "That code was revoked. Nothing was granted.");
      if (this.#judgeCommitted(db) + amountMicros > totalCapMicros) throw new JudgeCodeError("total_cap", "That grant would pass the total cap for judge codes. Nothing was granted.");
      db.prepare("UPDATE judge_codes SET cap = cap + ? WHERE id = ?").run(amountMicros, id);
      if (c.account_id !== null) this.#insert(db, { account_id: String(c.account_id), kind: "grant", amount: amountMicros, source: `judge:${id}` });
    });
  }

  // Redeems a code. With `attachTo`, the code's cap goes to that account,
  // once. Without it, the code is its own sign-in: the first use
  // makes a judge account and grants the cap, and a later use opens the
  // same account again. Returns the account. Each code grants its cap
  // once.
  redeemJudgeCode(code: string, attachTo: string | null = null): Account {
    const hash = sha256(code);
    return this.#tx((db) => {
      const c = JUDGE_CODE.test(code) ? (db.prepare("SELECT * FROM judge_codes WHERE hash = ?").get(hash) as Row | undefined) : undefined;
      if (!c || !timingSafeEqual(Buffer.from(String(c.hash)), Buffer.from(hash))) throw new JudgeCodeError("not_found", "That judge code is not one this site issued. Check it and try again.");
      const now = this.#now();
      if (c.revoked_at !== null) throw new JudgeCodeError("revoked", "That judge code was turned off. Ask the person who gave it to you for a new one.");
      if (num(c.expires_at) <= now) throw new JudgeCodeError("expired", "That judge code has expired. Ask the person who gave it to you for a new one.");
      const id = String(c.id);
      if (c.account_id !== null) {
        const owner = this.#account(db, String(c.account_id));
        if (attachTo !== null) {
          if (owner?.id === attachTo) return owner;
          throw new JudgeCodeError("used", "That judge code was already used. Each code works once.");
        }
        if (!owner || owner.deleted) throw new JudgeCodeError("account_deleted", "The account made with that judge code was deleted. Ask for a new code.");
        if (owner.kind !== "judge") throw new JudgeCodeError("attached", "That judge code was added to an account with an email address. Sign in with that email instead.");
        return owner;
      }
      let accountId: string;
      if (attachTo !== null) {
        const target = this.#account(db, attachTo);
        if (!target || target.deleted) throw new Error("no such account");
        if (target.kind === "judge") throw new JudgeCodeError("judge_account", "This account was made with a judge code, so it cannot take another one.");
        if (db.prepare("SELECT 1 FROM judge_codes WHERE account_id = ?").get(attachTo)) throw new JudgeCodeError("has_code", "This account already has a judge code. Each account takes one.");
        accountId = attachTo;
      } else {
        accountId = randomId("a", 16);
        db.prepare("INSERT INTO accounts (id, kind, created_at) VALUES (?, 'judge', ?)").run(accountId, now);
      }
      db.prepare("UPDATE judge_codes SET account_id = ?, redeemed_at = ? WHERE id = ?").run(accountId, now, id);
      this.#insert(db, { account_id: accountId, kind: "grant", amount: num(c.cap), source: `judge:${id}` });
      return this.#account(db, accountId)!;
    });
  }
}
