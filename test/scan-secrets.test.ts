// The secret scan (0009, design 6, keeping the coverage of SP6.5 and
// review round 1 findings 3 to 6): it finds the product key, a
// MODEL_API_KEY assignment with a value or a bearer token, in a tracked
// file, in any reachable object (an old version, a merge result, a binary
// file, a commit message), in a file name and in a ref name. It prints only
// where a hit is, and passes on this repository. The planted keys are made
// up at test time in temporary repositories.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasSecret, jsonSecretFields, redact, scanBytes } from "../scripts/scan-secrets.ts";
import { SecretsStore } from "../src/model/providers/secrets.ts";
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

// A made-up key with upper and lower case letters and digits, as a real
// one may have.
function fakeKey(): string {
  for (;;) {
    const k = randomBytes(30).toString("base64url");
    if (/[A-Z]/.test(k) && /[a-z]/.test(k) && /[0-9]/.test(k)) return k;
  }
}
const assignment = (key = fakeKey()) => ({ key, text: ["MODEL_API_KEY", key].join("=") });
const bearer = (key = fakeKey()) => ({ key, text: `Authorization: Bearer ${key}` });

function expectSilent(run: ReturnType<typeof scan>, ...secrets: string[]) {
  for (const s of secrets) {
    expect(run.stdout + run.stderr).not.toContain(s);
    expect(run.stdout + run.stderr).not.toContain(s.slice(4, 20));
  }
}

describe("the secret scan", () => {
  it("matches a MODEL_API_KEY assignment with a value and a bearer token, and skips templates, references and test values", () => {
    const key = fakeKey();
    const name = "MODEL_API_KEY";
    for (const line of [`${name}=${key}`, `export ${name}=${key}`, `${name}="${key}"`, `${name} = '${key}'`, `  ${name}=${key} # local`, `x=1 ${name}=${key} pnpm start`]) {
      expect(hasSecret(line), line).toBe(true);
    }
    expect(hasSecret(`curl -H "Authorization: Bearer ${key}" https://example.invalid`)).toBe(true);
    for (const line of [
      `${name}=`,
      `${name}=$${name}`,
      `${name}=\${${name}}`,
      `${name}=<your key>`,
      `${name}=short`,
      `${name}: "test-key-not-real"`,
      // A JSON log escapes the newline after an empty template, and a log
      // tool may have redacted a value already.
      `"output":".env.schema:6:${name}=\\n573\\nfixtures/x.json"`,
      `${name}=\\u003credacted\\u003e.txt`,
      `${name}=REDACTED_VALUE_HERE`,
      `process.env.${name}`,
      "Authorization: `Bearer \${this.#apiKey}`",
      "Bearer server-key-1234567890-abcdef",
      "Bearer secret-value-123",
      "integrity: sha512-" + randomBytes(64).toString("base64"),
      randomBytes(32).toString("hex"),
    ]) {
      expect(hasSecret(line), line).toBe(false);
    }
    const lines: number[] = [];
    scanBytes(Buffer.from(`one\n${name}=\nthree ${name}=${key}\nBearer ${key}\n`), (line) => lines.push(line));
    expect(lines).toEqual([3, 4]);
    // A printed name never shows the secret part. The value runs to the
    // next space or quote, so the rest of a name goes with it.
    expect(redact(`notes/${name}=${key}.txt`)).toBe(`notes/${name}=<redacted>`);
    expect(redact(`notes/${name}=${key} copy.txt`)).toBe(`notes/${name}=<redacted> copy.txt`);
  });

  it("fails on a planted key in a tracked file and in history, and prints only file and line", () => {
    const r = repo();
    r.write("README.md", "Nothing here.\n");
    r.commit("First");
    expect(scan(r.dir)).toMatchObject({ status: 0, stdout: expect.stringMatching(/^Secret scan passed: no secret in 1 tracked files, 1 commits or 3 reachable objects\. Skipped local refs: none\.\n$/) });

    const planted = assignment();
    r.write(".env.local.backup", `# saved\nAPP_PORT=5180\n${planted.text}\n`);
    r.commit("Add a backup");
    let run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Possible secret at .env.local.backup:3\n");
    expect(run.stdout).toMatch(new RegExp(`Possible secret at blob ${BLOB} \\.env\\.local\\.backup:3\\n`));
    expectSilent(run, planted.key);

    // Removed from the tree, it is still in history.
    rmSync(path.join(r.dir, ".env.local.backup"));
    r.commit("Remove it");
    run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("at .env.local.backup:3\n");
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} \\.env\\.local\\.backup:3`));
    expectSilent(run, planted.key);
  });

  it("finds a bearer token in a log, a key in a commit message, and one on a branch that is not checked out", () => {
    const r = repo();
    const logged = bearer();
    const inMessage = assignment();
    const onBranch = assignment();
    r.write("run.log", `started\n${logged.text}\n`);
    r.git("add", ".");
    r.git("commit", "-q", "-m", `Log\n\nRan with ${inMessage.text}`);
    r.git("checkout", "-q", "-b", "side");
    r.write("docs.md", `Run ${onBranch.text} pnpm start\n`);
    r.commit("Side");
    r.git("checkout", "-q", "main");
    const run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Possible secret at run.log:2\n");
    expect(run.stdout).toMatch(new RegExp(`commit ${BLOB}, line \\d+ of its message or header\\n`));
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} docs\\.md:1\\n`));
    expectSilent(run, logged.key, inMessage.key, onBranch.key);
  });

  it("finding 3: a key in a binary file, in the tree and in history", () => {
    const r = repo();
    const planted = assignment();
    r.write("assets/icon.bin", Buffer.concat([Buffer.from([0, 1, 2, 255, 0]), Buffer.from(` ${planted.text} `), Buffer.from([0, 0, 7])]));
    r.commit("Add an icon");
    const run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Possible secret at assets/icon.bin:1\n");
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} assets/icon\\.bin:1\\n`));
    expectSilent(run, planted.key);
  });

  it("finding 4: a key added only in a merge result and removed later", () => {
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
    const planted = bearer();
    r.write("merged.txt", `resolved with ${planted.text}\n`);
    r.commit("Merge feature");
    // Removed in a second merge, so no plain commit's diff shows it either.
    r.git("checkout", "-q", "-b", "later", "feature");
    r.write("d.txt", "later\n");
    r.commit("Later");
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-ff", "--no-commit", "later");
    rmSync(path.join(r.dir, "merged.txt"));
    r.commit("Merge later");
    expect(r.git("log", "--all", "-p", "--no-color")).not.toContain("merged.txt");
    const run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} merged\\.txt:1\\n`));
    expectSilent(run, planted.key);
  });

  it("finding 6: a key in a tracked path, in a path only history holds, and in a ref name, printed redacted", () => {
    const r = repo();
    const inPath = assignment();
    const inRef = assignment();
    r.write(`keys/${inPath.text}.txt`, "hello\n");
    // Same content as another file, so the blob alone would not name it.
    r.write("hello.txt", "hello\n");
    r.commit("Keys");
    r.git("branch", `backup/${inRef.text}`);
    let run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Possible secret at tracked path keys/MODEL_API_KEY=<redacted>\n");
    expect(run.stdout).toContain("Possible secret at ref name refs/heads/backup/MODEL_API_KEY=<redacted>\n");
    expect(run.stdout).toMatch(new RegExp(`a file or folder name in tree ${BLOB}: MODEL_API_KEY=<redacted>\\n`));
    expectSilent(run, inPath.key, inRef.key);

    r.git("branch", "-D", `backup/${inRef.text}`);
    r.git("rm", "-q", `keys/${inPath.text}.txt`);
    r.git("commit", "-q", "-m", "Remove the key");
    run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("tracked path");
    expect(run.stdout).not.toContain("ref name");
    expect(run.stdout).toMatch(new RegExp(`a file or folder name in tree ${BLOB}: MODEL_API_KEY=<redacted>\\n`));
    expectSilent(run, inPath.key, inRef.key);
  });

  it("B4: a newline in a path, and a SHA-256 repository", () => {
    const r = repo();
    const planted = assignment();
    r.write("odd\nfolder/notes.md", `x ${planted.text}\n`);
    r.commit("Odd name");
    let run = scan(r.dir);
    expect(run.status).toBe(1);
    // The path is read from NUL-delimited output and printed escaped, on one line.
    expect(run.stdout).toContain('Possible secret at "odd\\nfolder/notes.md":1\n');
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} "odd\\\\nfolder/notes\\.md":1\\n`));

    const dir = mkdtempSync(path.join(tmpdir(), "scan-256-"));
    dirs.push(dir);
    const git = (...args: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    expect(git("init", "-q", "--object-format=sha256").status).toBe(0);
    mkdirSync(path.join(dir, "fixtures"));
    writeFileSync(path.join(dir, "fixtures/a.env"), `${planted.text}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "a");
    rmSync(path.join(dir, "fixtures/a.env"));
    git("add", "-A");
    git("commit", "-q", "-m", "b");
    run = scan(dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/Possible secret at blob [0-9a-f]{12} fixtures\/a\.env:1\n/);
    expect(git("rev-parse", "--show-object-format").stdout.trim()).toBe("sha256");
  });

  it("B4: fails loudly when it cannot read the repository, instead of passing", () => {
    const notRepo = mkdtempSync(path.join(tmpdir(), "scan-none-"));
    dirs.push(notRepo);
    expect(scan(notRepo)).toMatchObject({ status: 2, stdout: "", stderr: expect.stringContaining("Secret scan could not run") });
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
    const target = assignment();
    writeFileSync(path.join(outside, "secret.env"), `${target.text}\n`);
    r.write("pipe", "was a file\n");
    symlinkSync(path.join(outside, "secret.env"), path.join(r.dir, "plain-link"));
    const inLink = assignment();
    symlinkSync(`/tmp/${inLink.text}`, path.join(r.dir, "key-link"));
    r.commit("Files and links");
    rmSync(path.join(r.dir, "pipe"));
    expect(spawnSync("mkfifo", [path.join(r.dir, "pipe")]).status).toBe(0);
    const started = Date.now();
    const run = scan(r.dir);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(run.stdout).toContain("Skipped pipe: not a regular file or a symbolic link.\n");
    // The link's target is not followed. The link text with a key is found,
    // in the tree and in the blob git stores for the link.
    expect(run.stdout).not.toContain("plain-link");
    expect(run.stdout).toContain("Possible secret at key-link:1\n");
    expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} key-link:1\\n`));
    expect(run.status).toBe(1);
    expectSilent(run, target.key, inLink.key);
  });

  it("B5: a key on a segment boundary of a long line is found, on disk and in a blob", () => {
    const r = repo();
    const MB = 1 << 20;
    const keys: string[] = [];
    for (const [i, at] of [MB - 20, 2 * MB - 20, 2 * MB - 250, 3 * MB + 5].entries()) {
      const planted = assignment();
      keys.push(planted.key);
      const line = Buffer.alloc(4 * MB, ".");
      line.write(` ${planted.text} `, at);
      r.write(`big${i}.txt`, Buffer.concat([Buffer.from("first line\n"), line, Buffer.from("\nlast\n")]));
    }
    r.commit("Big files");
    const run = scan(r.dir);
    expect(run.status).toBe(1);
    for (let i = 0; i < keys.length; i++) {
      expect(run.stdout).toContain(`Possible secret at big${i}.txt:2\n`);
      expect(run.stdout).toMatch(new RegExp(`blob ${BLOB} big${i}\\.txt:2\\n`));
    }
    expectSilent(run, ...keys);
    // Only line 2 of each, once.
    expect(run.stdout.match(/Possible secret/g)).toHaveLength(8);
  }, 60_000);

  it("passes on this repository", () => {
    const run = scan(PACKAGE_ROOT);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^Secret scan passed: no secret in \d+ tracked files, \d+ commits or \d+ reachable objects\. Skipped local refs: (none|refs\/[^ ]+ \(\d+\)(, refs\/[^ ]+ \(\d+\))*)\.\n$/);
  }, 60_000);

  it("0010 P25: a token only under a local tool ref is skipped and its prefix named, and one on a branch is found", () => {
    const r = repo();
    r.write("README.md", "Nothing here.\n");
    r.commit("First");
    const token = newGrantToken();
    r.git("checkout", "-q", "-b", "side");
    r.write("leak.txt", `${token}\n`);
    r.commit("Leak");
    r.git("update-ref", "refs/entire/checkpoints/AB/01TEST", "HEAD");
    r.git("update-ref", "refs/t3/checkpoints/1", "HEAD");
    r.git("checkout", "-q", "main");
    r.git("branch", "-q", "-D", "side");
    let run = scan(r.dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^Secret scan passed: .* Skipped local refs: refs\/entire \(1\), refs\/t3 \(1\)\.\n$/);
    expectSilent(run, token);

    r.git("branch", "kept", "refs/entire/checkpoints/AB/01TEST");
    run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(new RegExp(`Possible secret at blob ${BLOB} leak\\.txt:1\\n`));
    expect(run.stdout).toContain("Skipped local refs: refs/entire (1), refs/t3 (1).");
    expectSilent(run, token);
  }, 60_000);

  it("review round 1, finding 5: real settings-file output under another name is found on disk and in history", () => {
    const r = repo();
    r.write("README.md", "Nothing here.\n");
    r.commit("First");
    const metaKey = `LLM|${randomBytes(12).toString("hex")}`;
    const access = randomBytes(24).toString("base64url");
    const refresh = randomBytes(24).toString("base64url");
    new SecretsStore(path.join(r.dir, "backup.json")).update(
      (x) => ({
        ...x,
        meta: { key: metaKey },
        chatgpt: { ...x.chatgpt, session: { id: "s", accessToken: access, refreshToken: refresh, expiresAt: 0, earliestRefreshAt: null, scopes: [], savedAt: "" } },
      }),
      { bump: true },
    );
    // The store writes pretty JSON: "meta": { on one line, "key" on the next.
    expect(readFileSync(path.join(r.dir, "backup.json"), "utf8")).toMatch(/"meta": \{\n\s+"key": /);
    r.commit("Backup");
    let run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/Possible secret at backup\.json:\d+\n/);
    expect(run.stdout).toContain("Possible secret at backup.json (JSON field meta.key)\n");
    expect(run.stdout).toContain("Possible secret at backup.json (JSON field chatgpt.session.accessToken)\n");
    expect(run.stdout).toContain("Possible secret at backup.json (JSON field chatgpt.session.refreshToken)\n");
    expect(run.stdout).toMatch(new RegExp(`Possible secret at blob ${BLOB} backup\\.json \\(JSON field meta\\.key\\)\\n`));
    expectSilent(run, access, refresh);
    expect(run.stdout).not.toContain(metaKey);

    // Only history holds it now, and only the multi-line key and the JSON
    // read would find the key there.
    r.git("rm", "-q", "backup.json");
    r.commit("Remove the backup");
    run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("Possible secret at backup.json");
    expect(run.stdout).toMatch(new RegExp(`Possible secret at blob ${BLOB} backup\\.json:\\d+\\n`));
    expect(run.stdout).toMatch(new RegExp(`Possible secret at blob ${BLOB} backup\\.json \\(JSON field meta\\.key\\)\\n`));
  });

  it("review round 1, finding 5: the two-line key match and the JSON read find the key alone", () => {
    const key = `LLM|${randomBytes(6).toString("hex")}`;
    let lines: number[] = [];
    scanBytes(Buffer.from(`{\n  "meta": {\n    "key": "${key}"\n  }\n}\n`), (line) => lines.push(line));
    expect(lines).toEqual([3]);
    lines = [];
    scanBytes(Buffer.from(`{\n  "meta": {\n    "key": "<META_KEY>"\n  }\n}\n`), (line) => lines.push(line));
    expect(lines).toEqual([]);
    expect(jsonSecretFields(JSON.stringify({ a: [{ meta: { key: key } }] }))).toEqual(["a.0.meta.key"]);
    expect(jsonSecretFields(JSON.stringify({ meta: { key: "<META_KEY>" }, accessToken: "<ACCESS_TOKEN>" }))).toEqual([]);
    expect(jsonSecretFields("not json")).toEqual([]);
  });

  it("0010 P25: a token staged in the index and then changed on disk is found", () => {
    const r = repo();
    r.write("README.md", "Nothing here.\n");
    r.commit("First");
    const token = newGrantToken();
    r.write("staged.txt", `${token}\n`);
    r.git("add", "staged.txt");
    r.write("staged.txt", "clean now\n");
    const run = scan(r.dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(new RegExp(`Possible secret at blob ${BLOB} staged\\.txt:1\\n`));
    expectSilent(run, token);
  }, 60_000);
});
