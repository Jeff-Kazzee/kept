// Asks whether anything changed (the app, the MCP server, another tab or
// the chat) and reloads when it did. One request at a time. 0019, P20: it
// asks every 2 seconds while a turn or an undo runs and right after a
// change, then backs off by half again each quiet check, up to 15 seconds.
// While the tab is hidden it does not ask at all, and it asks once as soon
// as the tab shows again.
import { useEffect, useRef } from "react";
import { api, versionChanged, type LiveVersion } from "./api.ts";

export const POLL_MS = 2000;
export const IDLE_MAX_MS = 15000;

// The wait before the next check. Busy or just changed: the base. Quiet:
// half again the last wait, at most IDLE_MAX_MS.
export function nextDelay(last: number, { changed, busy }: { changed: boolean; busy: boolean }): number {
  if (changed || busy) return POLL_MS;
  return Math.min(IDLE_MAX_MS, Math.round(last * 1.5));
}

export type LiveDeps = {
  read: () => Promise<LiveVersion>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  hidden: () => boolean;
};

const browser: LiveDeps = {
  read: () => api.liveVersion(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  hidden: () => typeof document !== "undefined" && document.visibilityState !== "visible",
};

// The poller without React, so its timing is tested on its own. `current`
// and `busy` are read at each check. `wake` asks now and starts again from
// the base wait, as when the tab shows or a turn starts.
export function createPoller(o: { current: () => LiveVersion | null; busy: () => boolean; refresh: () => Promise<void> }, deps: LiveDeps = browser) {
  let timer: unknown = null;
  let delay = POLL_MS;
  let checking = false;
  let stopped = false;
  const schedule = (ms: number) => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    if (stopped || deps.hidden()) return;
    timer = deps.setTimer(() => void check(), ms);
  };
  const check = async () => {
    timer = null;
    if (stopped || deps.hidden()) return;
    if (checking) return schedule(delay);
    const seen = o.current();
    if (seen === null) return schedule(delay);
    checking = true;
    let changed = false;
    try {
      const now = await deps.read();
      const latest = o.current();
      changed = latest !== null && versionChanged(now, latest);
      if (changed) await o.refresh();
    } catch {
      // Tried again at the next check.
    } finally {
      checking = false;
    }
    delay = nextDelay(delay, { changed, busy: o.busy() });
    schedule(delay);
  };
  return {
    start: () => schedule(delay),
    wake: () => {
      delay = POLL_MS;
      void check();
    },
    // Busy again: the next check comes at the base wait.
    hurry: () => {
      if (delay === POLL_MS) return;
      delay = POLL_MS;
      schedule(delay);
    },
    // Hidden: no timer waits. `wake` starts again.
    pause: () => {
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    },
    stop: () => {
      stopped = true;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    },
    get delay() {
      return delay;
    },
    get scheduled() {
      return timer !== null;
    },
  };
}

export function useLiveRefresh(current: LiveVersion | null, refresh: () => Promise<void>, busy = false): void {
  const latest = useRef(current);
  latest.current = current;
  const isBusy = useRef(busy);
  isBusy.current = busy;
  const poller = useRef<ReturnType<typeof createPoller> | null>(null);
  useEffect(() => {
    const p = createPoller({ current: () => latest.current, busy: () => isBusy.current, refresh });
    poller.current = p;
    p.start();
    const onVisible = () => {
      if (document.visibilityState === "visible") p.wake();
      else p.pause();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      p.stop();
      poller.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  useEffect(() => {
    if (busy) poller.current?.hurry();
  }, [busy]);
}
