// The app's provider settings and secrets (0010, design item 2): the
// chosen provider, the user's Meta key, the model choices and the ChatGPT
// connection. Their own SQLite file beside the event log, outside it, so
// Delete case leaves them alone (0010 P31).
//
// - Mode 600, owned by the user that runs the app. A file with wider
//   permissions is narrowed to 600 when opened, and SQLite gives its WAL
//   and shared-memory files the same mode. A symbolic link in place of the
//   file is refused, checked before and after the open.
// - Every write is one BEGIN IMMEDIATE transaction that reads the row,
//   applies the change and writes it, so a check on the settings version
//   or the session id and the write that depends on it are one
//   compare-and-swap, within this process and across processes such as
//   the app and `pnpm eval:live`. WAL and a busy timeout let readers and
//   writers wait briefly instead of failing.
// - The steps that call OpenAI between their read and their write (a token
//   refresh, a sign-out) hold a lease row instead of a lock: a process
//   claims it for LEASE_MS, renews it every LEASE_RENEW_MS while it works,
//   and releases it after. A lease past its expiry, whose holder stopped,
//   can be claimed by another process. A write that needs the lease checks,
//   in its own transaction, that the lease is still held.
//
// - Other parts of the app keep their own rows in the `rows` table, such as
//   the Google connection (`google`, 0012). Each row is JSON text its owner
//   checks. The same file, mode, link checks and transactions apply.
//
// Nothing here logs, and no error message holds a value from the file.
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { appDbPath } from "../../paths.ts";

export const SECRETS_FILE_NAME = "app-secrets.sqlite";

// The secrets file sits in the event log's folder: data/ by default.
export function appSecretsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(appDbPath(env)), SECRETS_FILE_NAME);
}

export const ProviderKind = z.enum(["meta", "chatgpt"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

const ChatGptSession = z
  .object({
    // Made at sign-in and kept through refreshes. A refresh stores its
    // result only while the same session is still stored. A session saved
    // without one is read as it is and given one on the next write.
    id: z.string().min(1).optional(),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).nullable(),
    // Unix milliseconds.
    expiresAt: z.number().int(),
    earliestRefreshAt: z.number().int().nullable(),
    scopes: z.array(z.string()),
    savedAt: z.string(),
  })
  .strict();
export type ChatGptSession = z.infer<typeof ChatGptSession>;

const ChatGptAccount = z
  .object({ issuer: z.string(), subject: z.string().min(1), email: z.string().nullable(), name: z.string().nullable() })
  .strict();
export type ChatGptAccount = z.infer<typeof ChatGptAccount>;

const ChatGptModel = z.object({ slug: z.string().min(1).max(200), displayName: z.string().min(1).max(200) }).strict();
export type ChatGptModel = z.infer<typeof ChatGptModel>;

const ChatGptRecord = z
  .object({
    // The host's ext_agent_host_id, made once, kept through sign-out.
    hostId: z.string().nullable(),
    // The issued client id from the first registration, kept through
    // sign-out so a later sign-in reuses it.
    clientId: z.string().nullable(),
    account: ChatGptAccount.nullable(),
    session: ChatGptSession.nullable(),
    models: z.array(ChatGptModel),
    // The user's model choice. Null uses the code default (see models.ts).
    model: z.string().nullable(),
  })
  .strict();
export type ChatGptRecord = z.infer<typeof ChatGptRecord>;

const ModelProblem = z
  .object({ provider: ProviderKind, model: z.string(), capability: z.enum(["tool_calling", "structured_output", "streaming", "other"]) })
  .strict();
export type ModelProblem = z.infer<typeof ModelProblem>;

const StoredSettings = z
  .object({
    format: z.literal(1),
    // Counts every change the settings page can see. Token refreshes do
    // not count.
    version: z.number().int().nonnegative(),
    provider: ProviderKind.nullable(),
    meta: z.object({ key: z.string().min(1) }).strict().nullable(),
    // The user's Meta model choice. Null uses the default (models.ts).
    metaModel: z.string().nullable().default(null),
    chatgpt: ChatGptRecord,
    // The last model that failed a capability the app needs, shown in
    // settings until the user picks another model or provider.
    modelProblem: ModelProblem.nullable().default(null),
  })
  .strict();
export type StoredSettings = z.infer<typeof StoredSettings>;

export const EMPTY_SETTINGS: StoredSettings = {
  format: 1,
  version: 0,
  provider: null,
  meta: null,
  metaModel: null,
  chatgpt: { hostId: null, clientId: null, account: null, session: null, models: [], model: null },
  modelProblem: null,
};

export class SecretsFileError extends Error {
  override name = "SecretsFileError";
}

// Another process kept the settings busy past the wait. Nothing was
// written. Trying again later is safe.
export class SecretsBusyError extends Error {
  override name = "SecretsBusyError";
  constructor() {
    super("The app's settings file stayed busy in another process.");
  }
}

// How long a lease lasts without renewal, how often its holder renews it,
// and how long a step waits for another holder's lease.
export const LEASE_MS = 30_000;
export const LEASE_RENEW_MS = 10_000;
export const LEASE_WAIT_MS = 75_000;
// How long a transaction waits for another process's write.
export const BUSY_TIMEOUT_MS = 5_000;

export type Lease = { readonly name: string; readonly holder: string };

// What a change can ask inside its transaction.
export type Transaction = { holds(lease: Lease): boolean };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  data TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS lease (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS rows (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL
) STRICT;`;

// The names of the rows other parts of the app keep here. The shared demo
// connection's file (0021, src/google/demo.ts) also keeps its waiting
// connect flow and its calendar cleanups.
export const SECRET_ROWS = ["google", "google_demo_flow", "google_demo_cleanup"] as const;
export type SecretRow = (typeof SECRET_ROWS)[number];

const isBusy = (err: unknown) => {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === 5;
};

// A session with no id gets one, so a refresh can tell it apart.
function withSessionId(settings: StoredSettings): StoredSettings {
  const session = settings.chatgpt.session;
  if (!session || session.id) return settings;
  return { ...settings, chatgpt: { ...settings.chatgpt, session: { ...session, id: randomUUID() } } };
}

export class SecretsStore {
  readonly file: string;
  readonly #now: () => number;
  #db: DatabaseSync | null = null;

  constructor(file: string, options: { now?: () => number } = {}) {
    this.file = file;
    this.#now = options.now ?? Date.now;
  }

  // Checks the path, then opens the database. A missing file is made
  // empty with mode 600 first, so SQLite never makes it with a wider one.
  #open(): DatabaseSync {
    if (this.#db) return this.#db;
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#checkPath(true);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.file, { timeout: BUSY_TIMEOUT_MS });
    } catch (err) {
      throw new SecretsFileError(`The app's settings file could not be opened (${(err as { code?: string }).code ?? "unknown"}): ${this.file}`);
    }
    try {
      // The link check again, after the open, for a swap in between.
      this.#checkPath(false);
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
      db.exec(SCHEMA);
    } catch (err) {
      db.close();
      if (err instanceof SecretsFileError) throw err;
      if (isBusy(err)) throw new SecretsBusyError();
      throw new SecretsFileError(`The app's settings file is not a settings database: ${this.file}`);
    }
    this.#db = db;
    return db;
  }

  #checkPath(create: boolean): void {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw new SecretsFileError(`The app's settings file could not be checked: ${this.file}`);
      try {
        closeSync(openSync(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new SecretsFileError(`The app's settings file could not be made: ${this.file}`);
      }
      return this.#checkPath(false);
    }
    if (st.isSymbolicLink()) throw new SecretsFileError(`The app's settings file is a symbolic link. Remove it: ${this.file}`);
    if (!st.isFile()) throw new SecretsFileError(`The app's settings file is not a regular file: ${this.file}`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new SecretsFileError(`The app's settings file belongs to another user: ${this.file}`);
    }
    if ((st.mode & 0o077) !== 0) chmodSync(this.file, 0o600);
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  #parse(row: { data: string } | undefined): StoredSettings {
    if (!row) return structuredClone(EMPTY_SETTINGS);
    let json: unknown;
    try {
      json = JSON.parse(row.data);
    } catch {
      throw new SecretsFileError(`The app's settings file holds settings that are not valid JSON: ${this.file}`);
    }
    const parsed = StoredSettings.safeParse(json);
    // The issue paths only, never the values.
    if (!parsed.success) throw new SecretsFileError(`The app's settings file has an unexpected shape at ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}.`);
    return parsed.data;
  }

  read(): StoredSettings {
    const db = this.#open();
    try {
      return this.#parse(db.prepare("SELECT data FROM settings WHERE id = 1").get() as { data: string } | undefined);
    } catch (err) {
      if (isBusy(err)) throw new SecretsBusyError();
      throw err;
    }
  }

  // One transaction: reads the settings, applies `change` and writes the
  // result. `bump` adds one to the settings version, for a change the
  // settings page can see. A change that returns null writes nothing, and
  // the current settings are returned.
  update(change: (current: StoredSettings, tx: Transaction) => StoredSettings | null, options: { bump: boolean }): StoredSettings {
    return this.#transaction((db) => {
      const current = this.#parse(db.prepare("SELECT data FROM settings WHERE id = 1").get() as { data: string } | undefined);
      const tx: Transaction = { holds: (lease) => this.#holds(db, lease) };
      const next = change(current, tx);
      if (next === null) return current;
      const written = withSessionId(StoredSettings.parse(options.bump ? { ...next, version: next.version + 1 } : next));
      db.prepare("INSERT INTO settings (id, version, data) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version, data = excluded.data").run(
        written.version,
        JSON.stringify(written),
      );
      return written;
    });
  }

  // A named row's text, or null when it was never written.
  readRow(name: SecretRow): string | null {
    const db = this.#open();
    try {
      const row = db.prepare("SELECT data FROM rows WHERE name = ?").get(name) as { data: string } | undefined;
      return row?.data ?? null;
    } catch (err) {
      if (isBusy(err)) throw new SecretsBusyError();
      throw err;
    }
  }

  // One BEGIN IMMEDIATE transaction: reads the row, applies `change` and
  // writes the result. A change that returns null writes nothing. Returns
  // the row's text after the transaction.
  updateRow(name: SecretRow, change: (current: string | null) => string | null): string | null {
    return this.#transaction((db) => {
      const row = db.prepare("SELECT data FROM rows WHERE name = ?").get(name) as { data: string } | undefined;
      const current = row?.data ?? null;
      const next = change(current);
      if (next === null) return current;
      db.prepare("INSERT INTO rows (name, data) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data").run(name, next);
      return next;
    });
  }

  #transaction<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.#open();
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      if (isBusy(err)) throw new SecretsBusyError();
      throw err;
    }
    try {
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      if (isBusy(err)) throw new SecretsBusyError();
      throw err;
    }
  }

  #holds(db: DatabaseSync, lease: Lease): boolean {
    const row = db.prepare("SELECT holder, expires_at FROM lease WHERE name = ?").get(lease.name) as { holder: string; expires_at: number } | undefined;
    return row !== undefined && row.holder === lease.holder && row.expires_at > this.#now();
  }

  // Claims the lease if it is free, expired or already this holder's.
  #claim(lease: Lease): boolean {
    return this.#transaction((db) => {
      const row = db.prepare("SELECT holder, expires_at FROM lease WHERE name = ?").get(lease.name) as { holder: string; expires_at: number } | undefined;
      const now = this.#now();
      if (row && row.holder !== lease.holder && row.expires_at > now) return false;
      db.prepare("INSERT INTO lease (name, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at").run(
        lease.name,
        lease.holder,
        now + LEASE_MS,
      );
      return true;
    });
  }

  #renew(lease: Lease): void {
    try {
      this.#transaction((db) => db.prepare("UPDATE lease SET expires_at = ? WHERE name = ? AND holder = ?").run(this.#now() + LEASE_MS, lease.name, lease.holder));
    } catch {
      // The next renewal or the write's own lease check covers a miss.
    }
  }

  #release(lease: Lease): void {
    try {
      this.#transaction((db) => db.prepare("DELETE FROM lease WHERE name = ? AND holder = ?").run(lease.name, lease.holder));
    } catch {
      // It expires on its own.
    }
  }

  // Runs `fn` holding the named lease, renewed while it runs. While another
  // holder has a live lease, `skip` is asked after each wait: a value it
  // returns is used instead of claiming the lease, as when the other
  // holder already did the work.
  async withLease<T>(name: string, fn: (lease: Lease) => Promise<T>, options: { skip?: () => T | undefined } = {}): Promise<T> {
    const lease: Lease = { name, holder: `${process.pid}:${randomUUID()}` };
    const started = Date.now();
    while (!this.#claim(lease)) {
      const skipped = options.skip?.();
      if (skipped !== undefined) return skipped;
      if (Date.now() - started > LEASE_WAIT_MS) throw new SecretsBusyError();
      await delay(25);
    }
    const timer = setInterval(() => this.#renew(lease), LEASE_RENEW_MS);
    timer.unref();
    try {
      return await fn(lease);
    } finally {
      clearInterval(timer);
      this.#release(lease);
    }
  }
}
