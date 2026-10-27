import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore, StaleEditError } from "../src/store/event-log.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("event log", () => {
  it("numbers each stream's events from version 1", () => {
    const store = new EventStore();
    const written = store.append("a", 0, [
      { type: "x", data: { n: 1 } },
      { type: "y", data: { n: 2 } },
    ]);
    expect(written.map((e) => e.version)).toEqual([1, 2]);
    expect(store.append("a", 2, [{ type: "z", data: {} }])[0]!.version).toBe(3);
    expect(store.append("b", 0, [{ type: "x", data: {} }])[0]!.version).toBe(1);
    expect(store.readStream("a").map((e) => e.type)).toEqual(["x", "y", "z"]);
    expect(store.readAll().map((e) => e.streamId)).toEqual(["a", "a", "a", "b"]);
  });

  it("returns a stale-edit error with the current record and writes nothing", () => {
    const store = new EventStore();
    store.append("a", 0, [{ type: "x", data: { n: 1 } }]);
    const err = (() => {
      try {
        store.append("a", 0, [{ type: "y", data: {} }], (_id, events) => ({ described: events.length }));
      } catch (e) {
        return e;
      }
    })() as StaleEditError;
    expect(err).toBeInstanceOf(StaleEditError);
    expect(err.expectedVersion).toBe(0);
    expect(err.currentVersion).toBe(1);
    expect(err.current).toEqual({ described: 1 });
    expect(store.readAll()).toHaveLength(1);
  });

  it("writes several streams all or nothing", () => {
    const store = new EventStore();
    store.append("b", 0, [{ type: "x", data: {} }]);
    expect(() =>
      store.appendMany([
        { streamId: "a", expectedVersion: 0, events: [{ type: "x", data: {} }] },
        { streamId: "b", expectedVersion: 0, events: [{ type: "x", data: {} }] },
      ]),
    ).toThrow(StaleEditError);
    expect(store.readStream("a")).toEqual([]);
    expect(store.readAll()).toHaveLength(1);
  });

  it("blocks UPDATE and DELETE of event rows", () => {
    const store = new EventStore();
    store.append("a", 0, [{ type: "x", data: {} }]);
    expect(() => store.unsafeExecForTest("UPDATE events SET type = 'changed'")).toThrow(/append-only/);
    expect(() => store.unsafeExecForTest("DELETE FROM events")).toThrow(/append-only/);
    expect(store.readStream("a")[0]!.type).toBe("x");
  });

  it("keeps events in a file database across reopen", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "d1-store-"));
    dirs.push(dir);
    const file = path.join(dir, "events.sqlite");
    const first = new EventStore(file);
    first.append("a", 0, [{ type: "x", data: { kept: true } }]);
    first.close();
    const second = new EventStore(file);
    expect(second.readStream("a")).toMatchObject([{ version: 1, type: "x", data: { kept: true } }]);
    second.close();
  });
});
