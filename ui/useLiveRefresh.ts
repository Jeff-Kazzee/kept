// The page learns that anything changed (the app, the MCP server, another
// tab or the chat) and reloads. Round 2, finding 4: one held read at a
// time, GET /api/case/version?since=<the version shown>. The server answers
// the moment the case changes, or after 25 seconds with the same version,
// and the page asks again at once. Idle, that is one quiet request per 25
// seconds. A failed read is tried again after 1, 2, 4 ... up to 15
// seconds. A server that answers at once without holding is asked every 2
// seconds, as before. While the tab is hidden nothing is asked and a held
// read is dropped. Showing the tab, `focus` and `pageshow` ask again at
// once.
import { useEffect, useRef } from "react";
import { versionChanged, type LiveVersion } from "./api.ts";

export const POLL_MS = 2000;
export const BACKOFF_MAX_MS = 15000;
// An answer faster than this with no change means the server did not hold.
export const HELD_MIN_MS = 1000;

export const sinceParam = (v: LiveVersion) => `${v.generation}.${v.seq}${v.calendar !== undefined ? `.${v.calendar}` : ""}`;

export const backoff = (failures: number) => Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.max(0, failures - 1));

export type LiveDeps = {
  read: (since: LiveVersion, signal: AbortSignal) => Promise<LiveVersion>;
  hidden: () => boolean;
  now: () => number;
  // Resolves after `ms`, or early when `signal` aborts.
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

const browser: LiveDeps = {
  read: async (since, signal) => {
    const res = await fetch(`/api/case/version?since=${sinceParam(since)}`, { signal });
    if (!res.ok) throw new Error(`live ${res.status}`);
    return (await res.json()) as LiveVersion;
  },
  hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    }),
};

// The channel without React, so its behavior is tested on its own.
export function createLiveChannel(o: { current: () => LiveVersion | null; refresh: () => Promise<void> }, deps: LiveDeps = browser) {
  let stopped = false;
  let running = false;
  // Aborts the held read or the wait, whichever is under way.
  let step: AbortController | null = null;
  let failures = 0;
  // The version a refresh was started for, until the page shows it, so
  // the next read does not ask about a change already being shown.
  let shown: LiveVersion | null = null;
  const reads = { count: 0 };
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      while (!stopped && !deps.hidden()) {
        const page = o.current();
        if (shown !== null && page !== null && !versionChanged(page, shown)) shown = null;
        const since = shown ?? page;
        step = new AbortController();
        const signal = step.signal;
        if (since === null) {
          await deps.sleep(POLL_MS, signal);
          continue;
        }
        const started = deps.now();
        try {
          reads.count++;
          const now = await deps.read(since, signal);
          failures = 0;
          const latest = o.current();
          if (latest !== null && versionChanged(now, shown ?? latest)) {
            shown = now;
            await o.refresh();
          }
          else if (deps.now() - started < HELD_MIN_MS) await deps.sleep(POLL_MS, signal);
        } catch {
          if (signal.aborted) continue;
          failures++;
          await deps.sleep(backoff(failures), signal);
        }
      }
    } finally {
      running = false;
      step = null;
    }
  };
  return {
    start: () => void loop(),
    // Ask now: a wait ends at once, and a stopped loop starts again.
    wake: () => {
      if (stopped || deps.hidden()) return;
      if (running) {
        failures = 0;
        step?.abort();
      } else void loop();
    },
    // Hidden: the held read is dropped and the loop ends until `wake`.
    pause: () => step?.abort(),
    stop: () => {
      stopped = true;
      step?.abort();
    },
    reads,
    get running() {
      return running;
    },
  };
}

export function useLiveRefresh(current: LiveVersion | null, refresh: () => Promise<void>, deps?: LiveDeps): void {
  const latest = useRef(current);
  latest.current = current;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const channel = createLiveChannel({ current: () => latest.current, refresh: () => refreshRef.current() }, deps);
    channel.start();
    const onVisible = () => (document.visibilityState === "hidden" ? channel.pause() : channel.wake());
    const onWake = () => channel.wake();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      channel.stop();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [deps]);
}
