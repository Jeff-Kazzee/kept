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
//
// APP_JUDGE_TOTAL_CAP_USD (default 100) caps every code together: a new
// code or a grant that would pass it is refused. APP_DB names the data
// folder as for the app.
import { parseArgs } from "node:util";
import { ConfigError, formatUsd, parseUsd, readHostedConfig } from "../src/hosted/config.ts";
import { AccountsStore, JUDGE_CODE_ID, JudgeCodeError, accountsPath } from "../src/hosted/store.ts";

const USAGE = `Usage:
  pnpm admin judges create --label <name> --cap-usd <n> --expires <YYYY-MM-DD>
  pnpm admin judges list
  pnpm admin judges revoke --id <id>
  pnpm admin judges grant --id <id> --usd <n>`;

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
    config = readHostedConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return fail(e.message);
    throw e;
  }
  const v = parsed.values;
  const store = new AccountsStore(accountsPath(env), { now });
  try {
    switch (command) {
      case "create": {
        const cap = v["cap-usd"] ? parseUsd(v["cap-usd"]) : null;
        const expiresAt = v.expires ? expiryOf(v.expires) : null;
        if (!v.label || cap === null || cap <= 0 || expiresAt === null) return fail(`create needs --label, --cap-usd above 0 and --expires as YYYY-MM-DD.\n${USAGE}`);
        const { id, code } = store.createJudgeCode({ label: v.label, capMicros: cap, expiresAt, totalCapMicros: config.judgeTotalCapMicros });
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
          out.push([c.id, JSON.stringify(c.label), `cap ${formatUsd(c.capMicros)}`, `spent ${formatUsd(c.spentMicros)}`, c.status, `through ${day(c.expiresAt)}`, c.accountKind === "google" ? "on a Google account" : ""].filter(Boolean).join("  "));
        }
        out.push(`Committed ${formatUsd(committedMicros)} of the ${formatUsd(config.judgeTotalCapMicros)} total cap.`);
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
        store.grantJudgeCode(v.id, amount, config.judgeTotalCapMicros);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runAdmin(process.argv.slice(2));
  for (const line of r.out) console.log(line);
  for (const line of r.err) console.error(line);
  process.exit(r.code);
}
