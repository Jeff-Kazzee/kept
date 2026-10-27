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

export class EventStore {
  readonly #db: DatabaseSync;
  readonly #clock: () => string;

  // `location` is a file path or ":memory:".
  constructor(location: string = ":memory:", clock: () => string = () => new Date().toISOString()) {
    this.#db = new DatabaseSync(location);
    this.#clock = clock;
    // The app and the MCP server open the same file. WAL lets one read while
    // the other writes, and the busy timeout makes a writer wait for the
    // other's lock instead of failing at once.
    if (location !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
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

  // Writes to several streams in one transaction. Every stream must be at its
  // expected version, or nothing is written.
  appendMany(writes: StreamWrite[], describe: Describe = defaultDescribe): StoredEvent[] {
    const insert = this.#db.prepare(
      "INSERT INTO events (stream_id, version, type, data, recorded_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
    );
    this.#db.exec("BEGIN IMMEDIATE");
    try {
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
      this.#db.exec("COMMIT");
      return written;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  // Appends system events, such as access log entries, at the stream's next
  // version. No user or agent edits these streams, so the write states no
  // expected version. Every record write still uses append or appendMany.
  appendSystem(streamId: string, events: NewEvent[]): StoredEvent[] {
    const insert = this.#db.prepare(
      "INSERT INTO events (stream_id, version, type, data, recorded_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
    );
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.streamVersion(streamId);
      const at = this.#clock();
      const written = events.map((e, i) => toEvent(insert.get(streamId, current + i + 1, e.type, JSON.stringify(e.data), at) as unknown as Row));
      this.#db.exec("COMMIT");
      return written;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  // Exposed for tests that prove the triggers block edits.
  unsafeExecForTest(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#db.close();
  }
}
