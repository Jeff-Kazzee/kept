// 0019, P20: the poll backs off when nothing changes, asks at the base wait
// while busy or right after a change, and asks nothing while the tab is
// hidden.
import { describe, expect, it } from "vitest";
import type { LiveVersion } from "./api.ts";
import { IDLE_MAX_MS, POLL_MS, createPoller, nextDelay } from "./useLiveRefresh.ts";

function harness(start: LiveVersion = { generation: 1, seq: 1 }) {
  let server = start;
  let seen: LiveVersion | null = start;
  let hidden = false;
  let busy = false;
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const reads: number[] = [];
  const refreshes: LiveVersion[] = [];
  const poller = createPoller(
    {
      current: () => seen,
      busy: () => busy,
      refresh: async () => {
        refreshes.push(server);
        seen = server;
      },
    },
    {
      read: async () => {
        reads.push(Date.now());
        return server;
      },
      setTimer: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        (t as { live: boolean }).live = false;
      },
      hidden: () => hidden,
    },
  );
  // Runs the next live timer and waits for its check.
  const tick = async () => {
    const t = timers.find((x) => x.live);
    if (!t) return null;
    t.live = false;
    t.fn();
    await new Promise((r) => setTimeout(r, 0));
    return t.ms;
  };
  const waits = () => timers.filter((x) => x.live).map((x) => x.ms);
  return {
    poller,
    tick,
    waits,
    reads,
    refreshes,
    change: () => (server = { ...server, seq: server.seq + 1 }),
    hide: (h: boolean) => (hidden = h),
    busy: (b: boolean) => (busy = b),
  };
}

describe("0019, P20: polling back-off", () => {
  it("backs off by half again while quiet, up to 15 seconds", () => {
    expect(nextDelay(POLL_MS, { changed: false, busy: false })).toBe(3000);
    expect(nextDelay(10000, { changed: false, busy: false })).toBe(IDLE_MAX_MS);
    expect(nextDelay(IDLE_MAX_MS, { changed: false, busy: false })).toBe(IDLE_MAX_MS);
    expect(nextDelay(IDLE_MAX_MS, { changed: true, busy: false })).toBe(POLL_MS);
    expect(nextDelay(IDLE_MAX_MS, { changed: false, busy: true })).toBe(POLL_MS);
  });

  it("waits longer after each quiet check, and goes back to 2 seconds after a change", async () => {
    const h = harness();
    h.poller.start();
    const seen: Array<number | null> = [];
    for (let i = 0; i < 7; i++) seen.push(await h.tick());
    expect(seen).toEqual([2000, 3000, 4500, 6750, 10125, 15000, 15000]);
    h.change();
    await h.tick();
    expect(h.refreshes).toHaveLength(1);
    expect(h.waits()).toEqual([POLL_MS]);
  });

  it("stays at 2 seconds while a turn or an undo runs, and hurries back when one starts", async () => {
    const h = harness();
    h.poller.start();
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.waits()[0]).toBeGreaterThan(POLL_MS);
    h.busy(true);
    h.poller.hurry();
    expect(h.waits()).toEqual([POLL_MS]);
    for (let i = 0; i < 3; i++) expect(await h.tick()).toBe(POLL_MS);
  });

  it("asks nothing while the tab is hidden, and asks at once when it shows", async () => {
    const h = harness();
    h.poller.start();
    await h.tick();
    const before = h.reads.length;
    h.hide(true);
    h.poller.pause();
    expect(h.waits()).toEqual([]);
    // A timer that fired just as the tab hid does not read.
    expect(await h.tick()).toBeNull();
    expect(h.reads.length).toBe(before);
    h.hide(false);
    h.change();
    h.poller.wake();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.reads.length).toBe(before + 1);
    expect(h.refreshes).toHaveLength(1);
    expect(h.waits()).toEqual([POLL_MS]);
  });
});
