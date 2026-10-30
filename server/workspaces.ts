// The open workspaces of hosted mode (0014, design item 2): one per
// account, built on demand under data/accounts/<account id>/, with a small
// cache that closes idle ones. A workspace is only ever reached through
// the account id of the request's session, and its folder is checked to
// sit inside the accounts folder, so no route reaches another account's
// files.
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ACCOUNT_ID } from "../src/hosted/store.ts";
import type { Workspace } from "./workspace.ts";

// Longer than a Google connect flow (10 minutes), whose state lives in the
// workspace's memory.
export const IDLE_MS = 30 * 60_000;
export const MAX_OPEN = 64;
// Review round 1, finding 5: a full cache never closes a workspace used in
// the last 10 minutes, or one with a Google connect still open. It grows
// past MAX_OPEN instead.
export const RECENT_MS = 10 * 60_000;
// Final review, finding 2: the cache never holds more than this many
// times its size. At the ceiling the least recently used workspace with no
// request running closes, even a recent one or one with a Google connect
// waiting, which the person can start again. When every one has a request
// running, a new workspace is refused.
export const CEILING_FACTOR = 4;

// Every workspace at the ceiling has a request running (final review,
// finding 2). The site answers 503, and trying again is safe.
export class WorkspacesFullError extends Error {
  override name = "WorkspacesFullError";
}
export class WorkspaceBusyError extends Error {
  override name = "WorkspaceBusyError";
}

// `deleting`: Delete account claimed it, and no request may use it.
type Entry = { ws: Workspace; lastUsed: number; inFlight: number; deleting: boolean };
type Build = (accountId: string, files: { dbPath: string; secretsPath: string }) => Workspace;

export class Workspaces {
  readonly #root: string;
  readonly #build: Build;
  readonly #now: () => number;
  readonly #idleMs: number;
  readonly #max: number;
  readonly #open = new Map<string, Entry>();

  constructor(options: { root: string; build: Build; now?: () => number; idleMs?: number; max?: number }) {
    this.#root = path.resolve(options.root);
    this.#build = options.build;
    this.#now = options.now ?? Date.now;
    this.#idleMs = options.idleMs ?? IDLE_MS;
    this.#max = options.max ?? MAX_OPEN;
  }

  // The folder of an account's workspace. Refuses an id that is not one
  // the accounts database makes, and any path outside the root.
  dir(accountId: string): string {
    if (!ACCOUNT_ID.test(accountId)) throw new Error("not an account id");
    const dir = path.resolve(this.#root, accountId);
    if (path.dirname(dir) !== this.#root) throw new Error("outside the accounts folder");
    return dir;
  }

  #entry(accountId: string): Entry {
    let e = this.#open.get(accountId);
    if (!e) {
      const dir = this.dir(accountId);
      mkdirSync(this.#root, { recursive: true, mode: 0o700 });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("the workspace folder is not a folder");
      this.#evict();
      this.#makeRoom();
      e = { ws: this.#build(accountId, { dbPath: path.join(dir, "app.sqlite"), secretsPath: path.join(dir, "app-secrets.sqlite") }), lastUsed: this.#now(), inFlight: 0, deleting: false };
      this.#open.set(accountId, e);
    }
    e.lastUsed = this.#now();
    return e;
  }

  // Runs `fn` with the account's workspace, which stays open while it runs.
  async use<T>(accountId: string, fn: (ws: Workspace) => Promise<T> | T): Promise<T> {
    const e = this.#entry(accountId);
    if (e.deleting) throw new WorkspaceBusyError("This account is being deleted.");
    e.inFlight++;
    try {
      return await fn(e.ws);
    } finally {
      e.inFlight--;
      e.lastUsed = this.#now();
    }
  }

  // Round 2, finding 9: a look at a workspace that is already open, for
  // the held live read. It does not open one, does not count as use (the
  // idle sweep still closes a workspace only a held read looks at) and
  // holds it only while `fn` runs. Null when the workspace is not open: a
  // closed workspace has no write of its own in flight, and any write
  // opens it first.
  async peek<T>(accountId: string, fn: (ws: Workspace) => Promise<T> | T): Promise<T | null> {
    const e = this.#open.get(accountId);
    if (!e || e.deleting) return null;
    e.inFlight++;
    try {
      return await fn(e.ws);
    } finally {
      e.inFlight--;
    }
  }

  // A workspace that may close: no request running, no Google connect
  // waiting, and not used in the last `withinMs`.
  #closable(e: Entry, withinMs: number): boolean {
    return e.inFlight === 0 && !e.deleting && e.lastUsed <= this.#now() - withinMs && !e.ws.pendingGoogleFlow();
  }

  // The least recently used closable workspace goes when the cache is full.
  #evict(): void {
    while (this.#open.size >= this.#max) {
      let oldest: [string, Entry] | null = null;
      for (const kv of this.#open) if (this.#closable(kv[1], RECENT_MS) && (!oldest || kv[1].lastUsed < oldest[1].lastUsed)) oldest = kv;
      if (!oldest) return;
      this.#close(oldest[0]);
    }
  }

  #makeRoom(): void {
    if (this.#open.size < this.#max * CEILING_FACTOR) return;
    let oldest: [string, Entry] | null = null;
    for (const kv of this.#open) if (kv[1].inFlight === 0 && !kv[1].deleting && (!oldest || kv[1].lastUsed < oldest[1].lastUsed)) oldest = kv;
    if (!oldest) throw new WorkspacesFullError("Every open workspace has a request running.");
    this.#close(oldest[0]);
  }

  #close(accountId: string): void {
    const e = this.#open.get(accountId);
    if (!e) return;
    this.#open.delete(accountId);
    try {
      e.ws.close();
    } catch {
      // Closed already.
    }
  }

  // Closes every workspace idle for longer than the idle time.
  sweep(): number {
    let closed = 0;
    for (const [id, e] of [...this.#open]) {
      if (this.#closable(e, this.#idleMs)) {
        this.#close(id);
        closed++;
      }
    }
    return closed;
  }

  isOpen(accountId: string): boolean {
    return this.#open.has(accountId);
  }

  get size(): number {
    return this.#open.size;
  }

  // Delete account, step one (review round 1, finding 3): refused while a
  // request of the account still runs, before anything changes. Once
  // claimed, no request may use the workspace. `remove` closes it and
  // removes its folder. `release` ends the claim, done or not.
  claim(accountId: string): { ws: Workspace; remove(): void; release(): void } {
    const e = this.#entry(accountId);
    if (e.inFlight > 0 || e.deleting) throw new WorkspaceBusyError("A request of this account is still running.");
    e.deleting = true;
    return {
      ws: e.ws,
      remove: () => {
        this.#close(accountId);
        rmSync(this.dir(accountId), { recursive: true, force: true });
      },
      release: () => {
        e.deleting = false;
      },
    };
  }

  closeAll(): void {
    for (const id of [...this.#open.keys()]) this.#close(id);
  }
}
