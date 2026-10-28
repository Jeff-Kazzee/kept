// Secret scan for the product key (0009, design 6) and the provider
// secrets of 0010. Grant tokens no longer exist. The secrets that matter
// are MODEL_API_KEY, the Meta Model API key, which lives only in .env.local
// and in the server's environment, and the user's Meta key and ChatGPT
// tokens, which live only in the app's settings file.
//
// What it reads (its scope is what can be published, 0010 P25):
// - every tracked file as it is on disk, as bytes, binary files included,
//   and every tracked path.
// - every blob staged in the index, so a secret staged and then changed on
//   disk is still read.
// - every object reachable from a branch, a tag, a remote-tracking ref or
//   HEAD (`git rev-list --objects` over refs/heads, refs/tags, refs/remotes
//   and HEAD): the bytes of every blob, the text of every commit and tag
//   (headers and message) and every entry name in every tree. So a secret in
//   any version of any file on those refs, in a merge result, in a binary
//   file or in a file name is read, whatever `git log -p` would show.
// - the name of every branch, tag and remote-tracking ref.
//
// What it skips: every other ref, such as local tool refs (refs/entire/*,
// refs/t3/*) and refs/stash, which are never pushed. Their prefixes and
// counts are named in the summary line, so the gap stays visible. An object
// reachable only from them is not read.
//
// What it finds, on one line, in each of those:
// - an assignment of MODEL_API_KEY with a value: `MODEL_API_KEY=value`,
//   with optional spaces, `export` and quotes, as in an env file or a shell
//   line. The value is at least 12 characters and ends at a space, a quote
//   or a backslash, so an escaped newline in a JSON log ends it. A value
//   that starts with $, < or REDACTED, such as $MODEL_API_KEY, <your key>
//   or a log tool's redaction, is a reference or a placeholder, not a key,
//   and `MODEL_API_KEY=` with nothing after it, as in .env.schema, is the
//   empty template.
// - a bearer token in a request header or log: `Bearer ` and a run of at
//   least 24 token characters with an upper-case letter, a lower-case
//   letter and a digit. `Bearer ${key}` in code is a template, and a
//   made-up test value such as `Bearer server-key-1` has one case only.
// - a provider secret in the shape the app's settings file stores it: a
//   JSON field named accessToken, refreshToken, access_token,
//   refresh_token or id_token whose value is 20 or more token characters,
//   or a "meta": { "key": ... } field with a value of 8 or more, on one
//   line or with "key" on the line after "meta": {. Every .json file up to
//   8 MB, on disk or in history, is also read as JSON for those fields, so
//   a renamed copy of the settings file is found whatever its layout.
//   Only an exact placeholder such as "<ACCESS_TOKEN>" is skipped.
// - a SQLite file, under any name, whose settings rows hold those fields:
//   the app's settings database (app-secrets.sqlite) or a copy of it. Every
//   file and blob up to 8 MB that starts with the SQLite header is opened
//   from a private read-only copy.
// - a judge access code (0014) in the shape the admin command prints it:
//   "judge_" and 43 base64url characters, on its own.
// - a SQLite file, under any name, that is hosted mode's accounts database
//   or a copy of it: one with a judge_codes or sessions table. It holds
//   only hashes of codes and sessions, but also email addresses.
// - a file or folder name that is the app's settings file
//   (app-secrets.sqlite and its -wal, -shm and -journal files, or the
//   older app-secrets.json and its temporary file), hosted mode's
//   accounts database (accounts.sqlite and its -wal, -shm and -journal
//   files), or a
//   local env file (.env.local, .env.<name>.local), in the working tree or
//   in any tree in history.
// The key's own shape is not known to this scan, so it does not look for a
// bare key. A key written anywhere without its name or `Bearer` is not
// found, nor one in another encoding (base64, URL encoding, UTF-16,
// compression or encryption), one split across lines, or anything outside
// this repository's reachable objects and working tree.
//
// How it reads (review round 2, B4 and B5): object ids have the length of
// the repository's object format (`git rev-parse --show-object-format`),
// and the scan stops with exit code 2 on a format it does not know or on
// output it cannot parse. Paths come from NUL-delimited output (`ls-files
// -z` and the tree objects themselves), so a newline in a name is read
// right. A tracked path that is not a regular file or a symbolic link (a
// FIFO, a device, a folder of a submodule) is not opened. It is listed as
// skipped. A symbolic link is scanned as its link text, as git stores it.
// Files and objects are read as a stream. A line longer than 1 MB is read
// in segments that overlap by 256 bytes, so a key on a segment boundary is
// still found.
//
// It prints only where a hit is. A path or ref name is printed with the
// secret part replaced by <redacted>. Exit code 0 means no hit, 1 means at
// least one hit, 2 means the scan could not run.
//
//   pnpm scan:secrets [--repo <dir>]
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const NEWLINE = 10;

type Range = [number, number];

// The value of a MODEL_API_KEY assignment, and a bearer token. Read on the
// line's bytes as latin1, so string offsets are byte offsets.
const ASSIGNMENT = /(?<![A-Za-z0-9_])MODEL_API_KEY[ \t]*=[ \t]*["']?([^\s"'`$<>\\]{12,})/g;
// A redaction a log tool already made is not a key.
const PLACEHOLDER = /^redacted/i;
const BEARER = /(?<![A-Za-z0-9_])Bearer[ \t]+([A-Za-z0-9._~+/=|-]{24,})/g;
// A judge access code, as src/hosted/store.ts makes it.
const JUDGE = /(?<![A-Za-z0-9_-])(judge_[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;
const MIXED = (v: string) => /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v);

// Provider secrets as the settings file writes them (0010). The value
// shape is what the app accepts: a Meta key is 8 or more printable ASCII
// characters with no space, and a token is any such run of 20 or more. In
// JSON text a quote or a backslash in it is escaped. Only an exact
// placeholder such as <META_KEY> or <ACCESS_TOKEN> is skipped. Read as
// latin1, so each character is one byte and a match index is a byte offset.
const JSON_VALUE = String.raw`((?:[\x21\x23-\x5b\x5d-\x7e]|\\["\\])+)`;
const FIELD_SECRET = new RegExp(
  String.raw`"(?:accessToken|refreshToken|access_token|refresh_token|id_token)"\s*:\s*"${JSON_VALUE}"|"meta"\s*:\s*\{\s*"key"\s*:\s*"${JSON_VALUE}"`,
  "g",
);
const FIELD_PLACEHOLDER = /^<[A-Z][A-Z0-9_]*>$/;
export const KEY_MIN = 8;
export const TOKEN_MIN = 20;
const unescapeJson = (v: string) => v.replace(/\\(["\\])/g, "$1");
const isSecretValue = (value: string, min: number) => value.length >= min && !FIELD_PLACEHOLDER.test(value);

function fieldSecrets(line: string, start: number, out: Range[]): void {
  for (const m of line.matchAll(FIELD_SECRET)) {
    const raw = (m[1] ?? m[2])!;
    if (!isSecretValue(unescapeJson(raw), m[1] !== undefined ? TOKEN_MIN : KEY_MIN)) continue;
    const at = start + m.index + m[0].lastIndexOf(raw);
    out.push([at, at + raw.length]);
  }
}

// The Meta key as the settings file writes it, pretty-printed: "meta": {
// at the end of one line and "key": "..." at the start of the next. Bounded
// to those two lines.
const META_OPEN = /"meta"\s*:\s*\{\s*$/;
const KEY_LINE = new RegExp(String.raw`^\s*"key"\s*:\s*"${JSON_VALUE}"`);
const keyLine = (text: string) => {
  const m = KEY_LINE.exec(text);
  return m !== null && isSecretValue(unescapeJson(m[1]!), KEY_MIN);
};

const TOKEN_FIELDS = new Set(["accessToken", "refreshToken", "access_token", "refresh_token", "id_token"]);
const PRINTABLE = /^[\x21-\x7e]+$/;
const isStoredSecret = (v: unknown, min: number): boolean => typeof v === "string" && PRINTABLE.test(v) && isSecretValue(v, min);
// A .json file up to this size is also read as JSON, so a token or key is
// found however the file is laid out.
export const JSON_SCAN_BYTES = 8 << 20;
export const isJsonPath = (name: string) => /\.json$/i.test(name);

// The paths of secret fields in a JSON text, such as "meta.key" or
// "chatgpt.session.refreshToken". Text that is not JSON gives none.
export function jsonSecretFields(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (v: unknown, at: string, depth: number): void => {
    if (depth > 64 || v === null || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const here = at === "" ? k : `${at}.${k}`;
      if (TOKEN_FIELDS.has(k) && isStoredSecret(child, TOKEN_MIN)) out.push(here);
      if (k === "meta" && child && typeof child === "object") {
        const key = (child as Record<string, unknown>).key;
        if (isStoredSecret(key, KEY_MIN)) out.push(`${here}.key`);
      }
      walk(child, here, depth + 1);
    }
  };
  walk(value, "", 0);
  return out;
}

// The app's settings file and local env files must never be tracked.
const SECRET_FILE_NAME = /^(?:app-secrets\.sqlite(?:-wal|-shm|-journal)?|accounts\.sqlite(?:-wal|-shm|-journal)?|app-secrets\.json|\.app-secrets\.json\..*\.tmp|\.env\.local|\.env\.[^/]+\.local)$/;

export const ACCOUNTS_DB = "accounts database";

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
export const isSqlite = (b: Buffer) => b.length >= SQLITE_MAGIC.length && b.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC);

// The secret fields in the settings rows of a SQLite file, such as the
// app's settings database under any name. Read from a private copy, read
// only. A file that is not one, or holds no settings table, gives none.
export function sqliteSecretFields(bytes: Buffer): string[] {
  if (!isSqlite(bytes)) return [];
  const dir = mkdtempSync(path.join(tmpdir(), "scan-sqlite-"));
  try {
    const file = path.join(dir, "copy.sqlite");
    writeFileSync(file, bytes, { mode: 0o600 });
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      // Hosted mode's accounts database (0014), under any name.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('judge_codes', 'sessions')").get()) return [ACCOUNTS_DB];
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
      if (!table) return [];
      const out: string[] = [];
      for (const row of db.prepare("SELECT data FROM settings").all() as Array<{ data: unknown }>) {
        if (typeof row.data === "string") out.push(...jsonSecretFields(row.data));
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export const isSecretFileName = (name: string) => SECRET_FILE_NAME.test(name.split("/").at(-1) ?? name);

// Every secret in bytes [start, end) of `b`, one line.
export function lineSecrets(b: Buffer, start = 0, end = b.length): Range[] {
  const line = b.toString("latin1", start, end);
  const out: Range[] = [];
  fieldSecrets(line, start, out);
  for (const re of [ASSIGNMENT, BEARER, JUDGE]) {
    for (const m of line.matchAll(re)) {
      const value = m[1]!;
      if (re === BEARER && !MIXED(value)) continue;
      if (re === ASSIGNMENT && PLACEHOLDER.test(value)) continue;
      const at = m.index! + m[0].length - value.length;
      out.push([start + at, start + at + value.length]);
    }
  }
  return out;
}

export const lineHasSecret = (b: Buffer, start = 0, end = b.length) => lineSecrets(b, start, end).length > 0;
export const hasSecret = (line: string) => lineHasSecret(Buffer.from(line, "utf8"));

// What is kept of the line before, for the two-line key match.
const TAIL_BYTES = 128;

// A line longer than this is scanned in segments.
const SEGMENT_BYTES = 1 << 20;
// Each segment starts with the last bytes of the one before, more than a
// key and its name.
const OVERLAP_BYTES = 256;

// Scans bytes as they arrive, line by line, and calls `hit` with the
// 1-based number of each line that holds a secret. A hit found twice in an
// overlap has the same line number, so the caller's set of places keeps it
// once.
export class LineScanner {
  readonly #hit: (line: number) => void;
  #line = 1;
  #carry: Buffer = Buffer.alloc(0);
  // The end of the line before, for the two-line key match.
  #previous: Buffer | null = null;
  #headChecked = false;

  constructor(hit: (line: number) => void) {
    this.#hit = hit;
  }

  push(chunk: Buffer): void {
    const data = this.#carry.length === 0 ? chunk : Buffer.concat([this.#carry, chunk]);
    let start = 0;
    for (let nl = data.indexOf(NEWLINE); nl >= 0; nl = data.indexOf(NEWLINE, start)) {
      this.#finishLine(data, start, nl);
      start = nl + 1;
    }
    let rest = data.subarray(start);
    if (rest.length > SEGMENT_BYTES) {
      this.#check(rest, 0, rest.length);
      rest = rest.subarray(rest.length - OVERLAP_BYTES);
    }
    // A copy, so the chunk the bytes came from can be freed.
    this.#carry = Buffer.from(rest);
  }

  end(): void {
    if (this.#carry.length > 0) this.#finishLine(this.#carry, 0, this.#carry.length);
    this.#carry = Buffer.alloc(0);
  }

  #check(b: Buffer, start: number, end: number): void {
    if (lineHasSecret(b, start, end)) this.#hit(this.#line);
    // The Meta key split over two lines, "meta": { and then "key": "...".
    if (!this.#headChecked) {
      if (this.#previous && META_OPEN.test(this.#previous.toString("latin1")) && keyLine(b.toString("latin1", start, Math.min(end, start + 4096)))) {
        this.#hit(this.#line);
      }
      this.#headChecked = true;
    }
  }

  #finishLine(b: Buffer, start: number, nl: number): void {
    const end = nl > start && b[nl - 1] === 13 ? nl - 1 : nl;
    this.#check(b, start, end);
    this.#previous = Buffer.from(b.subarray(Math.max(start, end - TAIL_BYTES), end));
    this.#line++;
    this.#headChecked = false;
  }
}

export function scanBytes(b: Buffer, hit: (line: number) => void): void {
  const scanner = new LineScanner(hit);
  scanner.push(b);
  scanner.end();
}

// A name with every secret in it replaced, and control characters such as
// a newline shown escaped, so a location can be printed on one line.
export function redact(name: string): string {
  const b = Buffer.from(name, "utf8");
  const ranges = lineSecrets(b).sort((x, y) => x[0] - y[0]);
  let out = "";
  let at = 0;
  for (const [s, e] of ranges) {
    if (s < at) continue;
    out += b.subarray(at, s).toString("utf8") + "<redacted>";
    at = e;
  }
  out += b.subarray(at).toString("utf8");
  return /[\u0000-\u001f\u007f]/.test(out) ? JSON.stringify(out) : out;
}

// Each line of a name.
const nameHasSecret = (name: string) => {
  let found = false;
  scanBytes(Buffer.from(name, "utf8"), () => (found = true));
  return found;
};

function git(repo: string, args: string[], input?: string): string {
  const run = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, input });
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim()}`);
  return run.stdout;
}

// The repository's object format: the length of an id in hex and in bytes.
function objectFormat(repo: string): { hex: number; raw: number } {
  const format = git(repo, ["rev-parse", "--show-object-format"]).trim();
  if (format === "sha1") return { hex: 40, raw: 20 };
  if (format === "sha256") return { hex: 64, raw: 32 };
  throw new Error(`object format ${JSON.stringify(format)} is not supported`);
}

type Hit = (where: string) => void;

// `where` names the line, for example "notes.md:3".
function lineHits(where: (line: number) => string, hit: Hit) {
  return (line: number) => hit(where(line));
}

const READ_BYTES = 1 << 20;

function scanWorkingTree(repo: string, hit: Hit, note: (text: string) => void): number {
  const root = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  const files = git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const file of files) {
    const name = redact(file);
    if (nameHasSecret(file)) hit(`tracked path ${name}`);
    if (isSecretFileName(file)) hit(`tracked settings or env file ${name}`);
    const full = path.join(root, file);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(full);
    } catch {
      // Deleted in the working tree. Its history is still scanned.
      continue;
    }
    const scanner = new LineScanner(lineHits((line) => `${name}:${line}`, hit));
    if (stat.isSymbolicLink()) {
      // Git stores a link as its text, so the link is scanned, not its target.
      scanner.push(readlinkSync(full, { encoding: "buffer" }));
      scanner.end();
      continue;
    }
    if (!stat.isFile()) {
      note(`Skipped ${name}: not a regular file or a symbolic link.`);
      continue;
    }
    // O_NONBLOCK and a second check on the open file, so a FIFO put there
    // after the lstat cannot hang the scan.
    const fd = openSync(full, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) {
        note(`Skipped ${name}: not a regular file or a symbolic link.`);
        continue;
      }
      const buffer = Buffer.alloc(READ_BYTES);
      // Kept whole, up to a size, to read it as JSON or as a SQLite file.
      const json = fstatSync(fd).size <= JSON_SCAN_BYTES ? ([] as Buffer[]) : null;
      for (let n = readSync(fd, buffer, 0, READ_BYTES, null); n > 0; n = readSync(fd, buffer, 0, READ_BYTES, null)) {
        const chunk = Buffer.from(buffer.subarray(0, n));
        scanner.push(chunk);
        json?.push(chunk);
      }
      scanner.end();
      if (json) {
        const whole = Buffer.concat(json);
        if (isJsonPath(file)) for (const field of jsonSecretFields(whole.toString("utf8"))) hit(`${name} (JSON field ${redact(field)})`);
        for (const field of sqliteSecretFields(whole)) hit(field === ACCOUNTS_DB ? `${name} (${ACCOUNTS_DB})` : `${name} (settings database field ${redact(field)})`);
      }
    } finally {
      closeSync(fd);
    }
  }
  return files.length;
}

// Refs that can be published: branches, tags and remote-tracking refs.
const PUBLISHED_REF = /^refs\/(heads|tags|remotes)\//;

export type RefScope = { published: string[]; skipped: Array<{ prefix: string; count: number }> };

// Splits the refs into the published ones and the skipped ones, counted by
// their first two name parts, such as refs/entire.
function refScope(repo: string): RefScope {
  // Ref names cannot hold a newline or other control characters.
  const refs = git(repo, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);
  const published = refs.filter((r) => PUBLISHED_REF.test(r));
  const counts = new Map<string, number>();
  for (const r of refs) {
    if (PUBLISHED_REF.test(r)) continue;
    const prefix = r.split("/").slice(0, 2).join("/");
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const skipped = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, count]) => ({ prefix, count }));
  return { published, skipped };
}

function scanRefs(refs: string[], hit: Hit): void {
  for (const ref of refs) {
    if (nameHasSecret(ref)) hit(`ref name ${redact(ref)}`);
  }
}

// The blobs staged in the index, with their paths. Submodule entries
// (mode 160000) name a commit in another repository and are left out.
function indexBlobs(repo: string): Array<{ id: string; path: string }> {
  const out: Array<{ id: string; path: string }> = [];
  for (const entry of git(repo, ["ls-files", "-s", "-z"]).split("\0").filter(Boolean)) {
    const m = /^(\d{6}) ([0-9a-f]+) \d\t([\s\S]*)$/.exec(entry);
    if (!m) throw new Error("git ls-files printed an index entry the scan cannot read");
    if (m[1] === "160000") continue;
    out.push({ id: m[2]!, path: m[3]! });
  }
  return out;
}

// Tree entries are "<mode> <name>\0" and the raw object id. Each entry's
// path is set from the tree's own, so a blob found later is named.
function scanTreeObject(id: string, b: Buffer, raw: number, paths: Map<string, string>, hit: Hit): void {
  const parent = paths.get(id);
  let i = 0;
  while (i < b.length) {
    const space = b.indexOf(32, i);
    const nul = space < 0 ? -1 : b.indexOf(0, space + 1);
    if (nul < 0 || nul + 1 + raw > b.length) throw new Error(`tree ${id} could not be read`);
    const name = b.toString("utf8", space + 1, nul);
    const child = b.toString("hex", nul + 1, nul + 1 + raw);
    if (nameHasSecret(name)) hit(`a file or folder name in tree ${id.slice(0, 12)}: ${redact(name)}`);
    if (isSecretFileName(name)) hit(`a settings or env file in tree ${id.slice(0, 12)}: ${redact(name)}`);
    if (!paths.has(child)) paths.set(child, parent === undefined || parent === "" ? name : `${parent}/${name}`);
    i = nul + 1 + raw;
  }
}

// Reads every object reachable from the published refs and HEAD, and every
// staged blob, through `git cat-file --batch`, as a stream.
async function scanObjects(repo: string, refs: string[], hit: Hit): Promise<{ commits: number; objects: number }> {
  const { hex, raw } = objectFormat(repo);
  const idPattern = new RegExp(`^[0-9a-f]{${hex}}$`);
  const head = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
  const tips = [...refs, ...(head.status === 0 ? ["HEAD"] : [])];
  const ids = tips.length === 0 ? [] : git(repo, ["rev-list", "--objects", "--no-object-names", "--stdin"], tips.join("\n") + "\n").split("\n").filter(Boolean);
  for (const id of ids) if (!idPattern.test(id)) throw new Error("git rev-list printed a line that is not an object id");
  // Paths of trees and blobs, from root trees down. Staged blobs are named
  // by their index path.
  const paths = new Map<string, string>();
  const staged = indexBlobs(repo);
  for (const { id, path: p } of staged) {
    if (!idPattern.test(id)) throw new Error("git ls-files printed an object id the scan cannot read");
    if (!paths.has(id)) paths.set(id, p);
  }
  const unique = [...new Set([...ids, ...staged.map((b) => b.id)])];
  if (unique.length === 0) return { commits: 0, objects: 0 };
  const child = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  child.stdin.end(unique.join("\n") + "\n");

  let commits = 0;
  let objects = 0;
  type Body = { id: string; type: string; remaining: number; scanner: LineScanner | null; tree: Buffer[]; whole?: { where: string; json: boolean } };
  let state: "header" | "body" | "newline" = "header";
  let body: Body | null = null;
  let pending: Buffer = Buffer.alloc(0);

  const open = (id: string, type: string, size: number): Body => {
    if (type === "blob") {
      const name = redact(paths.get(id) ?? "(path unknown)");
      // Kept whole, up to a size, to read it as JSON or as a SQLite file.
      const whole = size <= JSON_SCAN_BYTES ? { where: `blob ${id.slice(0, 12)} ${name}`, json: isJsonPath(paths.get(id) ?? "") } : undefined;
      return { id, type, remaining: size, scanner: new LineScanner(lineHits((line) => `blob ${id.slice(0, 12)} ${name}:${line}`, hit)), tree: [], whole };
    }
    if (type === "tree") return { id, type, remaining: size, scanner: null, tree: [] };
    if (type === "commit" || type === "tag") {
      return { id, type, remaining: size, scanner: new LineScanner(lineHits((line) => `${type} ${id.slice(0, 12)}, line ${line} of its message or header`, hit)), tree: [] };
    }
    throw new Error(`object ${id} has type ${type}, which the scan does not read`);
  };
  const close = (b: Body) => {
    objects++;
    if (b.type === "tree") return scanTreeObject(b.id, Buffer.concat(b.tree), raw, paths, hit);
    b.scanner!.end();
    if (b.whole) {
      const bytes = Buffer.concat(b.tree);
      if (b.whole.json) for (const field of jsonSecretFields(bytes.toString("utf8"))) hit(`${b.whole.where} (JSON field ${redact(field)})`);
      for (const field of sqliteSecretFields(bytes)) hit(field === ACCOUNTS_DB ? `${b.whole.where} (${ACCOUNTS_DB})` : `${b.whole.where} (settings database field ${redact(field)})`);
    }
    if (b.type === "commit") {
      commits++;
      // The commit's root tree has the root path.
      const m = /^tree ([0-9a-f]+)$/m.exec(Buffer.concat(b.tree).toString("utf8"));
      if (m && !paths.has(m[1]!)) paths.set(m[1]!, "");
    }
  };

  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    const data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    pending = Buffer.alloc(0);
    let pos = 0;
    while (pos < data.length) {
      if (state === "header") {
        const nl = data.indexOf(NEWLINE, pos);
        if (nl < 0) {
          pending = Buffer.from(data.subarray(pos));
          break;
        }
        const [id, type, size, extra] = data.toString("utf8", pos, nl).split(" ");
        if (type === "missing") throw new Error(`object ${id} is missing`);
        if (!idPattern.test(id ?? "") || !/^\d+$/.test(size ?? "") || extra !== undefined) throw new Error("git cat-file printed a header the scan cannot read");
        body = open(id!, type!, Number(size));
        pos = nl + 1;
        state = "body";
      }
      if (state === "body") {
        const take = Math.min(body!.remaining, data.length - pos);
        const part = data.subarray(pos, pos + take);
        // Trees are parsed whole. A commit is kept whole too, small as it
        // is, to read the root tree it names.
        if (body!.type === "tree" || body!.type === "commit" || body!.whole !== undefined) body!.tree.push(Buffer.from(part));
        if (body!.type !== "tree" && take > 0) body!.scanner!.push(part);
        pos += take;
        body!.remaining -= take;
        if (body!.remaining > 0) break;
        close(body!);
        body = null;
        state = "newline";
      }
      if (state === "newline") {
        if (pos >= data.length) break;
        if (data[pos] !== NEWLINE) throw new Error("git cat-file output is out of step");
        pos++;
        state = "header";
      }
    }
  }
  const code = await exited;
  if (code !== 0) throw new Error(`git cat-file failed: ${stderr.trim()}`);
  if (state !== "header" || pending.length > 0) throw new Error("git cat-file output ended early");
  if (objects !== unique.length) throw new Error(`git cat-file returned ${objects} of ${unique.length} objects`);
  return { commits, objects };
}

export type ScanResult = { hits: string[]; notes: string[]; files: number; commits: number; objects: number; skipped: RefScope["skipped"] };

export function skippedText(skipped: RefScope["skipped"]): string {
  return skipped.length === 0 ? "Skipped local refs: none." : `Skipped local refs: ${skipped.map((s) => `${s.prefix} (${s.count})`).join(", ")}.`;
}

export async function scanRepo(repo: string): Promise<ScanResult> {
  const hits: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const hit = (where: string) => {
    if (seen.has(where)) return;
    seen.add(where);
    hits.push(where);
  };
  const files = scanWorkingTree(repo, hit, (text) => notes.push(text));
  const { published, skipped } = refScope(repo);
  scanRefs(published, hit);
  const { commits, objects } = await scanObjects(repo, published, hit);
  return { hits, notes, files, commits, objects, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { repo: { type: "string" } }, strict: true });
  const repo = path.resolve(values.repo ?? process.cwd());
  try {
    const { hits, notes, files, commits, objects, skipped } = await scanRepo(repo);
    for (const n of notes) console.log(n);
    for (const h of hits) console.log(`Possible secret at ${h}`);
    if (hits.length > 0) {
      console.log(`Secret scan failed: ${hits.length} place${hits.length === 1 ? "" : "s"} to check. The matched text is not shown. ${skippedText(skipped)}`);
      console.log("For a blob, `git log --all --find-object=<id>` lists the commits that hold it.");
      process.exit(1);
    }
    console.log(`Secret scan passed: no secret in ${files} tracked files, ${commits} commits or ${objects} reachable objects. ${skippedText(skipped)}`);
  } catch (err) {
    console.error(`Secret scan could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
