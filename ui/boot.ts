// The first render's data, read together and of one generation (round 2,
// finding 2): from the page itself when the server rendered it, else from
// GET /api/boot, which local mode preloads. Null for the scripted chat,
// which keeps its own, and for a server without the route or a case that
// kept moving during the read: the page then reads each route on its own.
//
// Muse round 2, finding 1: the read belongs to one session owner ("local",
// or one hosted account). It is kept only for that owner, dropped when the
// owner changes (a sign-out, another account), and never given to another.
import { api, type BootData } from "./api.ts";

let kept: { owner: string; read: Promise<BootData | null> } | null = null;

export function scopeBoot(owner: string): void {
  if (kept && kept.owner !== owner) kept = null;
}

export function readBoot(scripted: boolean, owner: string): Promise<BootData | null> {
  if (scripted) return Promise.resolve(null);
  if (kept && kept.owner === owner) return kept.read;
  const read = (async () => {
    // The page's own block is local mode's, rendered by the server.
    const inline = owner === "local" && typeof document !== "undefined" ? document.getElementById("boot") : null;
    if (inline?.textContent) {
      try {
        return api.adoptBoot(JSON.parse(inline.textContent) as BootData);
      } catch {
        // Read it from the route instead.
      }
    }
    try {
      return await api.boot();
    } catch {
      return null;
    }
  })();
  kept = { owner, read };
  return read;
}
