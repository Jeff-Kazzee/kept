// Secret scan for grant tokens (G-c). Scans every tracked file as it is on
// disk, and every commit message and diff line in `git log --all -p`, which
// includes every branch and every other ref, such as session checkpoints.
//
// Two patterns:
// - a grant token: `appt_` and 43 base64url characters, at the end of a
//   run of base64url characters.
// - any other run of exactly 43 base64url characters with an upper-case
//   letter, a lower-case letter and a digit. That is the shape of a token
//   without its prefix, as tokens were made before sprint 6. A run next to
//   + or /, or followed by = padding, is part of standard base64, such as a
//   lockfile hash, and is skipped. So is a run that starts with `mcp__`, an MCP tool name.
//
// It prints only where a hit is, never the text that matched. Exit code 0
// means no hit, 1 means at least one hit, 2 means the scan could not run.
// The history is read as bytes in one pass, because session checkpoints
// make it hundreds of megabytes.
//
//   pnpm scan:secrets [--repo <dir>]
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const NEWLINE = 10;
const PREFIX = Buffer.from("appt_");
const MCP = Buffer.from("mcp__");

const isRunByte = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
// Standard base64 uses + and /, and ends with = padding. A = before a run
// is an assignment, as in KEY=value, so it does not count.
const isEdgeBefore = (c: number | undefined) => c === 43 || c === 47;
const isEdgeAfter = (c: number | undefined) => c === 43 || c === 47 || c === 61;
const startsWith = (b: Uint8Array, at: number, prefix: Uint8Array) => prefix.every((p, i) => b[at + i] === p);

function runIsSecret(b: Uint8Array, start: number, end: number, lineStart: number, lineEnd: number): boolean {
  const length = end - start;
  if (length >= 48 && startsWith(b, end - 48, PREFIX)) return true;
  if (length !== 43) return false;
  if ((start > lineStart && isEdgeBefore(b[start - 1])) || (end < lineEnd && isEdgeAfter(b[end]))) return false;
  if (startsWith(b, start, MCP)) return false;
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

// True when bytes [start, end) of `b`, one line, hold a possible token.
export function lineHasSecret(b: Uint8Array, start = 0, end = b.length): boolean {
  if (end - start < 43) return false;
  let run = -1;
  for (let i = start; i < end; i++) {
    if (isRunByte(b[i]!)) {
      if (run < 0) run = i;
    } else if (run >= 0) {
      if (i - run >= 43 && runIsSecret(b, run, i, start, end)) return true;
      run = -1;
    }
  }
  return run >= 0 && end - run >= 43 && runIsSecret(b, run, end, start, end);
}

export const hasSecret = (line: string) => lineHasSecret(Buffer.from(line, "utf8"));

function git(repo: string, args: string[]): string {
  const run = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim()}`);
  return run.stdout;
}

// Calls `each` with the start and end of every line of `b`.
function forEachLine(b: Uint8Array, each: (start: number, end: number) => void): void {
  let start = 0;
  for (let i = b.indexOf(NEWLINE); i >= 0; i = b.indexOf(NEWLINE, start)) {
    each(start, i);
    start = i + 1;
  }
  if (start < b.length) each(start, b.length);
}

function scanTree(repo: string, hit: (where: string) => void): number {
  const root = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  const files = git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const file of files) {
    let data: Buffer;
    try {
      data = readFileSync(path.join(root, file));
    } catch {
      // Deleted in the working tree. Its history is still scanned.
      continue;
    }
    if (data.includes(0)) continue;
    let line = 0;
    forEachLine(data, (start, end) => {
      line++;
      if (lineHasSecret(data, start, end)) hit(`${file}:${line}`);
    });
  }
  return files.length;
}

// Tracks the commit, the file and the line number of each diff line, so a
// hit can be named without its text.
class HistoryReader {
  commits = 0;
  #commit = "";
  #file: string | null = null;
  #oldFile: string | null = null;
  #oldLine = 0;
  #newLine = 0;
  #inHunk = false;
  readonly #hit: (where: string) => void;

  constructor(hit: (where: string) => void) {
    this.#hit = hit;
  }

  line(b: Buffer, start: number, end: number): void {
    const first = b[start];
    if (this.#inHunk && this.#file !== null) {
      if (first === 43) {
        // An added line.
        if (lineHasSecret(b, start, end)) this.#hit(`commit ${this.#commit} ${this.#file}:${this.#newLine}`);
        this.#newLine++;
        return;
      }
      if (first === 45) {
        // A removed line.
        if (lineHasSecret(b, start, end)) this.#hit(`commit ${this.#commit} ${this.#oldFile ?? this.#file}:${this.#oldLine} (removed line)`);
        this.#oldLine++;
        return;
      }
      if (first === 32) {
        this.#oldLine++;
        this.#newLine++;
        return;
      }
      // "\ No newline at end of file"
      if (first === 92) return;
    }
    // Headers and commit message lines are read as text, at most 4 KB of
    // each for the header checks.
    const text = b.toString("utf8", start, Math.min(end, start + 4096));
    if (/^commit [0-9a-f]{40}$/.test(text)) {
      this.#commit = text.slice(7, 19);
      this.commits++;
      this.#file = this.#oldFile = null;
      this.#inHunk = false;
      return;
    }
    if (text.startsWith("diff --git ")) {
      this.#inHunk = false;
      this.#file = this.#oldFile = null;
      return;
    }
    if (text.startsWith("--- ")) {
      this.#oldFile = text === "--- /dev/null" ? null : text.replace(/^--- a\//, "");
      return;
    }
    if (text.startsWith("+++ ")) {
      this.#file = text === "+++ /dev/null" ? this.#oldFile : text.replace(/^\+\+\+ b\//, "");
      return;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      this.#oldLine = Number(hunk[1]);
      this.#newLine = Number(hunk[2]);
      this.#inHunk = true;
      return;
    }
    if (lineHasSecret(b, start, end)) this.#hit(`commit ${this.#commit} message or header`);
  }
}

async function scanHistory(repo: string, hit: (where: string) => void): Promise<number> {
  const child = spawn("git", ["-C", repo, "log", "--all", "-p", "--no-color", "--no-ext-diff", "--no-textconv", "--format=commit %H%n%B"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  const reader = new HistoryReader(hit);
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    const data = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    const last = data.lastIndexOf(NEWLINE);
    if (last < 0) {
      carry = data;
      continue;
    }
    forEachLine(data.subarray(0, last), (start, end) => reader.line(data, start, end));
    carry = Buffer.from(data.subarray(last + 1));
  }
  if (carry.length > 0) reader.line(carry, 0, carry.length);
  const code = await exited;
  if (code !== 0) throw new Error(`git log failed: ${stderr.trim()}`);
  return reader.commits;
}

export type ScanResult = { hits: string[]; files: number; commits: number };

export async function scanRepo(repo: string): Promise<ScanResult> {
  const hits: string[] = [];
  const seen = new Set<string>();
  const hit = (where: string) => {
    if (seen.has(where)) return;
    seen.add(where);
    hits.push(where);
  };
  const files = scanTree(repo, hit);
  const commits = await scanHistory(repo, hit);
  return { hits, files, commits };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { repo: { type: "string" } }, strict: true });
  const repo = path.resolve(values.repo ?? process.cwd());
  try {
    const { hits, files, commits } = await scanRepo(repo);
    for (const h of hits) console.log(`Possible grant token at ${h}`);
    if (hits.length > 0) {
      console.log(`Secret scan failed: ${hits.length} place${hits.length === 1 ? "" : "s"} to check. The matched text is not shown.`);
      process.exit(1);
    }
    console.log(`Secret scan passed: no grant token in ${files} tracked files or ${commits} commits.`);
  } catch (err) {
    console.error(`Secret scan could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
