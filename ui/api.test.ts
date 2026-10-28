// Sprint 5 review round 2, B1: the page sends the case generation it last
// read on every write, including the first write after it loads and the
// first write after Delete case. fetch is replaced, so nothing leaves the
// test.
import { afterEach, describe, expect, it, vi } from "vitest";

type Sent = { method: string; path: string; generation: string | undefined; app?: string; pairing?: string };

function fakeServer(generations: number[], refuse?: (path: string) => { status: number; body: unknown } | null) {
  const sent: Sent[] = [];
  let reads = 0;
  vi.stubGlobal("fetch", async (path: string, init: { method: string; headers: Record<string, string> }) => {
    sent.push({ method: init.method, path, generation: init.headers["X-Case-Generation"], app: init.headers["X-Appointments-App"], pairing: init.headers["X-Pairing-Code"] });
    const refused = refuse?.(path);
    if (refused) return { ok: false, status: refused.status, json: async () => refused.body };
    const body = path === "/api/state" ? { generation: generations[Math.min(reads++, generations.length - 1)] } : {};
    return { ok: true, status: 200, json: async () => body };
  });
  return sent;
}



afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const READS = new Set(["state", "fixtures", "calendar", "liveVersion", "pair"]);

describe("ui api", () => {
  it("reads the case before its first write, then sends the generation on every write", async () => {
    const sent = fakeServer([3]);
    const { api } = await import("./api.ts");
    await api.accept("m2-e1", 1);
    expect(sent.map(({ method, path, generation }) => ({ method, path, generation }))).toEqual([
      { method: "GET", path: "/api/state", generation: undefined },
      { method: "POST", path: "/api/evidence/m2-e1/accept", generation: "3" },
    ]);

    // Every write the page can make carries it.
    sent.length = 0;
    const writes = Object.entries(api).filter(([name]) => !READS.has(name));
    for (const [, fn] of writes) await (fn as (...args: unknown[]) => Promise<unknown>)("x", "y", 1, 2, true);
    expect(sent).toHaveLength(writes.length);
    expect(sent.every((s) => s.method === "POST" && s.generation === "3")).toBe(true);
    // Sprint 6 review, finding 1: every write carries the app's header.
    expect(sent.every((s) => s.app === "1")).toBe(true);
    // The session is an HttpOnly cookie the browser sends. No code header.
    expect(sent.some((s) => s.pairing !== undefined)).toBe(false);
  });

  it("pairs with one request that needs no case read, and reports not_paired so the page can show the pairing screen", async () => {
    const sent = fakeServer([3], (p) => (p === "/api/state" ? { status: 401, body: { error: "not_paired", message: "Pair this browser with the app first." } } : null));
    const { api, isNotPaired } = await import("./api.ts");
    await api.pair("ABCD-EFGH");
    expect(sent).toEqual([{ method: "POST", path: "/api/pair", generation: undefined, app: "1", pairing: undefined }]);
    const err = await api.state().catch((e: unknown) => e);
    expect(isNotPaired(err)).toBe(true);
    // A write before any read of the case is refused the same way.
    expect(isNotPaired(await api.accept("m2-e1", 1).catch((e: unknown) => e))).toBe(true);
  });

  it("sends the new generation after Delete case reloads the state", async () => {
    const sent = fakeServer([3, 4]);
    const { api } = await import("./api.ts");
    await api.state();
    await api.deleteCase(12, "DELETE");
    await api.state();
    await api.loadCalendar("dana.ics", "BEGIN:VCALENDAR", 0);
    expect(sent.filter((s) => s.method === "POST").map((s) => [s.path, s.generation])).toEqual([
      ["/api/case/delete", "3"],
      ["/api/calendar", "4"],
    ]);
  });
});
