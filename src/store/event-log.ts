// Append-only event log on node:sqlite. Each stream is one record with a
// version number. A write states the version it expects. If the stream has
// moved on, the write fails with StaleEditError and nothing is written.
// Triggers block UPDATE and DELETE on the events table.
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
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
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

export type RateWindow = { key: string; windowStart: number; calls: number; denied: number };

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

export class EventStore {
  readonly #db: DatabaseSync;
  readonly #clock: () => string;
  #depth = 0;
  readonly #retryMs: number[];
  #guard: (() => void) | null = null;

  // `location` is a file path or ":memory:".
  constructor(location: string = ":memory:", clock: () => string = () => new Date().toISOString(), options: StoreOptions = {}) {
    this.#db = new DatabaseSync(location);
    this.#clock = clock;
    // The app and the MCP server open the same file. WAL lets one read while
    // the other writes, and the busy timeout makes a writer wait for the
    // other's lock instead of failing at once.
    this.#retryMs = options.lockRetryMs ?? [100, 250, 500];
    if (location !== ":memory:") this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000};`);
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
    const savepoint = `sp${this.#depth}`;
    if (this.#depth === 0) this.#lock();
    else this.#db.exec(`SAVEPOINT ${savepoint}`);
    this.#depth++;
    try {
      if (this.#depth === 1 && this.#guard) this.#guard();
      const result = fn();
      if (result instanceof Promise) throw new Error("A transaction must be synchronous.");
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

  // Runs `fn` with a check that every write transaction it starts runs
  // first, inside the lock. The MCP server uses it to check the grant in the
  // same transaction as the agent's write, while the reads before the write
  // hold no lock.
  withWriteGuard<T>(guard: () => void, fn: () => T): T {
    const previous = this.#guard;
    this.#guard = guard;
    try {
      return fn();
    } finally {
      this.#guard = previous;
    }
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

  // Call counts in fixed time windows, for limits that every process on this
  // file shares. These rows are counters, not history, so they are updated
  // and removed. Use them inside transaction(), so a read and the update
  // that depends on it are one step.
  rateWindow(key: string, windowStart: number): RateWindow {
    const row = this.#db.prepare("SELECT calls, denied FROM rate_windows WHERE key = ? AND window_start = ?").get(key, windowStart) as
      | { calls: number; denied: number }
      | undefined;
    return { key, windowStart, calls: row?.calls ?? 0, denied: row?.denied ?? 0 };
  }

  bumpRateWindow(key: string, windowStart: number, field: "calls" | "denied"): RateWindow {
    this.#db
      .prepare(
        `INSERT INTO rate_windows (key, window_start, ${field}) VALUES (?, ?, 1)
         ON CONFLICT (key, window_start) DO UPDATE SET ${field} = ${field} + 1`,
      )
      .run(key, windowStart);
    return this.rateWindow(key, windowStart);
  }

  // Removes and returns the windows that started before `before`, for one
  // key or, with key null, for every key.
  closeRateWindows(key: string | null, before: number): RateWindow[] {
    const rows = (
      key === null
        ? this.#db.prepare("DELETE FROM rate_windows WHERE window_start < ? RETURNING *").all(before)
        : this.#db.prepare("DELETE FROM rate_windows WHERE key = ? AND window_start < ? RETURNING *").all(key, before)
    ) as Array<{ key: string; window_start: number; calls: number; denied: number }>;
    return rows
      .map((r) => ({ key: r.key, windowStart: r.window_start, calls: r.calls, denied: r.denied }))
      .sort((a, b) => a.key.localeCompare(b.key) || a.windowStart - b.windowStart);
  }

  // Exposed for tests that prove the triggers block edits.
  unsafeExecForTest(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#db.close();
  }
}
