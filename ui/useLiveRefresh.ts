// While the tab is visible, asks every POLL_MS whether anything changed (the
// app, the MCP server, another tab or the chat) and reloads when it did.
// One request at a time.
import { useEffect, useRef } from "react";
import { api, versionChanged, type LiveVersion } from "./api.ts";

export const POLL_MS = 2000;

export function useLiveRefresh(current: LiveVersion | null, refresh: () => Promise<void>): void {
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== "visible" || latest.current === null) return;
      busy = true;
      try {
        const now = await api.liveVersion();
        if (latest.current && versionChanged(now, latest.current)) await refresh();
      } catch {
        // Tried again at the next poll.
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void check(), POLL_MS);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
}
