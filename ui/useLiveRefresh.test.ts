// Round 2, finding 4: the page learns of a change through one held read.
// It refreshes the moment the server answers with a change, asks again at
// once, backs off after a failure, polls every 2 s a server that does not
// hold, drops the held read while hidden, and asks again on showing, focus
// and pageshow. Finding 7: the hook's own wiring is tested in a DOM too.
import { createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import type { LiveVersion } from "./api.ts";
import { installTestDom, mount } from "./test-dom.ts";
import { BACKOFF_MAX_MS, POLL_MS, backoff, createLiveChannel, sinceParam, useLiveRefresh, type LiveDeps } from "./useLiveRefresh.ts";

beforeAll(() => {
  installTestDom();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

// A server whose held reads the test answers by hand.
function harness(start: LiveVersion = { generation: 1, seq: 1 }, failRefresh: () => boolean = () => false) {
  let shown: LiveVersion | null = start;
  let hidden = false;
  let clock = 0;
  const held: Array<{ since: LiveVersion; signal: AbortSignal; answer: (v: LiveVersion) => void; fail: (e: Error) => void }> = [];
  const sleeps: Array<{ ms: number; signal: AbortSignal; done: () => void }> = [];
  const refreshes: number[] = [];
  const deps: LiveDeps = {
    read: (since, signal) =>
      new Promise((resolve, reject) => {
        held.push({ since, signal, answer: resolve, fail: reject });
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    hidden: () => hidden,
    now: () => clock,
    sleep: (ms, signal) =>
      new Promise<void>((done) => {
        sleeps.push({ ms, signal, done });
        signal.addEventListener("abort", () => done());
      }),
  };
  let server = start;
  const channel = createLiveChannel(
    {
      current: () => shown,
      refresh: async () => {
        refreshes.push(server.seq);
        if (failRefresh()) return false;
        shown = server;
        return true;
      },
    },
    deps,
  );
  return {
    channel,
    held,
    sleeps,
    refreshes,
    set: (v: LiveVersion) => (server = v),
    advance: (ms: number) => (clock += ms),
    hide: (h: boolean) => (hidden = h),
    last: () => held.at(-1)!,
  };
}

describe("round 2, finding 4: the live channel", () => {
  it("names the version it shows in the read", () => {
    expect(sinceParam({ generation: 3, seq: 41 })).toBe("3.41");
    expect(sinceParam({ generation: 3, seq: 41, calendar: 2 })).toBe("3.41.2");
  });

  it("refreshes the moment the held read answers a change, then holds a read for the new version", async () => {
    const h = harness();
    h.channel.start();
    await tick();
    expect(h.held).toHaveLength(1);
    expect(h.last().since).toEqual({ generation: 1, seq: 1 });
    h.advance(3000);
    h.set({ generation: 1, seq: 2 });
    h.last().answer({ generation: 1, seq: 2 });
    await tick();
    await tick();
    expect(h.refreshes).toEqual([2]);
    expect(h.held).toHaveLength(2);
    expect(h.last().since).toEqual({ generation: 1, seq: 2 });
    expect(h.sleeps).toHaveLength(0);
  });

  it("a page shown at an older generation (a Delete case before its first read) refreshes at once", async () => {
    const h = harness({ generation: 4, seq: 9 });
    h.set({ generation: 5, seq: 0 });
    h.channel.start();
    await tick();
    h.last().answer({ generation: 5, seq: 0 });
    await tick();
    await tick();
    expect(h.refreshes).toEqual([0]);
  });

  it("after a held answer with no change it asks again at once, and a server that does not hold is asked every 2 s", async () => {
    const h = harness();
    h.channel.start();
    await tick();
    h.advance(25000);
    h.last().answer({ generation: 1, seq: 1 });
    await tick();
    expect(h.held).toHaveLength(2);
    expect(h.sleeps).toHaveLength(0);
    h.last().answer({ generation: 1, seq: 1 });
    await tick();
    expect(h.sleeps.map((s) => s.ms)).toEqual([POLL_MS]);
  });

  it("backs off 1, 2, 4 ... 15 s after failures, and focus asks again at once", async () => {
    expect([1, 2, 3, 4, 5, 6].map(backoff)).toEqual([1000, 2000, 4000, 8000, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    const h = harness();
    h.channel.start();
    await tick();
    h.last().fail(new Error("offline"));
    await tick();
    expect(h.sleeps.at(-1)!.ms).toBe(1000);
    h.sleeps.at(-1)!.done();
    await tick();
    h.last().fail(new Error("offline"));
    await tick();
    expect(h.sleeps.at(-1)!.ms).toBe(2000);
    h.channel.wake();
    await tick();
    expect(h.held).toHaveLength(3);
  });

  it("hidden, the held read is dropped and nothing is asked, and showing asks at once", async () => {
    const h = harness();
    h.channel.start();
    await tick();
    const first = h.last();
    h.hide(true);
    h.channel.pause();
    await tick();
    expect(first.signal.aborted).toBe(true);
    expect(h.held).toHaveLength(1);
    expect(h.channel.running).toBe(false);
    h.channel.wake();
    await tick();
    expect(h.held).toHaveLength(1);
    h.hide(false);
    h.channel.wake();
    await tick();
    expect(h.held).toHaveLength(2);
  });
});

describe("round 2, finding 7: the hook's wiring in a page", () => {
  it("starts one held read, drops it when the tab hides, and asks again on showing, focus and pageshow", async () => {
    const h = harness();
    const deps: LiveDeps = {
      read: (since, signal) =>
        new Promise((resolve, reject) => {
          h.held.push({ since, signal, answer: resolve, fail: reject });
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      hidden: () => (document as unknown as { visibilityState: string }).visibilityState === "hidden",
      now: () => 0,
      sleep: (_ms, signal) => new Promise<void>((done) => signal.addEventListener("abort", () => done())),
    };
    const doc = document as unknown as { visibilityState: string; dispatchEvent(e: unknown): void };
    doc.visibilityState = "visible";
    function Probe() {
      useLiveRefresh({ generation: 1, seq: 1 }, async () => {}, deps);
      return null;
    }
    const view = await mount(createElement(Probe));
    await tick();
    expect(h.held).toHaveLength(1);
    const { TestEvent } = await import("./test-dom.ts");
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new TestEvent("visibilitychange"));
    await tick();
    expect(h.held[0]!.signal.aborted).toBe(true);
    expect(h.held).toHaveLength(1);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new TestEvent("visibilitychange"));
    await tick();
    expect(h.held).toHaveLength(2);
    // Focus while a read is held asks again at once, with one read in flight.
    (window as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new TestEvent("focus"));
    await tick();
    expect(h.held).toHaveLength(3);
    expect(h.held.filter((r) => !r.signal.aborted)).toHaveLength(1);
    (window as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new TestEvent("pageshow"));
    await tick();
    expect(h.held.filter((r) => !r.signal.aborted)).toHaveLength(1);
    await view.unmount();
    expect(h.held.every((r) => r.signal.aborted)).toBe(true);
  });
});

describe("Muse round 2, finding 3: the cursor moves only after the page read the change", () => {
  it("a failed refresh keeps the old version, backs off, and asks about the change again", async () => {
    let failing = true;
    const h = harness({ generation: 1, seq: 1 }, () => failing);
    h.channel.start();
    await tick();
    h.set({ generation: 1, seq: 2 });
    h.advance(3000);
    h.last().answer({ generation: 1, seq: 2 });
    await tick();
    await tick();
    expect(h.refreshes).toEqual([2]);
    // It backs off rather than holding a read for the new version.
    expect(h.sleeps.at(-1)!.ms).toBe(1000);
    failing = false;
    h.sleeps.at(-1)!.done();
    await tick();
    // The next read still names the version the page shows.
    expect(h.last().since).toEqual({ generation: 1, seq: 1 });
    h.last().answer({ generation: 1, seq: 2 });
    await tick();
    await tick();
    expect(h.refreshes).toEqual([2, 2]);
    expect(h.last().since).toEqual({ generation: 1, seq: 2 });
  });
});

