// Secret scan for the product key (0009, design 6). Grant tokens no longer
// exist. The secret that matters is MODEL_API_KEY, the Meta Model API key,
// which lives only in .env.local and in the server's environment.
//
// What it reads:
// - every tracked file as it is on disk, as bytes, binary files included,
//   and every tracked path.
// - every object reachable from any ref (`git rev-list --all --objects`),
//   the bytes of every blob, the text of every commit and tag (headers and
//   message) and every entry name in every tree. So a key in any version
//   of any file, in a merge result, in a binary file or in a file name is
//   read, whatever `git log -p` would show.
// - every ref name.
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
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const NEWLINE = 10;

type Range = [number, number];

// The value of a MODEL_API_KEY assignment, and a bearer token. Read on the
// line's bytes as latin1, so string offsets are byte offsets.
const ASSIGNMENT = /(?<![A-Za-z0-9_])MODEL_API_KEY[ \t]*=[ \t]*["']?([^\s"'`$<>\\]{12,})/g;
// A redaction a log tool already made is not a key.
const PLACEHOLDER = /^redacted/i;
const BEARER = /(?<![A-Za-z0-9_])Bearer[ \t]+([A-Za-z0-9._~+/=|-]{24,})/g;
const MIXED = (v: string) => /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v);

// Every secret in bytes [start, end) of `b`, one line.
export function lineSecrets(b: Buffer, start = 0, end = b.length): Range[] {
  const line = b.toString("latin1", start, end);
  const out: Range[] = [];
  for (const re of [ASSIGNMENT, BEARER]) {
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
  }

  #finishLine(b: Buffer, start: number, nl: number): void {
    const end = nl > start && b[nl - 1] === 13 ? nl - 1 : nl;
    this.#check(b, start, end);
    this.#line++;
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
  return (line: number) => hit(where(line));
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
    for (const h of hits) console.log(`Possible model API key at ${h}`);
    if (hits.length > 0) {
      console.log(`Secret scan failed: ${hits.length} place${hits.length === 1 ? "" : "s"} to check. The matched text is not shown.`);
      console.log("For a blob, `git log --all --find-object=<id>` lists the commits that hold it.");
      process.exit(1);
    }
    console.log(`Secret scan passed: no model API key in ${files} tracked files, ${commits} commits or ${objects} reachable objects.`);
  } catch (err) {
    console.error(`Secret scan could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
