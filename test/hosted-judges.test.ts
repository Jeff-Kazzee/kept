// Judge access codes, design item 5 (0014): the admin command, redeeming a
// code once, the code as its own sign-in, attaching one to a Google
// account, the total cap, revoke, expiry, the rate limit, and no code in
// any log, list or file.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expiryOf, runAdmin } from "../scripts/admin.ts";
import { AccountsStore, JUDGE_CODE, JudgeCodeError, accountsPath } from "../src/hosted/store.ts";
import { startHosted, type Hosted } from "./hosted-helpers.ts";

let h: Hosted | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function adminEnv(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "admin-"));
  dirs.push(dir);
  // J19: the total cap has no default.
  return { APP_DB: path.join(dir, "app.sqlite"), APP_JUDGE_TOTAL_CAP_USD: "100", ...extra };
}

describe("the admin command", () => {
  it("create prints the code once and stores only its hash, and list never shows it", () => {
    const env = adminEnv();
    const now = () => Date.parse("2026-11-01T12:00:00Z");
    const made = runAdmin(["judges", "create", "--label", "Judge Ada", "--cap-usd", "5", "--expires", "2026-11-30"], env, now);
    expect(made.code).toBe(0);
    const code = made.out.find((l) => JUDGE_CODE.test(l))!;
    expect(code).toBeTruthy();
    expect(made.out[0]).toMatch(/^Made judge code j[0-9a-f]{12} for "Judge Ada", cap \$5\.00, works through 2026-11-30 UTC\.$/);
    const list = runAdmin(["judges", "list"], env, now);
    expect(list.code).toBe(0);
    expect(list.out.join("\n")).not.toContain(code);
    expect(list.out[0]).toMatch(/^j[0-9a-f]{12} {2}"Judge Ada" {2}cap \$5\.00 {2}spent \$0\.00 {2}unused {2}through 2026-11-30$/);
    expect(list.out.at(-1)).toBe("Committed $5.00 of the $100.00 total cap.");
    // Only the hash is in the database file.
    const file = readFileSync(accountsPath(env));
    expect(file.includes(Buffer.from(code))).toBe(false);
    expect(file.includes(Buffer.from(code.slice(6)))).toBe(false);
  });

  it("refuses codes and grants past the total cap, and bad arguments", () => {
    const env = adminEnv({ APP_JUDGE_TOTAL_CAP_USD: "10" });
    expect(runAdmin(["judges", "create", "--label", "A", "--cap-usd", "6", "--expires", "2099-01-01"], env).code).toBe(0);
    const over = runAdmin(["judges", "create", "--label", "B", "--cap-usd", "5", "--expires", "2099-01-01"], env);
    expect(over.code).toBe(1);
    expect(over.err[0]).toMatch(/total cap/);
    const id = runAdmin(["judges", "list"], env).out[0]!.split(" ")[0]!;
    expect(runAdmin(["judges", "grant", "--id", id, "--usd", "4"], env).code).toBe(0);
    expect(runAdmin(["judges", "grant", "--id", id, "--usd", "0.01"], env).code).toBe(1);
    for (const args of [["judges"], ["judges", "create", "--label", "X"], ["judges", "create", "--label", "X", "--cap-usd", "1", "--expires", "2026-02-30"], ["judges", "revoke", "--id", "../x"], ["judges", "nope"], ["judges", "list", "--extra"]]) {
      expect(runAdmin(args, env).code, args.join(" ")).toBe(2);
    }
    expect(expiryOf("2026-11-30")).toBe(Date.parse("2026-12-01T00:00:00Z"));
  });

  it("revoke ends a judge account's sessions and removes its unspent credit, and its spent part still counts toward the total", () => {
    const env = adminEnv({ APP_JUDGE_TOTAL_CAP_USD: "10" });
    const made = runAdmin(["judges", "create", "--label", "A", "--cap-usd", "8", "--expires", "2099-01-01"], env);
    const code = made.out.find((l) => JUDGE_CODE.test(l))!;
    const store = new AccountsStore(accountsPath(env));
    const account = store.redeemJudgeCode(code);
    const session = store.createSession(account.id);
    // Spend $3.
    const hold = store.hold({ accountId: account.id, workspace: account.id, route: "chat", turn: null, model: "muse-spark-1.3" }, 3_000_000, 1_000_000, 1e12);
    store.settle((hold as { holdId: number }).holdId, null);
    store.close();
    const id = runAdmin(["judges", "list"], env).out[0]!.split(" ")[0]!;
    expect(runAdmin(["judges", "revoke", "--id", id], env).code).toBe(0);
    const after = new AccountsStore(accountsPath(env));
    expect(after.session(session.token)).toBeNull();
    expect(after.balance(account.id)).toBe(0);
    expect(() => after.redeemJudgeCode(code)).toThrow(JudgeCodeError);
    after.close();
    const list = runAdmin(["judges", "list"], env).out;
    expect(list[0]).toContain("spent $3.00  revoked");
    // $3 spent stays committed, so $7 is free again.
    expect(list.at(-1)).toBe("Committed $3.00 of the $10.00 total cap.");
    expect(runAdmin(["judges", "create", "--label", "B", "--cap-usd", "7", "--expires", "2099-01-01"], env).code).toBe(0);
  });
});

describe("redeeming judge codes on the site", () => {
  it("a code is its own sign-in: the first use grants its cap once, and later uses reopen the same account", async () => {
    h = await startHosted();
    const { code } = h.judgeCode("Judge Ada", 5);
    const b1 = h.browser();
    const first = await b1.call("POST", "/api/session/judge", { code });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ signedIn: true, account: { kind: "judge", email: null }, balanceMicros: 5_000_000, balance: "$5.00" });
    const b2 = h.browser();
    const second = await b2.call("POST", "/api/session/judge", { code: `  ${code}  ` });
    expect(second.body.balanceMicros).toBe(5_000_000);
    const idOf = (b: typeof b1) => h!.app.store.session(b.cookies.get(`appt_session_${h!.port}`)!)!.account.id;
    expect(idOf(b1)).toBe(idOf(b2));
    expect(h.app.store.ledger(idOf(b1)).filter((r) => r.kind === "grant")).toHaveLength(1);
    expect(h.app.store.listJudgeCodes()[0]).toMatchObject({ status: "redeemed", accountKind: "judge" });
    // The judge account's case works.
    expect((await b2.call("GET", "/api/state")).status).toBe(200);
    // The code is in no log line.
    expect(h.logs.join("\n")).not.toContain(code);
  });

  it("a Google account can take a code once, and the code then signs in nowhere else", async () => {
    h = await startHosted();
    const { code } = h.judgeCode("Judge Bo", 7);
    const g = h.browser();
    await h.signUp(g);
    const r = await g.call("POST", "/api/account/judge-code", { code });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ balanceMicros: 7_000_000, canAddCode: true });
    // Again: no second grant.
    expect((await g.call("POST", "/api/account/judge-code", { code })).body.balanceMicros).toBe(7_000_000);
    const other = h.browser();
    expect((await other.call("POST", "/api/session/judge", { code })).body.error).toBe("judge_attached");
    // A second code on the same account is refused.
    const second = h.judgeCode("Judge Bo 2", 1);
    expect((await g.call("POST", "/api/account/judge-code", { code: second.code })).body.error).toBe("judge_has_code");
    // Another Google account cannot take the first code.
    const g2 = h.browser();
    await h.signUp(g2, { email: "two@example.com" });
    expect((await g2.call("POST", "/api/account/judge-code", { code })).body.error).toBe("judge_used");
    // A judge account cannot attach a code.
    const j = h.browser();
    await j.call("POST", "/api/session/judge", { code: second.code });
    expect((await j.call("POST", "/api/account/judge-code", { code: h.judgeCode("x", 1).code })).body.error).toBe("judge_judge_account");
  });

  it("refuses an unknown, revoked or expired code, and a judge session ends with its code", async () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    h = await startHosted({ now: () => now });
    const b = h.browser();
    expect((await b.call("POST", "/api/session/judge", { code: "judge_" + "A".repeat(43) })).body.error).toBe("judge_not_found");
    expect((await b.call("POST", "/api/session/judge", { code: "not a code" })).body.error).toBe("judge_not_found");
    const { code, id } = h.judgeCode("Judge Cy", 5, 2);
    expect((await b.call("POST", "/api/session/judge", { code })).status).toBe(200);
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(true);
    now += 2 * 86_400_000 + 1;
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect((await b.call("POST", "/api/session/judge", { code })).body.error).toBe("judge_expired");
    const other = h.judgeCode("Judge Di", 5, 30);
    expect((await b.call("POST", "/api/session/judge", { code: other.code })).status).toBe(200);
    h.app.store.revokeJudgeCode(other.id);
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(false);
    expect((await b.call("POST", "/api/session/judge", { code: other.code })).body.error).toBe("judge_revoked");
    void id;
  });

  it("rate-limits code tries per address, right or wrong", async () => {
    h = await startHosted();
    const b = h.browser();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await b.call("POST", "/api/session/judge", { code: `judge_${"B".repeat(43)}` }, { "CF-Connecting-IP": "198.51.100.4" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
    const { code } = h.judgeCode();
    expect((await b.call("POST", "/api/session/judge", { code }, { "CF-Connecting-IP": "198.51.100.4" })).status).toBe(429);
    expect((await b.call("POST", "/api/session/judge", { code }, { "CF-Connecting-IP": "198.51.100.5" })).status).toBe(200);
  });

  it("the total cap refuses a code beyond it", async () => {
    h = await startHosted({ env: { APP_JUDGE_TOTAL_CAP_USD: "6" } });
    h.judgeCode("A", 5);
    expect(() => h!.judgeCode("B", 2)).toThrow(/total cap/);
    expect(h.app.store.listJudgeCodes()).toHaveLength(1);
  });
});
