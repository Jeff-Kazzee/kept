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
// It prints only where a hit is. A path or ref name is printed with the
// secret part replaced by <redacted>. Exit code 0 means no hit, 1 means at
// least one hit, 2 means the scan could not run.
//
//   pnpm scan:secrets [--repo <dir>]
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

// Where the run of base64url characters that ends a line starts.
function tailRun(b: Buffer, start: number, end: number): number {
  let i = end;
  while (i > start && isRunByte(b[i - 1])) i--;
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

// A token split at a line break: the tail run of one line and the head run
// of the next, joined, hold a prefixed token that starts on the first line
// and ends on the second.
function splitSecret(b: Buffer, first: Range, second: Range): boolean {
  const tail = b.subarray(tailRun(b, first[0], first[1]), first[1]);
  const [hs, he] = headRun(b, second[0], second[1]);
  if (tail.length === 0 || he === hs) return false;
  const joined = Buffer.concat([tail, b.subarray(hs, he)]);
  const hit = runSecret(joined, 0, joined.length, 0, joined.length);
  return hit !== null && startsWith(joined, hit[0], PREFIX) && hit[0] < tail.length && hit[1] > tail.length;
}

// Calls `hit` with the 1-based number of each line that holds a secret, and
// with the first line of a token split across two lines.
export function scanBytes(b: Buffer, hit: (line: number, split: boolean) => void): void {
  let start = 0;
  let line = 0;
  let previous: Range | null = null;
  const visit = (s: number, e: number) => {
    line++;
    const end = e > s && b[e - 1] === 13 ? e - 1 : e;
    if (lineHasSecret(b, s, end)) hit(line, false);
    if (previous && splitSecret(b, previous, [s, end])) hit(line - 1, true);
    previous = [s, end];
  };
  for (let i = b.indexOf(NEWLINE); i >= 0; i = b.indexOf(NEWLINE, start)) {
    visit(start, i);
    start = i + 1;
  }
  if (start < b.length) visit(start, b.length);
}

// A name with every secret in it replaced, so a location can be printed.
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
  return out + b.subarray(at).toString("utf8");
}

function git(repo: string, args: string[]): string {
  const run = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim()}`);
  return run.stdout;
}

type Hit = (where: string) => void;

// `where` names the line, for example "notes.md:3".
function lineHits(where: (line: number) => string, hit: Hit) {
  return (line: number, split: boolean) => hit(split ? `${where(line)} (split across lines ${line} and ${line + 1})` : where(line));
}

function scanWorkingTree(repo: string, hit: Hit): number {
  const root = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  const files = git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const file of files) {
    if (hasSecret(file)) hit(`tracked path ${redact(file)}`);
    let data: Buffer;
    try {
      data = readFileSync(path.join(root, file));
    } catch {
      // Deleted in the working tree. Its history is still scanned.
      continue;
    }
    scanBytes(data, lineHits((line) => `${redact(file)}:${line}`, hit));
  }
  return files.length;
}

function scanRefs(repo: string, hit: Hit): void {
  for (const ref of git(repo, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)) {
    if (hasSecret(ref)) hit(`ref name ${redact(ref)}`);
  }
}

// Tree entries are "<mode> <name>\0" and a 20-byte object id.
function scanTreeObject(id: string, b: Buffer, hit: Hit): void {
  let i = 0;
  while (i < b.length) {
    const space = b.indexOf(32, i);
    const nul = space < 0 ? -1 : b.indexOf(0, space + 1);
    if (nul < 0) return;
    const name = b.toString("utf8", space + 1, nul);
    if (hasSecret(name)) hit(`a file or folder name in tree ${id.slice(0, 12)}: ${redact(name)}`);
    i = nul + 21;
  }
}

// Reads every reachable object through `git cat-file --batch`.
async function scanObjects(repo: string, hit: Hit): Promise<{ commits: number; objects: number }> {
  const listing = git(repo, ["rev-list", "--all", "--objects"]).split("\n").filter(Boolean);
  const paths = new Map<string, string>();
  for (const line of listing) {
    const space = line.indexOf(" ");
    if (space > 0) paths.set(line.slice(0, space), line.slice(space + 1));
  }
  const ids = [...new Set(listing.map((l) => l.slice(0, 40)))];
  if (ids.length === 0) return { commits: 0, objects: 0 };
  const child = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  child.stdin.end(ids.join("\n") + "\n");

  let commits = 0;
  let objects = 0;
  const visit = (id: string, type: string, body: Buffer) => {
    objects++;
    if (type === "blob") {
      const name = redact(paths.get(id) ?? "(no path)");
      scanBytes(body, lineHits((line) => `blob ${id.slice(0, 12)} ${name}:${line}`, hit));
    } else if (type === "tree") scanTreeObject(id, body, hit);
    else {
      if (type === "commit") commits++;
      scanBytes(body, lineHits((line) => `${type} ${id.slice(0, 12)}, line ${line} of its message or header`, hit));
    }
  };

  // The output is "<id> <type> <size>\n", the object's bytes and "\n".
  // Chunks are joined only once an object is complete, so a large object
  // costs one copy.
  let chunks: Buffer[] = [];
  let buffered = 0;
  let header: { id: string; type: string; size: number } | null = null;
  const take = (n: number): Buffer => {
    const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, buffered);
    chunks = n < all.length ? [all.subarray(n)] : [];
    buffered = all.length - n;
    return all.subarray(0, n);
  };
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    buffered += chunk.length;
    for (;;) {
      if (header === null) {
        const first = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, buffered);
        chunks = [first];
        const nl = first.indexOf(NEWLINE);
        if (nl < 0) break;
        const [id, type, size] = first.toString("utf8", 0, nl).split(" ");
        if (type === "missing" || size === undefined) throw new Error(`object ${id} is missing`);
        take(nl + 1);
        header = { id: id!, type: type!, size: Number(size) };
      }
      if (buffered < header.size + 1) break;
      visit(header.id, header.type, take(header.size + 1).subarray(0, header.size));
      header = null;
    }
  }
  const code = await exited;
  if (code !== 0) throw new Error(`git cat-file failed: ${stderr.trim()}`);
  return { commits, objects };
}

export type ScanResult = { hits: string[]; files: number; commits: number; objects: number };

export async function scanRepo(repo: string): Promise<ScanResult> {
  const hits: string[] = [];
  const seen = new Set<string>();
  const hit = (where: string) => {
    if (seen.has(where)) return;
    seen.add(where);
    hits.push(where);
  };
  const files = scanWorkingTree(repo, hit);
  scanRefs(repo, hit);
  const { commits, objects } = await scanObjects(repo, hit);
  return { hits, files, commits, objects };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { repo: { type: "string" } }, strict: true });
  const repo = path.resolve(values.repo ?? process.cwd());
  try {
    const { hits, files, commits, objects } = await scanRepo(repo);
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
