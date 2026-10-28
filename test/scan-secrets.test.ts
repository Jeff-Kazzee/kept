// SP6.5 and G-c, with review round 1 findings 3 to 6: the secret scan finds
// a grant token in a tracked file, in any reachable object (an old version,
// a merge result, a binary file, a commit message), in a file name and in a
// ref name, also hex-encoded or split across two lines. It prints only
// where a hit is, and passes on this repository. The planted tokens are
// made at test time in temporary repositories.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasSecret, redact, scanBytes } from "../scripts/scan-secrets.ts";
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
    return r.stdout;
  };
  git("init", "-q", "-b", "main");
  const write = (file: string, content: string | Buffer) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  return { dir, git, write, commit };
}

const scan = (dir: string) => spawnSync(process.execPath, [SCANNER, "--repo", dir], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
const BLOB = "[0-9a-f]{12}";

// A token in the old, unprefixed format: 43 base64url characters with
// every class of character, as a real one has.
function oldToken(): string {
  for (;;) {
    const t = randomBytes(32).toString("base64url");
    if (/[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t)) return t;
  }
}

function expectSilent(run: ReturnType<typeof scan>, ...secrets: string[]) {
  for (const s of secrets) {
    expect(run.stdout + run.stderr).not.toContain(s);
    expect(run.stdout + run.stderr).not.toContain(s.slice(-43, -20));
  }
}

describe("SP6.5 secret scan", () => {
  it("matches tokens, old tokens, hex and split tokens, and skips ordinary text", () => {
    const token = newGrantToken();
    expect(hasSecret(token)).toBe(true);
    expect(hasSecret(`"APPT_GRANT_TOKEN": "${token}"`)).toBe(true);
    expect(hasSecret(`x${token}`)).toBe(true);
    expect(hasSecret(`token=${oldToken()};`)).toBe(true);
    // Finding 5: the hex encoding, in either case.
    const hex = Buffer.from(token).toString("hex");
    expect(hex.startsWith("617070745f")).toBe(true);
    expect(hasSecret(`blob ${hex} end`)).toBe(true);
    expect(hasSecret(hex.toUpperCase())).toBe(true);
    expect(hasSecret(Buffer.from("appt_ is the prefix of a token").toString("hex"))).toBe(false);
    // Finding 5: split across two lines, also after indentation.
    const lines: number[] = [];
    scanBytes(Buffer.from(`one\nkey: ${token.slice(0, 20)}\n    ${token.slice(20)}\nlast\n`), (line, split) => split && lines.push(line));
    expect(lines).toEqual([2]);
    const none: number[] = [];
    scanBytes(Buffer.from("const appt_ = 1\nlooksLikeTextAndNotAToken0123456789abcdefghijk\n"), (line) => none.push(line));
    expect(none).toEqual([]);
    // A lockfile hash is standard base64, and a hex hash has no capitals.
    expect(hasSecret(`integrity: sha512-${randomBytes(64).toString("base64")}`)).toBe(false);
    expect(hasSecret(randomBytes(32).toString("hex"))).toBe(false);
    expect(hasSecret("mcp__claude_ai_Ahrefs__site-explorer-metrics")).toBe(false);
    expect(hasSecret("the appt_ prefix and then 43 base64url characters")).toBe(false);
    expect(hasSecret(`${oldToken()}x`)).toBe(false);
    // Finding 6: a printed name never shows the secret part.
    expect(redact(`fixtures/${token}.json`)).toBe("fixtures/<redacted>.json");
  });

  it("fails on a planted token in a tracked file and in history, and prints only file and line", () => {
    const r = repo();
    r.write("README.md", "Nothing here.\n");
    r.commit("First");
    expect(scan(r.dir)).toMatchObject({ status: 0, stdout: expect.stringMatching(/^Secret scan passed: no grant token in 1 tracked files, 1 commits or 3 reachable objects\.\n$/) });

    const token = newGrantToken();
    r.write("fixtures/case.json", `{\n  "note": "ok",\n  "token": "${token}"\n}\n`);
    r.commit("Add a fixture");
    let run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Possible grant token at fixtures/case.json:3\n");
    expect(run.stdout).toMatch(new RegExp(`Possible grant token at blob ${BLOB} fixtures/case\\.json:3\\n`));
    expectSilent(run, token);

    // Removed from the tree, it is still in history.
    rmSync(path.join(r.dir, "fixtures/case.json"));
    r.commit("Remove it");
    run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("at fixtures/case.json:3\n");
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} fixtures/case\\.json:3`));
    expectSilent(run, token);
  });

  it("finds an old unprefixed token in a log, a token in a commit message, and one on a branch that is not checked out", () => {
    const r = repo();
    r.write("run.log", `started\ntoken ${oldToken()}\n`);
    r.git("add", ".");
    r.git("commit", "-q", "-m", `Log\n\nToken was ${newGrantToken()}`);
    r.git("checkout", "-q", "-b", "side");
    r.write("docs.md", `Use ${newGrantToken()}\n`);
    r.commit("Side");
    r.git("checkout", "-q", "main");
    const run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Possible grant token at run.log:2\n");
    expect(run.stdout).toMatch(new RegExp(`commit ${BLOB}, line \\d+ of its message or header\\n`));
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} docs\\.md:1\\n`));
  });

  it("finding 3: a token in a binary file, in the tree and in history", () => {
    const r = repo();
    const token = newGrantToken();
    r.write("assets/icon.bin", Buffer.concat([Buffer.from([0, 1, 2, 255, 0]), Buffer.from(` ${token} `), Buffer.from([0, 0, 7])]));
    r.commit("Add an icon");
    const run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Possible grant token at assets/icon.bin:1\n");
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} assets/icon\\.bin:1\\n`));
    expectSilent(run, token);
  });

  it("finding 4: a token added only in a merge result and removed later", () => {
    const r = repo();
    r.write("a.txt", "base\n");
    r.commit("Base");
    r.git("checkout", "-q", "-b", "feature");
    r.write("b.txt", "feature\n");
    r.commit("Feature");
    r.git("checkout", "-q", "main");
    r.write("c.txt", "main\n");
    r.commit("Main");
    r.git("merge", "-q", "--no-ff", "--no-commit", "feature");
    const token = newGrantToken();
    r.write("merged.txt", `resolved with ${token}\n`);
    r.commit("Merge feature");
    // Removed in a second merge, so no plain commit's diff shows it either.
    r.git("checkout", "-q", "-b", "later", "feature");
    r.write("d.txt", "later\n");
    r.commit("Later");
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-ff", "--no-commit", "later");
    rmSync(path.join(r.dir, "merged.txt"));
    r.commit("Merge later");
    // `git log --all -p` shows no diff for a merge, so a diff scan misses it.
    expect(r.git("log", "--all", "-p", "--no-color")).not.toContain("merged.txt");
    const run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} merged\\.txt:1\\n`));
    expectSilent(run, token);
  });

  it("finding 5: a hex-encoded token and a token split across two lines in a file", () => {
    const r = repo();
    const a = newGrantToken();
    const b = newGrantToken();
    r.write("dump.txt", `header\n${Buffer.from(a).toString("hex")}\n`);
    r.write("notes.md", `The token is ${b.slice(0, 30)}\n  ${b.slice(30)} and nothing else.\n`);
    r.commit("Notes");
    const run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Possible grant token at dump.txt:2\n");
    expect(run.stdout).toContain("Possible grant token at notes.md:1 (split across lines 1 and 2)\n");
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} notes\\.md:1 \\(split across lines 1 and 2\\)`));
    expectSilent(run, a, b, Buffer.from(a).toString("hex"));
  });

  it("finding 6: a token in a tracked path, in a path only history holds, and in a ref name, printed redacted", () => {
    const r = repo();
    const inPath = newGrantToken();
    const inRef = newGrantToken();
    r.write(`keys/${inPath}.txt`, "hello\n");
    // Same content as another file, so the blob alone would not name it.
    r.write("hello.txt", "hello\n");
    r.commit("Keys");
    r.git("branch", `backup/${inRef}`);
    let run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Possible grant token at tracked path keys/<redacted>.txt\n");
    expect(run.stdout).toContain("Possible grant token at ref name refs/heads/backup/<redacted>\n");
    expect(run.stdout).toMatch(new RegExp(`a file or folder name in tree ${BLOB}: <redacted>\\.txt\\n`));
    expectSilent(run, inPath, inRef);

    r.git("branch", "-D", `backup/${inRef}`);
    r.git("rm", "-q", `keys/${inPath}.txt`);
    r.git("commit", "-q", "-m", "Remove the key");
    run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("tracked path");
    expect(run.stdout).not.toContain("ref name");
    expect(run.stdout).toMatch(new RegExp(`a file or folder name in tree ${BLOB}: <redacted>\\.txt\\n`));
    expectSilent(run, inPath, inRef);
  });

  it("B4: a newline in a path, and a SHA-256 repository", () => {
    const r = repo();
    const token = newGrantToken();
    r.write("odd\nfolder/notes.md", `x ${token}\n`);
    r.commit("Odd name");
    let run = scan(r.dir);
    expect(run.status).toBe(1);
    // The path is read from NUL-delimited output and printed escaped, on one line.
    expect(run.stdout).toContain('Possible grant token at "odd\\nfolder/notes.md":1\n');
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} "odd\\\\nfolder/notes\\.md":1\\n`));

    const dir = mkdtempSync(path.join(tmpdir(), "scan-256-"));
    dirs.push(dir);
    const git = (...args: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    expect(git("init", "-q", "--object-format=sha256").status).toBe(0);
    mkdirSync(path.join(dir, "fixtures"));
    writeFileSync(path.join(dir, "fixtures/a.json"), `"${token}"\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "a");
    rmSync(path.join(dir, "fixtures/a.json"));
    git("add", "-A");
    git("commit", "-q", "-m", "b");
    run = scan(dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/Possible grant token at blob [0-9a-f]{12} fixtures\/a\.json:1\n/);
    expect(git("rev-parse", "--show-object-format").stdout.trim()).toBe("sha256");
  });

  it("B4: fails loudly when it cannot read the repository, instead of passing", () => {
    const notRepo = mkdtempSync(path.join(tmpdir(), "scan-none-"));
    dirs.push(notRepo);
    expect(scan(notRepo)).toMatchObject({ status: 2, stdout: "", stderr: expect.stringContaining("Secret scan could not run") });
    // A missing object.
    const r = repo();
    r.write("a.txt", "a\n");
    r.commit("a");
    const blob = r.git("rev-parse", "HEAD:a.txt").trim();
    rmSync(path.join(r.dir, ".git/objects", blob.slice(0, 2), blob.slice(2)), { force: true });
    expect(scan(r.dir)).toMatchObject({ status: 2, stderr: expect.stringContaining("Secret scan could not run") });
  });

  it("B5: a FIFO in place of a tracked file is skipped with a note, and a symbolic link is scanned as its link text", () => {
    const r = repo();
    const outside = mkdtempSync(path.join(tmpdir(), "scan-outside-"));
    dirs.push(outside);
    const target = newGrantToken();
    writeFileSync(path.join(outside, "secret.txt"), `${target}\n`);
    r.write("pipe", "was a file\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(r.dir, "plain-link"));
    const linkToken = newGrantToken();
    symlinkSync(`/tmp/${linkToken}`, path.join(r.dir, "token-link"));
    r.commit("Files and links");
    rmSync(path.join(r.dir, "pipe"));
    expect(spawnSync("mkfifo", [path.join(r.dir, "pipe")]).status).toBe(0);
    const started = Date.now();
    const run = scan(r.dir);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(run.stdout).toContain("Skipped pipe: not a regular file or a symbolic link.\n");
    // The link's target is not followed. The link text with a token is found,
    // in the tree and in the blob git stores for the link.
    expect(run.stdout).not.toContain("plain-link");
    expect(run.stdout).toContain("Possible grant token at token-link:1\n");
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} token-link:1\\n`));
    expect(run.status).toBe(1);
    expectSilent(run, target, linkToken);
  });

  it("B5: a token on a segment boundary of a long line is found, on disk and in a blob", () => {
    const r = repo();
    const MB = 1 << 20;
    const tokens: string[] = [];
    for (const [i, at] of [MB - 20, 2 * MB - 20, 2 * MB - 250, 3 * MB + 5].entries()) {
      const token = newGrantToken();
      tokens.push(token);
      const line = Buffer.alloc(4 * MB, ".");
      line.write(` ${token} `, at);
      r.write(`big${i}.txt`, Buffer.concat([Buffer.from("first line\n"), line, Buffer.from("\nlast\n")]));
    }
    r.commit("Big files");
    const run = scan(r.dir);
    expect(run.status).toBe(1);
    for (let i = 0; i < tokens.length; i++) {
      expect(run.stdout).toContain(`Possible grant token at big${i}.txt:2\n`);
      expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} big${i}\\.txt:2\\n`));
    }
    expectSilent(run, ...tokens);
    // Only line 2 of each, once.
    expect(run.stdout.match(/Possible grant token/g)).toHaveLength(8);
  }, 60_000);

  it("passes on this repository", () => {
    const run = scan(PACKAGE_ROOT);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^Secret scan passed: no grant token in \d+ tracked files, \d+ commits or \d+ reachable objects\.\n$/);
  }, 60_000);
});
