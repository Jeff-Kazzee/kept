// SP6.5 and G-c: the secret scan finds a grant token in a tracked file and
// in history, prints only where it is, and passes on this repository. The
// planted tokens are made at test time in a temporary repository.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasSecret } from "../scripts/scan-secrets.ts";
import { newGrantToken } from "../src/grants/grants.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";

const SCANNER = path.join(PACKAGE_ROOT, "scripts/scan-secrets.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-"));
  dirs.push(dir);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  git("init", "-q");
  return { dir, git };
}

const scan = (dir: string) => spawnSync(process.execPath, [SCANNER, "--repo", dir], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });

// A token in the old, unprefixed format: 43 base64url characters with
// every class of character, as a real one has.
function oldToken(): string {
  for (;;) {
    const t = randomBytes(32).toString("base64url");
    if (/[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t)) return t;
  }
}

describe("SP6.5 secret scan", () => {
  it("matches tokens, old tokens and tokens inside longer text, and skips ordinary text", () => {
    const token = newGrantToken();
    expect(hasSecret(token)).toBe(true);
    expect(hasSecret(`"APPT_GRANT_TOKEN": "${token}"`)).toBe(true);
    expect(hasSecret(`x${token}`)).toBe(true);
    expect(hasSecret(`token=${oldToken()};`)).toBe(true);
    // A lockfile hash is standard base64, and a hex hash has no capitals.
    expect(hasSecret(`integrity: sha512-${randomBytes(64).toString("base64")}`)).toBe(false);
    expect(hasSecret(randomBytes(32).toString("hex"))).toBe(false);
    expect(hasSecret("mcp__claude_ai_Ahrefs__site-explorer-metrics")).toBe(false);
    expect(hasSecret("the appt_ prefix and then 43 base64url characters")).toBe(false);
    expect(hasSecret(`${oldToken()}x`)).toBe(false);
  });

  it("fails on a planted token in a tracked file and in history, and prints only file and line", () => {
    const { dir, git } = repo();
    mkdirSync(path.join(dir, "fixtures"));
    writeFileSync(path.join(dir, "README.md"), "Nothing here.\n");
    git("add", ".");
    git("commit", "-q", "-m", "First");
    expect(scan(dir)).toMatchObject({ status: 0, stdout: "Secret scan passed: no grant token in 1 tracked files or 1 commits.\n" });

    const token = newGrantToken();
    writeFileSync(path.join(dir, "fixtures/case.json"), `{\n  "note": "ok",\n  "token": "${token}"\n}\n`);
    git("add", ".");
    git("commit", "-q", "-m", "Add a fixture");
    let run = scan(dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Possible grant token at fixtures/case.json:3\n");
    expect(run.stdout).toMatch(/Possible grant token at commit [0-9a-f]{12} fixtures\/case\.json:3\n/);
    expect(run.stdout + run.stderr).not.toContain(token);
    expect(run.stdout + run.stderr).not.toContain(token.slice(5, 20));

    // Removed from the tree, it is still in history.
    rmSync(path.join(dir, "fixtures/case.json"));
    git("add", "-A");
    git("commit", "-q", "-m", "Remove it");
    run = scan(dir);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("at fixtures/case.json:3\n");
    expect(run.stdout).toMatch(/commit [0-9a-f]{12} fixtures\/case\.json:3 \(removed line\)/);
    expect(run.stdout).not.toContain(token);
  });

  it("finds an old unprefixed token in a log, a token in a commit message, and one on a branch that is not checked out", () => {
    const { dir, git } = repo();
    writeFileSync(path.join(dir, "run.log"), `started\ntoken ${oldToken()}\n`);
    git("add", ".");
    git("commit", "-q", "-m", `Log\n\nToken was ${newGrantToken()}`);
    git("checkout", "-q", "-b", "side");
    writeFileSync(path.join(dir, "docs.md"), `Use ${newGrantToken()}\n`);
    git("add", ".");
    git("commit", "-q", "-m", "Side");
    git("checkout", "-q", "-");
    const run = scan(dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Possible grant token at run.log:2\n");
    expect(run.stdout).toMatch(/commit [0-9a-f]{12} message or header/);
    expect(run.stdout).toMatch(/commit [0-9a-f]{12} docs\.md:1\n/);
  });

  it("passes on this repository", () => {
    const run = scan(PACKAGE_ROOT);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^Secret scan passed: no grant token in \d+ tracked files or \d+ commits\.\n$/);
  }, 60_000);
});
