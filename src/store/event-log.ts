// Append-only event log on node:sqlite. Each stream is one record with a
// version number. A write states the version it expects. If the stream has
// moved on, the write fails with StaleEditError and nothing is written.
// Triggers block UPDATE and DELETE on the events table. eraseCase is the
// one exception, for Delete case only.
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";

export type NewEvent = { type: string; data: unknown };

export type StoredEvent = {
  seq: number;
  streamId: string;
  version: number;
  type: string;
  data: unknown;
  recordedAt: string;
};

export type StreamWrite = {
  streamId: string;
  expectedVersion: number;
  events: NewEvent[];
};

export type Describe = (streamId: string, events: StoredEvent[]) => unknown;

export class StaleEditError extends Error {
  override name = "StaleEditError";
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  // The current record, as described by the caller's projection.
  readonly current: unknown;

  constructor(streamId: string, expectedVersion: number, currentVersion: number, current: unknown) {
    super(`Stale edit on ${streamId}: expected version ${expectedVersion}, current version ${currentVersion}.`);
    this.streamId = streamId;
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
    this.current = current;
  }
}

// The guard against deleting events. eraseCase drops it and creates it
// again inside its own transaction, so no other connection ever sees the
// table without it.
const NO_DELETE_TRIGGER = `CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (stream_id, version)
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
${NO_DELETE_TRIGGER}
CREATE TABLE IF NOT EXISTS case_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
-- Rate-limit counters from before sprint 8, when every MCP process on the
-- file shared them. Nothing writes them now. Delete case still clears them.
CREATE TABLE IF NOT EXISTS rate_windows (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  denied INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
`;

type Row = { seq: number; stream_id: string; version: number; type: string; data: string; recorded_at: string };

const toEvent = (r: Row): StoredEvent => ({
  seq: r.seq,
  streamId: r.stream_id,
  version: r.version,
  type: r.type,
  data: JSON.parse(r.data),
  recordedAt: r.recorded_at,
});

const defaultDescribe: Describe = (_streamId, events) => ({ version: events.at(-1)?.version ?? 0, events });

// Another process held the write lock through the busy timeout and every
// retry. Nothing was written.
export class StoreBusyError extends Error {
  override name = "StoreBusyError";
  constructor() {
    super("The case is busy because another process is writing to it. Nothing was saved. Try again in a moment.");
  }
}

export const isBusy = (err: unknown) => (err as { errcode?: unknown } | null)?.errcode === 5;

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export type StoreOptions = {
  // How long SQLite waits for another process's write lock, in ms.
  busyTimeoutMs?: number;
  // Pauses before each retry once that wait runs out, in ms.
  lockRetryMs?: number[];
};

// Delete case removed the data, but another program kept the file busy, so
// the old text may still be in the file. Running Delete case again finishes
// the job.
export class CompactionError extends Error {
  override name = "CompactionError";
  constructor() {
    super(
      "The case was deleted, but another program is using the database file, so old text may remain in it until that program closes. " +
        "Close the MCP client or other programs that use it, then run Delete case again. The app also finishes it when it starts.",
    );
  }
}

// SQL that matches stream ids starting with any of the prefixes.
function prefixMatch(prefixes: readonly string[]): { sql: string; params: Array<string | number> } {
  if (prefixes.length === 0) return { sql: "0", params: [] };
  return {
    sql: prefixes.map(() => "substr(stream_id, 1, ?) = ?").join(" OR "),
    params: prefixes.flatMap((p) => [p.length, p]),
  };
}

// The case was deleted after this command read it. Nothing was written.
export class CaseDeletedError extends Error {
  override name = "CaseDeletedError";
  // A sentence that says more than the default, such as a Google Calendar
  // change that reached Google after the delete (0017, fix round 2, F2).
  readonly detail: string | null;
  constructor(detail: string | null = null) {
    super(detail ?? "The case was deleted while this was in progress. Nothing was saved.");
    this.detail = detail;
  }
}

export class EventStore {
  readonly #db: DatabaseSync;
  readonly #file: boolean;
  readonly #clock: () => string;
  #depth = 0;
  readonly #retryMs: number[];
  // The case generation the current command started from. See inCase.
  readonly #scope = new AsyncLocalStorage<number>();
  // Runs inside each outermost write transaction of a command, before it
  // commits. See withWriteHook.
  readonly #hooks = new AsyncLocalStorage<() => void>();

  // `location` is a file path or ":memory:".
  constructor(location: string = ":memory:", clock: () => string = () => new Date().toISOString(), options: StoreOptions = {}) {
    this.#db = new DatabaseSync(location);
    this.#clock = clock;
    // The app and the MCP server open the same file. WAL lets one read while
    // the other writes, and the busy timeout makes a writer wait for the
    // other's lock instead of failing at once.
    this.#retryMs = options.lockRetryMs ?? [100, 250, 500];
    this.#file = location !== ":memory:";
    if (this.#file) this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000};`);
    this.#db.exec(SCHEMA);
  }

  streamVersion(streamId: string): number {
    const row = this.#db.prepare("SELECT MAX(version) AS v FROM events WHERE stream_id = ?").get(streamId) as
      | { v: number | null }
      | undefined;
    return row?.v ?? 0;
  }

  readStream(streamId: string): StoredEvent[] {
    const rows = this.#db
      .prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY version")
      .all(streamId) as unknown as Row[];
    return rows.map(toEvent);
  }

  // Every event of every stream whose id starts with `prefix`, in seq order.
  readPrefix(prefix: string): StoredEvent[] {
    const rows = this.#db
      .prepare("SELECT * FROM events WHERE substr(stream_id, 1, ?) = ? ORDER BY seq")
      .all(prefix.length, prefix) as unknown as Row[];
    return rows.map(toEvent);
  }

  readAll(): StoredEvent[] {
    const rows = this.#db.prepare("SELECT * FROM events ORDER BY seq").all() as unknown as Row[];
    return rows.map(toEvent);
  }

  // Throws StaleEditError when the stream is not at the expected version.
  assertVersion(streamId: string, expectedVersion: number, describe: Describe = defaultDescribe): void {
    const current = this.streamVersion(streamId);
    if (current !== expectedVersion) {
      throw new StaleEditError(streamId, expectedVersion, current, describe(streamId, this.readStream(streamId)));
    }
  }

  append(streamId: string, expectedVersion: number, events: NewEvent[], describe?: Describe): StoredEvent[] {
    return this.appendMany([{ streamId, expectedVersion, events }], describe);
  }

  // Runs `fn` as one unit of work. The outermost call takes the write lock
  // at once (BEGIN IMMEDIATE), so a check and the writes that depend on it
  // see the same state, and another process waits until it commits. A
  // nested call is a savepoint: its failure undoes only its own writes.
  // `fn` must be synchronous.
  transaction<T>(fn: () => T): T {
    return this.#write(fn);
  }

  // The body of transaction. Called directly only for the store's own
  // bookkeeping outside any case command, such as clearing the erase mark.
  #write<T>(fn: () => T): T {
    const savepoint = `sp${this.#depth}`;
    if (this.#depth === 0) this.#lock();
    else this.#db.exec(`SAVEPOINT ${savepoint}`);
    this.#depth++;
    try {
      if (this.#depth === 1) this.#assertGeneration();
      const result = fn();
      if (result instanceof Promise) throw new Error("A transaction must be synchronous.");
      if (this.#depth === 1) {
        const hook = this.#hooks.getStore();
        // The hook's own writes run without it.
        if (hook) this.#hooks.exit(hook);
      }
      this.#depth--;
      this.#db.exec(this.#depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.#depth--;
      this.#db.exec(this.#depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    }
  }

  // Takes the write lock. When the busy timeout runs out, retries after
  // each pause in lockRetryMs, then gives up with StoreBusyError.
  #lock(): void {
    for (let attempt = 0; ; attempt++) {
      try {
        this.#db.exec("BEGIN IMMEDIATE");
        return;
      } catch (err) {
        if (!isBusy(err)) throw err;
        const pause = this.#retryMs[attempt];
        if (pause === undefined) throw new StoreBusyError();
        sleepSync(pause);
      }
    }
  }

  // Runs `fn` so that each outermost write transaction it starts, before
  // and after any await, runs `hook` just before it commits, inside the
  // lock. The activity log uses it to write an entry in the same
  // transaction as the action it describes, for commands that wait for a
  // model before they write.
  withWriteHook<T>(hook: () => void, fn: () => T): T {
    return this.#hooks.run(hook, fn);
  }

  // Writes to several streams in one transaction. Every stream must be at its
  // expected version, or nothing is written.
  appendMany(writes: StreamWrite[], describe: Describe = defaultDescribe): StoredEvent[] {
    const insert = this.#db.prepare(
      "INSERT INTO events (stream_id, version, type, data, recorded_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
    );
    return this.transaction(() => {
      const written: StoredEvent[] = [];
      const seen = new Set<string>();
      for (const w of writes) {
        if (seen.has(w.streamId)) throw new Error(`Stream ${w.streamId} appears twice in one write.`);
        seen.add(w.streamId);
        this.assertVersion(w.streamId, w.expectedVersion, describe);
        const current = w.expectedVersion;
        const at = this.#clock();
        w.events.forEach((e, i) => {
          const row = insert.get(w.streamId, current + i + 1, e.type, JSON.stringify(e.data), at) as unknown as Row;
          written.push(toEvent(row));
        });
      }
      return written;
    });
  }

  // Appends system events, such as access log entries, at the stream's next
  // version. No user or agent edits these streams, so the write states no
  // expected version. Every record write still uses append or appendMany.
  appendSystem(streamId: string, events: NewEvent[]): StoredEvent[] {
    const insert = this.#db.prepare(
      "INSERT INTO events (stream_id, version, type, data, recorded_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
    );
    return this.transaction(() => {
      const current = this.streamVersion(streamId);
      const at = this.#clock();
      return events.map((e, i) => toEvent(insert.get(streamId, current + i + 1, e.type, JSON.stringify(e.data), at) as unknown as Row));
    });
  }

  // The highest seq among events whose stream does not start with one of the
  // prefixes, or 0 when there are none.
  latestSeqExcept(prefixes: readonly string[]): number {
    const skip = prefixMatch(prefixes);
    const row = this.#db.prepare(`SELECT MAX(seq) AS s FROM events WHERE NOT (${skip.sql})`).get(...skip.params) as
      | { s: number | null }
      | undefined;
    return row?.s ?? 0;
  }

  // The case generation. Delete case increments it. It lives in case_meta,
  // outside the events table, so it survives the delete.
  caseGeneration(): number {
    return this.#meta("generation");
  }

  // True when a Delete case committed and the file was not compacted yet.
  // The mark holds the generation whose erase is pending, so finishing one
  // erase cannot clear the mark of a later one.
  erasePending(): boolean {
    return this.#pendingGeneration() !== null;
  }

  #pendingGeneration(): number | null {
    const row = this.#db.prepare("SELECT value FROM case_meta WHERE key = 'erase_pending'").get() as { value: number } | undefined;
    return row?.value ?? null;
  }

  #meta(key: string): number {
    const row = this.#db.prepare("SELECT value FROM case_meta WHERE key = ?").get(key) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  // True inside a command started with inCase. A test uses it to prove that
  // every service write runs as one.
  inCaseScope(): boolean {
    return this.#scope.getStore() !== undefined;
  }

  // Runs `fn` as one command on the case. Every write transaction it starts,
  // before and after any await, first checks inside the lock that the case
  // generation is still `generation` (by default the current one). So a
  // command that read the case, or waited for a model, before a Delete case
  // cannot write into the empty case afterwards. An enclosing command's
  // generation wins, because it was read first.
  inCase<T>(fn: () => T, generation?: number): T {
    if (this.#scope.getStore() !== undefined) return fn();
    return this.#scope.run(generation ?? this.caseGeneration(), fn);
  }

  #assertGeneration(): void {
    const expected = this.#scope.getStore();
    if (expected !== undefined && expected !== this.caseGeneration()) throw new CaseDeletedError();
  }

  // Delete case. The one path that removes events. In one transaction it
  // runs `check`, lifts the delete guard, removes every event whose stream
  // does not start with one of `keepPrefixes`, puts the guard back, clears
  // any old rate-limit counter, moves the case to a new generation and marks
  // the erase as pending. Then it rewrites the file (finishPendingErase), so
  // the removed text is gone from disk and not only from queries. Returns
  // the number of events removed. Running it again on an empty case only
  // compacts.
  eraseCase(keepPrefixes: readonly string[], check: () => void): number {
    if (this.#depth > 0) throw new Error("Delete case cannot run inside another transaction.");
    const keep = prefixMatch(keepPrefixes);
    // Freed space is zeroed, so even the pages this transaction writes to
    // the WAL hold none of the removed text.
    this.#db.exec("PRAGMA secure_delete = ON");
    const erased = this.transaction(() => {
      check();
      this.#db.exec("DROP TRIGGER events_no_delete");
      const { changes } = this.#db.prepare(`DELETE FROM events WHERE NOT (${keep.sql})`).run(...keep.params);
      this.#db.exec(NO_DELETE_TRIGGER);
      this.#db.exec("DELETE FROM rate_windows");
      this.#db.prepare("INSERT INTO case_meta (key, value) VALUES ('generation', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1").run();
      this.#db
        .prepare(
          "INSERT INTO case_meta (key, value) VALUES ('erase_pending', (SELECT value FROM case_meta WHERE key = 'generation')) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run();
      return Number(changes);
    });
    this.finishPendingErase();
    return erased;
  }

  // Finishes a Delete case whose compaction did not run, for example because
  // the process stopped after the delete committed. The app and the MCP
  // server call it at start, before they serve. A TRUNCATE checkpoint, VACUUM
  // and a second TRUNCATE checkpoint leave the database file without the
  // removed text and the WAL empty. Only then is the pending mark cleared,
  // so a crash at any point leaves it set. The mark is cleared in a write
  // transaction and only if it still names the generation read before the
  // compaction. If another process deleted the next case meanwhile, its
  // mark stays for its own compaction or the next start. Returns true when
  // it compacted.
  finishPendingErase(): boolean {
    const pending = this.#pendingGeneration();
    if (pending === null) return false;
    this.#db.exec("PRAGMA temp_store = MEMORY");
    try {
      if (this.#file) this.#checkpoint();
      this.#db.exec("VACUUM");
      if (this.#file) this.#checkpoint();
      this.beforeClearPending();
      // Outside any case command, because the generation already moved.
      this.#scope.exit(() =>
        this.#write(() => this.#db.prepare("DELETE FROM case_meta WHERE key = 'erase_pending' AND value = ?").run(pending)),
      );
    } catch (err) {
      if (isBusy(err) || err instanceof StoreBusyError) throw new CompactionError();
      throw err;
    }
    return true;
  }

  // A seam for a test that pauses one process between its compaction and
  // clearing the mark. It does nothing here.
  protected beforeClearPending(): void {}

  #checkpoint(): void {
    const row = this.#db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined;
    if (row && row.busy !== 0) throw new CompactionError();
  }

  // Exposed for tests that prove the triggers block edits.
  unsafeExecForTest(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#db.close();
  }
}
