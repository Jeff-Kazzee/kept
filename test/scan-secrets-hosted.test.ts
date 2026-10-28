// The secret scan covers hosted mode (0014): judge codes in the shape the
// admin command prints, the accounts database by name, and an accounts
// database copied under any name. The planted values are made at test
// time in temporary repositories.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNTS_DB, hasSecret, isSecretFileName, redact, sqliteSecretFields } from "../scripts/scan-secrets.ts";
import { AccountsStore, newJudgeCode } from "../src/hosted/store.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";

const SCANNER = path.join(PACKAGE_ROOT, "scripts/scan-secrets.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-hosted-"));
  dirs.push(dir);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  git("init", "-q", "-b", "main");
  const write = (file: string, content: string | Buffer) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };
  const commit = (message: string) => {
    git("add", "-A", "-f");
    git("commit", "-q", "-m", message);
  };
  return { dir, write, commit };
}

const scan = (dir: string) => spawnSync(process.execPath, [SCANNER, "--repo", dir], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });

function accountsBytes(): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-accounts-"));
  dirs.push(dir);
  const store = new AccountsStore(path.join(dir, "a.sqlite"));
  store.createJudgeCode({ label: "J", capMicros: 1_000_000, expiresAt: Date.now() + 86_400_000, totalCapMicros: 100_000_000 });
  store.close();
  return readFileSync(path.join(dir, "a.sqlite"));
}

describe("the secret scan in hosted mode", () => {
  it("finds a judge code on its own, and not a shorter or longer run", () => {
    const code = newJudgeCode();
    for (const line of [code, `Give the judge ${code} today.`, `"code": "${code}"`, `code=${code}`]) expect(hasSecret(line), line).toBe(true);
    for (const line of ["judge_<code>", `judge_${"x".repeat(42)}`, `judge_${"x".repeat(44)}`, "Judge codes are 43 characters after judge_."]) expect(hasSecret(line), line).toBe(false);
    expect(redact(`codes/${code}.txt`)).toBe("codes/<redacted>.txt");
  });

  it("knows the accounts database by name, and a copy of it under any name", () => {
    for (const name of ["data/hosted/accounts.sqlite", "accounts.sqlite-wal", "accounts.sqlite-shm", "accounts.sqlite-journal"]) expect(isSecretFileName(name), name).toBe(true);
    expect(isSecretFileName("docs/accounts.md")).toBe(false);
    expect(sqliteSecretFields(accountsBytes())).toEqual([ACCOUNTS_DB]);
  });

  it("finds a committed code, an accounts database and its copy, printing only where", () => {
    const code = newJudgeCode();
    const r = repo();
    r.write("notes.txt", `the code is ${code}\n`);
    r.write("backup/accounts.sqlite", accountsBytes());
    r.write("backup/renamed.bin", accountsBytes());
    r.commit("add");
    const run = scan(r.dir);
    expect(run.status).toBe(1);
    const out = `${run.stdout}${run.stderr}`;
    expect(out).toContain("notes.txt");
    expect(out).toContain("backup/accounts.sqlite");
    expect(out).toContain(`backup/renamed.bin (${ACCOUNTS_DB})`);
    expect(out).not.toContain(code);
  });
});
