// The admin command for hosted mode (0014, design item 5). It runs on the
// server only: it opens the accounts database file directly, with the
// same checks the app uses, and needs no network.
//
//   pnpm admin judges create --label <name> --cap-usd <n> --expires <YYYY-MM-DD>
//       Prints the new code once. Only its hash is stored. The code works
//       through the end of the expiry day, UTC.
//   pnpm admin judges list
//       Label, cap, spent, status and expiry of every code. Never a code.
//   pnpm admin judges revoke --id <id>
//       The code stops working, its judge account is signed out, and its
//       unspent credit is removed.
//   pnpm admin judges grant --id <id> --usd <n>
//       Raises a code's cap. A redeemed code's account gets the credit.
//   pnpm admin users create --email <email> [--name <name>]
//       Makes an email account while public sign-up is off (0020, K7): a
//       Better Auth user with a random password, printed once. The person
//       signs in with it, and may add a passkey.
//   pnpm admin users list
//       Every email account: its email, when it was made, how many
//       passkeys it has. Never a password or a session.
//   pnpm admin users reset-password --email <email>
//       The site sends no email (0020), so a person who forgot their
//       password asks the coordinator. This sets a new random password,
//       prints it once, and ends every session of that account. Its
//       passkeys stay.
//   pnpm admin backup --to <folder>
//       Copies the accounts and sign-in databases with SQLite's VACUUM
//       INTO, safe while the app runs, into a new folder of mode 700, each
//       file mode 600.
//
// APP_JUDGE_TOTAL_CAP_USD caps every code together: a new code or a grant
// that would pass it is refused. It has no default (J19): while it is
// unset, create and grant refuse. APP_DB names the data
// folder as for the app.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { hashPassword } from "better-auth/crypto";
import { AuthFileError, authPath } from "../src/hosted/auth.ts";
import { checkPrivateFile } from "../src/hosted/db-file.ts";
import { ConfigError, formatUsd, parseUsd, readHostedConfig } from "../src/hosted/config.ts";
import { AccountsStore, JUDGE_CODE_ID, JudgeCodeError, accountsPath } from "../src/hosted/store.ts";

const USAGE = `Usage:
  pnpm admin judges create --label <name> --cap-usd <n> --expires <YYYY-MM-DD>
  pnpm admin judges list
  pnpm admin judges revoke --id <id>
  pnpm admin judges grant --id <id> --usd <n>
  pnpm admin users create --email <email> [--name <name>]
  pnpm admin users list
  pnpm admin users reset-password --email <email>
  pnpm admin backup --to <folder>`;

export type AdminResult = { code: number; out: string[]; err: string[] };

// The expiry date as the end of that day, UTC.
export function expiryOf(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== date) return null;
  return start + 86_400_000;
}

const day = (at: number) => new Date(at - 1).toISOString().slice(0, 10);

export function runAdmin(argv: string[], env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): AdminResult {
  const out: string[] = [];
  const err: string[] = [];
  const fail = (line: string, code = 2): AdminResult => ({ code, out, err: [...err, line] });
  const [group, command, ...rest] = argv;
  if (group !== "judges" || !command) return fail(USAGE);
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { label: { type: "string" }, "cap-usd": { type: "string" }, expires: { type: "string" }, id: { type: "string" }, usd: { type: "string" } }, strict: true });
  } catch (e) {
    return fail(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }
  let config;
  try {
    // The admin works on hosted mode's data, whatever APP_MODE says here.
    config = readHostedConfig({ ...env, APP_MODE: "hosted" });
  } catch (e) {
    if (e instanceof ConfigError) return fail(e.message);
    throw e;
  }
  const v = parsed.values;
  // J19: no total cap has a default, so nothing is granted without one.
  const totalCap = config.judgeTotalCapMicros;
  if ((command === "create" || command === "grant") && totalCap === null) {
    return fail(`APP_JUDGE_TOTAL_CAP_USD is not set, so no judge credit can be granted. Set it to the most all judge codes together may grant, in dollars.`);
  }
  const store = new AccountsStore(accountsPath(env), { now });
  try {
    switch (command) {
      case "create": {
        const cap = v["cap-usd"] ? parseUsd(v["cap-usd"]) : null;
        const expiresAt = v.expires ? expiryOf(v.expires) : null;
        if (!v.label || cap === null || cap <= 0 || expiresAt === null) return fail(`create needs --label, --cap-usd above 0 and --expires as YYYY-MM-DD.\n${USAGE}`);
        const { id, code } = store.createJudgeCode({ label: v.label, capMicros: cap, expiresAt, totalCapMicros: totalCap! });
        out.push(`Made judge code ${id} for "${v.label.trim()}", cap ${formatUsd(cap)}, works through ${day(expiresAt)} UTC.`);
        out.push("The code, shown this once. Give it to the judge. It is not stored and cannot be shown again:");
        out.push(code);
        return { code: 0, out, err };
      }
      case "list": {
        const codes = store.listJudgeCodes();
        const { committedMicros } = store.judgeTotals();
        if (codes.length === 0) out.push("No judge codes yet.");
        for (const c of codes) {
          out.push([c.id, JSON.stringify(c.label), `cap ${formatUsd(c.capMicros)}`, `spent ${formatUsd(c.spentMicros)}`, c.status, `through ${day(c.expiresAt)}`, c.accountKind === "user" ? "on an email account" : c.accountKind === "google" ? "on a Google account" : ""].filter(Boolean).join("  "));
        }
        out.push(totalCap === null ? `Committed ${formatUsd(committedMicros)}. APP_JUDGE_TOTAL_CAP_USD is not set.` : `Committed ${formatUsd(committedMicros)} of the ${formatUsd(totalCap)} total cap.`);
        return { code: 0, out, err };
      }
      case "revoke": {
        if (!v.id || !JUDGE_CODE_ID.test(v.id)) return fail(`revoke needs --id, as list shows it.\n${USAGE}`);
        store.revokeJudgeCode(v.id);
        out.push(`Revoked judge code ${v.id}.`);
        return { code: 0, out, err };
      }
      case "grant": {
        const amount = v.usd ? parseUsd(v.usd) : null;
        if (!v.id || !JUDGE_CODE_ID.test(v.id) || amount === null || amount <= 0) return fail(`grant needs --id and --usd above 0.\n${USAGE}`);
        store.grantJudgeCode(v.id, amount, totalCap!);
        out.push(`Granted ${formatUsd(amount)} more on judge code ${v.id}.`);
        return { code: 0, out, err };
      }
      default:
        return fail(USAGE);
    }
  } catch (e) {
    if (e instanceof JudgeCodeError) return fail(e.message, 1);
    if (e instanceof Error) return fail(e.message, 1);
    throw e;
  } finally {
    store.close();
  }
}

// The sign-in database, opened with the app's checks. Never made here.
function openAuth(env: NodeJS.ProcessEnv): DatabaseSync {
  const file = authPath(env);
  checkPrivateFile(file, "The sign-in database", false, (m) => new AuthFileError(m));
  const db = new DatabaseSync(file, { timeout: 5_000 });
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return db;
}

type Row = Record<string, unknown>;

// The users and backup commands, and every other command through
// runAdmin. Async, as Better Auth's password hash is.
export async function runAdminAsync(argv: string[], env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): Promise<AdminResult> {
  const [group, command, ...rest] = argv;
  if (group !== "users" && group !== "backup") return runAdmin(argv, env, now);
  const out: string[] = [];
  const fail = (line: string, code = 2): AdminResult => ({ code, out, err: [line] });
  let parsed;
  try {
    parsed = parseArgs({ args: group === "backup" ? (command ? [command, ...rest] : []) : rest, options: { email: { type: "string" }, to: { type: "string" }, name: { type: "string" } }, strict: true });
  } catch (e) {
    return fail(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }
  const v = parsed.values;
  try {
    if (group === "backup") {
      if (!v.to) return fail(`backup needs --to <folder>.\n${USAGE}`);
      const folder = path.resolve(v.to);
      if (existsSync(folder)) return fail(`${folder} already exists. Name a new folder, so no backup is written over.`);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      chmodSync(folder, 0o700);
      for (const [file, name] of [
        [accountsPath(env), "accounts.sqlite"],
        [authPath(env), "auth.sqlite"],
      ] as const) {
        if (!existsSync(file)) {
          out.push(`No ${name} yet at ${file}. Skipped.`);
          continue;
        }
        checkPrivateFile(file, `The ${name} database`, false, (m) => new Error(m));
        const target = path.join(folder, name);
        const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
        try {
          db.prepare("VACUUM INTO ?").run(target);
        } finally {
          db.close();
        }
        chmodSync(target, 0o600);
        out.push(`Backed up ${name} to ${target}.`);
      }
      return { code: 0, out, err: [] };
    }
    if (command === "list") {
      const db = openAuth(env);
      try {
        const rows = db.prepare(`SELECT u.email, u.createdAt, (SELECT COUNT(*) FROM passkey p WHERE p.userId = u.id) AS passkeys FROM user u ORDER BY u.createdAt`).all() as Row[];
        if (rows.length === 0) out.push("No email accounts yet.");
        for (const r of rows) out.push([String(r.email), `made ${String(r.createdAt).slice(0, 10)}`, `${Number(r.passkeys)} passkey(s)`].join("  "));
      } finally {
        db.close();
      }
      return { code: 0, out, err: [] };
    }
    if (command === "create") {
      const email = v.email?.trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail(`create needs --email with a full email address.\n${USAGE}`);
      const name = (v.name ?? "").trim().slice(0, 100);
      const password = randomBytes(15).toString("base64url");
      const hash = await hashPassword(password);
      // Better Auth's own id shape: 32 letters and digits.
      const id = () => {
        const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        return [...randomBytes(32)].map((b) => abc[b % abc.length]).join("");
      };
      const db = openAuth(env);
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (db.prepare("SELECT 1 FROM user WHERE lower(email) = ?").get(email)) throw new Error("An account with that email already exists. Nothing was made.");
          const at = new Date(now()).toISOString();
          const userId = id();
          db.prepare("INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, 0, NULL, ?, ?)").run(userId, name, email, at, at);
          db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?, ?)").run(id(), userId, userId, hash, at, at);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      } finally {
        db.close();
      }
      out.push(`Made an account for ${email}.`);
      out.push("Its password, shown this once. Give it to the person, who can sign in with it now:");
      out.push(password);
      return { code: 0, out, err: [] };
    }
    if (command === "reset-password") {
      const email = v.email?.trim().toLowerCase();
      if (!email) return fail(`reset-password needs --email.\n${USAGE}`);
      const password = randomBytes(15).toString("base64url");
      const hash = await hashPassword(password);
      const db = openAuth(env);
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const user = db.prepare("SELECT id FROM user WHERE lower(email) = ?").get(email) as Row | undefined;
          if (!user) throw new Error("No email account has that address. Nothing was changed.");
          const at = new Date(now()).toISOString();
          const changed = db.prepare("UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = 'credential'").run(hash, at, String(user.id)).changes;
          if (Number(changed) !== 1) throw new Error("That account has no password to reset. Nothing was changed.");
          db.prepare("DELETE FROM session WHERE userId = ?").run(String(user.id));
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      } finally {
        db.close();
      }
      out.push(`Set a new password for ${email} and signed that account out everywhere. Its passkeys still work.`);
      out.push("The new password, shown this once. Give it to the person, who can sign in with it now:");
      out.push(password);
      return { code: 0, out, err: [] };
    }
    return fail(USAGE);
  } catch (e) {
    if (e instanceof Error) return fail(e.message, 1);
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runAdminAsync(process.argv.slice(2));
  for (const line of r.out) console.log(line);
  for (const line of r.err) console.error(line);
  process.exit(r.code);
}
