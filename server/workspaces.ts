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

export class WorkspaceBusyError extends Error {
  override name = "WorkspaceBusyError";
}

type Entry = { ws: Workspace; lastUsed: number; inFlight: number };
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
      e = { ws: this.#build(accountId, { dbPath: path.join(dir, "app.sqlite"), secretsPath: path.join(dir, "app-secrets.sqlite") }), lastUsed: this.#now(), inFlight: 0 };
      this.#open.set(accountId, e);
    }
    e.lastUsed = this.#now();
    return e;
  }

  // Runs `fn` with the account's workspace, which stays open while it runs.
  async use<T>(accountId: string, fn: (ws: Workspace) => Promise<T> | T): Promise<T> {
    const e = this.#entry(accountId);
    e.inFlight++;
    try {
      return await fn(e.ws);
    } finally {
      e.inFlight--;
      e.lastUsed = this.#now();
    }
  }

  // The least recently used idle workspace goes when the cache is full.
  #evict(): void {
    while (this.#open.size >= this.#max) {
      let oldest: [string, Entry] | null = null;
      for (const kv of this.#open) if (kv[1].inFlight === 0 && (!oldest || kv[1].lastUsed < oldest[1].lastUsed)) oldest = kv;
      if (!oldest) return;
      this.#close(oldest[0]);
    }
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
    const cutoff = this.#now() - this.#idleMs;
    let closed = 0;
    for (const [id, e] of [...this.#open]) {
      if (e.inFlight === 0 && e.lastUsed <= cutoff) {
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

  // Delete account: closes the workspace and removes its folder. Refused
  // while a request of the account still runs.
  remove(accountId: string): void {
    const e = this.#open.get(accountId);
    if (e && e.inFlight > 0) throw new WorkspaceBusyError("A request of this account is still running.");
    this.#close(accountId);
    rmSync(this.dir(accountId), { recursive: true, force: true });
  }

  closeAll(): void {
    for (const id of [...this.#open.keys()]) this.#close(id);
  }
}
