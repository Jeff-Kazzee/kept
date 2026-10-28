// Muse round 1, findings 3, 4, 5, 8 and 13's neighbors: undo order and
// serialization, keeping the last good read, the first device-zone send,
// and the error screen. No network: the backends are stubs.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api.ts";
import { LoadError } from "../components/LoadError.tsx";
import { errorSentence } from "../format.ts";
import { DEFAULT_SETTINGS, type ActivityEntry, type ActivityLog } from "../contract.ts";
import { keep, sendDeviceZone, settle } from "./reads.ts";
import { newestFirst, runUndo, serialUndo } from "./undo.ts";

const entry = (id: string, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({ id, at: "2026-11-05T09:00:00-07:00", actor: "agent", kind: "claim_accepted", summary: id, target: null, undoable: true, undone: false, ...extra });

function stubBackend(log: ActivityLog, refuse?: (id: string) => ApiError | null) {
  const calls: string[] = [];
  let version = log.activityVersion;
  let entries = log.entries;
  return {
    calls,
    activity: async () => {
      calls.push(`read@${version}`);
      return { activityVersion: version, entries };
    },
    undo: async (id: string, expectedVersion: number) => {
      calls.push(`undo ${id}@${expectedVersion}`);
      const r = refuse?.(id);
      if (r) throw r;
      version++;
      entries = entries.map((e) => (e.id === id ? { ...e, undone: true } : e));
      return {};
    },
  };
}

describe("undo", () => {
  it("finding 3: undoes newest first whatever order it was given, each with the version read after the last", async () => {
    // The activity lists the newest first: a3 is the newest.
    const backend = stubBackend({ activityVersion: 7, entries: [entry("a3"), entry("a2"), entry("a1")] });
    expect(newestFirst(["a1", "a2", "a3"], { activityVersion: 7, entries: [entry("a3"), entry("a2"), entry("a1")] })).toEqual(["a3", "a2", "a1"]);
    const out = await runUndo(backend, ["a1", "a2", "a3"]);
    expect(out.done).toEqual(["a3", "a2", "a1"]);
    expect(backend.calls).toEqual(["read@7", "undo a3@7", "read@8", "undo a2@8", "read@9", "undo a1@9", "read@10"]);
  });

  it("finding 4: reads the activity right before the first undo, and skips an entry already undone", async () => {
    const backend = stubBackend({ activityVersion: 12, entries: [entry("a2", { undone: true }), entry("a1")] });
    const out = await runUndo(backend, ["a2", "a1"]);
    expect(backend.calls[0]).toBe("read@12");
    expect(out.done).toEqual(["a1"]);
  });

  it("stops at a refusal and says which entry was refused", async () => {
    const blocked = new ApiError(409, { error: "undo_blocked", message: "A later change depends on this one." });
    const backend = stubBackend({ activityVersion: 3, entries: [entry("a2"), entry("a1")] }, (id) => (id === "a1" ? blocked : null));
    const out = await runUndo(backend, ["a1", "a2"]);
    expect(out.done).toEqual(["a2"]);
    expect(out.blocked?.id).toBe("a1");
  });

  it("sprint 11: a Google Calendar entry refused while Google is busy or blocked shows its plain reason beside it", async () => {
    const cal = (id: string) => entry(id, { kind: "calendar_event_added", target: { type: "slot", id: "2026-11-12T10:30" } });
    for (const refusal of [
      new ApiError(409, { error: "google_busy", message: "A Google Calendar change for Thursday 11/12 10:30 AM is still in progress. Try again in a moment." }),
      new ApiError(409, { error: "undo_blocked", message: "The calendar event changed at Google since the app wrote it, so the app left it as it is." }),
    ]) {
      const backend = stubBackend({ activityVersion: 4, entries: [cal("g1")] }, () => refusal);
      const out = await runUndo(backend, ["g1"]);
      expect(out.done).toEqual([]);
      expect(out.error).toBeNull();
      expect(out.blocked?.id).toBe("g1");
      expect(errorSentence(out.blocked!.error)).toBe(refusal.body.message);
    }
  });

  it("finding 4: runs one undo at a time and refuses a second while the first runs", async () => {
    const serial = serialUndo();
    let release!: () => void;
    const first = serial(() => new Promise<string>((r) => (release = () => r("first"))));
    const second = await serial(async () => "second");
    expect(second).toBeNull();
    release();
    expect(await first).toBe("first");
    expect(await serial(async () => "third")).toBe("third");
  });
});

describe("reads", () => {
  it("finding 5: a failed read keeps the last good value, and a missing route reads as null", async () => {
    const last = { ...DEFAULT_SETTINGS, timezone: "Europe/Berlin" };
    const failed = await settle(async () => {
      throw new ApiError(500, { error: "server_error" });
    });
    expect(failed).toEqual({ ok: false });
    expect(keep(failed, last)?.timezone).toBe("Europe/Berlin");
    const missing = await settle(async () => null);
    expect(keep(missing, last)).toBeNull();
  });

  it("finding 8: the first device-zone send is done when sent or refused for a version, and tried again after any other failure", async () => {
    const s = { ...DEFAULT_SETTINGS, settingsVersion: 2 };
    expect(await sendDeviceZone({ setTimezone: async () => ({}) }, s, "UTC")).toBe("sent");
    expect(await sendDeviceZone({ setTimezone: async () => Promise.reject(new ApiError(409, { error: "stale_edit" })) }, s, "UTC")).toBe("conflict");
    expect(await sendDeviceZone({ setTimezone: async () => Promise.reject(new TypeError("Failed to fetch")) }, s, "UTC")).toBe("failed");
  });

  it("findings 1 and 2: a refused read, such as an unexpected 401, shows the reason and a working Try again", () => {
    const html = renderToStaticMarkup(createElement(LoadError, { message: "Pair this browser with the app first. Nothing was saved.", onRetry: () => {} }));
    expect(html).toContain('<p role="alert">Pair this browser with the app first. Nothing was saved.</p>');
    expect(html).toContain('<button type="button" class="btn btn-primary">Try again</button>');
    expect(html).not.toContain("disabled");
  });
});
