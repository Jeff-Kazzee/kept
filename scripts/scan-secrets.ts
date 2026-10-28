// Secret scan for grant tokens (G-c, and review round 1 findings 3 to 6).
//
// What it reads:
// - every tracked file as it is on disk, as bytes, binary files included,
//   and every tracked path.
// - every object reachable from any ref (`git rev-list --all --objects`),
//   the bytes of every blob, the text of every commit and tag (headers and
//   message) and every entry name in every tree. So a token in any version
//   of any file, in a merge result, in a binary file or in a file name is
//   read, whatever `git log -p` would show.
// - every ref name.
//
// What it finds, in each of those:
// - a grant token, `appt_` and 43 base64url characters at the end of a run
//   of base64url characters, on one line, or split across two adjacent
//   lines at a line break (spaces and tabs at the start of the second line
//   are ignored).
// - the same token written in hexadecimal, upper or lower case, on one line.
// - a run of exactly 43 base64url characters with an upper-case letter, a
//   lower-case letter and a digit, on one line. That is the shape of a token
//   without its prefix, as tokens were made before sprint 6. A run next to
//   + or /, or followed by = padding, is part of standard base64, such as a
//   lockfile hash, and is skipped. So is a run that starts with `mcp__`, an
//   MCP tool name.
//
// What it does not find: a token in any other encoding (base64 of the
// token, URL encoding, UTF-16, compression or encryption), split into more
// than two parts or with other text between the parts, a hex token split
// across lines, an old unprefixed token split across lines, and anything
// outside this repository's reachable objects and working tree.
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
// in segments that overlap by 256 bytes, so a token on a segment boundary
// is still found.
//
// It prints only where a hit is. A path or ref name is printed with the
// secret part replaced by <redacted>. Exit code 0 means no hit, 1 means at
// least one hit, 2 means the scan could not run.
//
//   pnpm scan:secrets [--repo <dir>]
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const NEWLINE = 10;
const PREFIX = Buffer.from("appt_");
const MCP = Buffer.from("mcp__");
// "appt_" in hexadecimal, without its last digit, which may be f or F.
const HEX_PREFIX = Buffer.from("617070745");
const TOKEN_CHARS = 43;

const isRunByte = (c: number | undefined) =>
  c !== undefined && ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95);
// Standard base64 uses + and /, and ends with = padding. A = before a run
// is an assignment, as in KEY=value, so it does not count.
const isEdgeBefore = (c: number | undefined) => c === 43 || c === 47;
const isEdgeAfter = (c: number | undefined) => c === 43 || c === 47 || c === 61;
const startsWith = (b: Uint8Array, at: number, prefix: Uint8Array) => prefix.every((p, i) => b[at + i] === p);
const hexValue = (c: number | undefined): number =>
  c === undefined ? -1 : c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1;

type Range = [number, number];

function mixedClasses(b: Uint8Array, start: number, end: number): boolean {
  let upper = false;
  let lower = false;
  let digit = false;
  for (let i = start; i < end; i++) {
    const c = b[i]!;
    if (c >= 65 && c <= 90) upper = true;
    else if (c >= 97 && c <= 122) lower = true;
    else if (c >= 48 && c <= 57) digit = true;
  }
  return upper && lower && digit;
}

// The part of a run of base64url characters that is a secret, or null.
function runSecret(b: Uint8Array, start: number, end: number, lineStart: number, lineEnd: number): Range | null {
  const length = end - start;
  if (length >= PREFIX.length + TOKEN_CHARS && startsWith(b, end - PREFIX.length - TOKEN_CHARS, PREFIX)) return [end - PREFIX.length - TOKEN_CHARS, end];
  if (length !== TOKEN_CHARS) return null;
  if ((start > lineStart && isEdgeBefore(b[start - 1])) || (end < lineEnd && isEdgeAfter(b[end]))) return null;
  if (startsWith(b, start, MCP)) return null;
  return mixedClasses(b, start, end) ? [start, end] : null;
}

// Hex-encoded tokens: "617070745f" and then 86 hex digits that decode to
// base64url characters.
function hexSecrets(b: Buffer, start: number, end: number, out: Range[]): void {
  const total = HEX_PREFIX.length + 1 + 2 * TOKEN_CHARS;
  if (end - start < total) return;
  // Searched within the line only.
  const line = b.subarray(start, end);
  for (let k = line.indexOf(HEX_PREFIX); k >= 0 && k + total <= line.length; k = line.indexOf(HEX_PREFIX, k + 1)) {
    const i = start + k;
    const f = b[i + HEX_PREFIX.length];
    if (f !== 102 && f !== 70) continue;
    let ok = true;
    for (let j = i + HEX_PREFIX.length + 1; j < i + total; j += 2) {
      const hi = hexValue(b[j]);
      const lo = hexValue(b[j + 1]);
      if (hi < 0 || lo < 0 || !isRunByte(hi * 16 + lo)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push([i, i + total]);
  }
}

// Every secret in bytes [start, end) of `b`, one line.
export function lineSecrets(b: Buffer, start = 0, end = b.length): Range[] {
  const out: Range[] = [];
  if (end - start < TOKEN_CHARS) return out;
  let run = -1;
  for (let i = start; i <= end; i++) {
    if (i < end && isRunByte(b[i])) {
      if (run < 0) run = i;
    } else if (run >= 0) {
      if (i - run >= TOKEN_CHARS) {
        const hit = runSecret(b, run, i, start, end);
        if (hit) out.push(hit);
      }
      run = -1;
    }
  }
  hexSecrets(b, start, end, out);
  return out;
}

export const lineHasSecret = (b: Buffer, start = 0, end = b.length) => lineSecrets(b, start, end).length > 0;
export const hasSecret = (line: string) => lineHasSecret(Buffer.from(line, "utf8"));

// Where the run of base64url characters that ends `b` starts.
function tailRun(b: Buffer): number {
  let i = b.length;
  while (i > 0 && isRunByte(b[i - 1])) i--;
  return i;
}

// The run that starts a line, after its spaces and tabs.
function headRun(b: Buffer, start: number, end: number): Range {
  let i = start;
  while (i < end && (b[i] === 32 || b[i] === 9)) i++;
  let j = i;
  while (j < end && isRunByte(b[j])) j++;
  return [i, j];
}

// A token split at a line break: the tail run of one line (`previous`, its
// last bytes) and the head run of the next, joined, hold a prefixed token
// that starts on the first line and ends on the second.
function splitSecret(previous: Buffer, b: Buffer, start: number, end: number): boolean {
  const tail = previous.subarray(tailRun(previous));
  const [hs, he] = headRun(b, start, end);
  if (tail.length === 0 || he === hs) return false;
  const joined = Buffer.concat([tail, b.subarray(hs, he)]);
  const hit = runSecret(joined, 0, joined.length, 0, joined.length);
  return hit !== null && startsWith(joined, hit[0], PREFIX) && hit[0] < tail.length && hit[1] > tail.length;
}

// A line longer than this is scanned in segments.
const SEGMENT_BYTES = 1 << 20;
// Each segment starts with the last bytes of the one before, more than the
// longest pattern (a hex token is 96 characters).
const OVERLAP_BYTES = 256;
// What is kept of the line before, for a token split across two lines.
const TAIL_BYTES = 128;

// Scans bytes as they arrive, line by line, and calls `hit` with the
// 1-based number of each line that holds a secret, and with the first line
// of a token split across two lines. A hit found twice in an overlap has
// the same line number, so the caller's set of places keeps it once.
export class LineScanner {
  readonly #hit: (line: number, split: boolean) => void;
  #line = 1;
  #carry: Buffer = Buffer.alloc(0);
  #previous: Buffer | null = null;
  #headChecked = false;

  constructor(hit: (line: number, split: boolean) => void) {
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
    if (lineHasSecret(b, start, end)) this.#hit(this.#line, false);
    if (!this.#headChecked) {
      if (this.#previous && splitSecret(this.#previous, b, start, end)) this.#hit(this.#line - 1, true);
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

export function scanBytes(b: Buffer, hit: (line: number, split: boolean) => void): void {
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

// Each line of a name, so a token split across lines of a file name is
// found too.
const nameHasSecret = (name: string) => {
  let found = false;
  scanBytes(Buffer.from(name, "utf8"), () => (found = true));
  return found;
};

function git(repo: string, args: string[]): string {
  const run = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
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
  return (line: number, split: boolean) => hit(split ? `${where(line)} (split across lines ${line} and ${line + 1})` : where(line));
}

const READ_BYTES = 1 << 20;

function scanWorkingTree(repo: string, hit: Hit, note: (text: string) => void): number {
  const root = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  const files = git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const file of files) {
    const name = redact(file);
    if (nameHasSecret(file)) hit(`tracked path ${name}`);
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
      for (let n = readSync(fd, buffer, 0, READ_BYTES, null); n > 0; n = readSync(fd, buffer, 0, READ_BYTES, null)) {
        scanner.push(Buffer.from(buffer.subarray(0, n)));
      }
      scanner.end();
    } finally {
      closeSync(fd);
    }
  }
  return files.length;
}

function scanRefs(repo: string, hit: Hit): void {
  // Ref names cannot hold a newline or other control characters.
  for (const ref of git(repo, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)) {
    if (nameHasSecret(ref)) hit(`ref name ${redact(ref)}`);
  }
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
    if (!paths.has(child)) paths.set(child, parent === undefined || parent === "" ? name : `${parent}/${name}`);
    i = nul + 1 + raw;
  }
}

// Reads every reachable object through `git cat-file --batch`, as a stream.
async function scanObjects(repo: string, hit: Hit): Promise<{ commits: number; objects: number }> {
  const { hex, raw } = objectFormat(repo);
  const idPattern = new RegExp(`^[0-9a-f]{${hex}}$`);
  const ids = git(repo, ["rev-list", "--all", "--objects", "--no-object-names"]).split("\n").filter(Boolean);
  for (const id of ids) if (!idPattern.test(id)) throw new Error("git rev-list printed a line that is not an object id");
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { commits: 0, objects: 0 };
  // Paths of trees and blobs, from root trees down.
  const paths = new Map<string, string>();
  const child = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  child.stdin.end(unique.join("\n") + "\n");

  let commits = 0;
  let objects = 0;
  type Body = { id: string; type: string; remaining: number; scanner: LineScanner | null; tree: Buffer[] };
  let state: "header" | "body" | "newline" = "header";
  let body: Body | null = null;
  let pending: Buffer = Buffer.alloc(0);

  const open = (id: string, type: string, size: number): Body => {
    if (type === "blob") {
      const name = redact(paths.get(id) ?? "(path unknown)");
      return { id, type, remaining: size, scanner: new LineScanner(lineHits((line) => `blob ${id.slice(0, 12)} ${name}:${line}`, hit)), tree: [] };
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
        if (body!.type === "tree" || body!.type === "commit") body!.tree.push(Buffer.from(part));
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

export type ScanResult = { hits: string[]; notes: string[]; files: number; commits: number; objects: number };

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
  scanRefs(repo, hit);
  const { commits, objects } = await scanObjects(repo, hit);
  return { hits, notes, files, commits, objects };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { repo: { type: "string" } }, strict: true });
  const repo = path.resolve(values.repo ?? process.cwd());
  try {
    const { hits, notes, files, commits, objects } = await scanRepo(repo);
    for (const n of notes) console.log(n);
    for (const h of hits) console.log(`Possible grant token at ${h}`);
    if (hits.length > 0) {
      console.log(`Secret scan failed: ${hits.length} place${hits.length === 1 ? "" : "s"} to check. The matched text is not shown.`);
      console.log("For a blob, `git log --all --find-object=<id>` lists the commits that hold it.");
      process.exit(1);
    }
    console.log(`Secret scan passed: no grant token in ${files} tracked files, ${commits} commits or ${objects} reachable objects.`);
  } catch (err) {
    console.error(`Secret scan could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
