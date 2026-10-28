// Sprint 5 review round 2, B1: the page sends the case generation it last
// read on every write, including the first write after it loads and the
// first write after Delete case. fetch is replaced, so nothing leaves the
// test.
import { afterEach, describe, expect, it, vi } from "vitest";

type Sent = { method: string; path: string; generation: string | undefined };

function fakeServer(generations: number[]) {
  const sent: Sent[] = [];
  let reads = 0;
  vi.stubGlobal("fetch", async (path: string, init: { method: string; headers: Record<string, string> }) => {
    sent.push({ method: init.method, path, generation: init.headers["X-Case-Generation"] });
    const body = path === "/api/state" ? { generation: generations[Math.min(reads++, generations.length - 1)] } : {};
    return { ok: true, status: 200, json: async () => body };
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const READS = new Set(["state", "fixtures", "calendar", "liveVersion"]);

describe("ui api", () => {
  it("reads the case before its first write, then sends the generation on every write", async () => {
    const sent = fakeServer([3]);
    const { api } = await import("./api.ts");
    await api.accept("m2-e1", 1);
    expect(sent).toEqual([
      { method: "GET", path: "/api/state", generation: undefined },
      { method: "POST", path: "/api/evidence/m2-e1/accept", generation: "3" },
    ]);

    // Every write the page can make carries it.
    sent.length = 0;
    const writes = Object.entries(api).filter(([name]) => !READS.has(name));
    for (const [, fn] of writes) await (fn as (...args: unknown[]) => Promise<unknown>)("x", "y", 1, 2, true);
    expect(sent).toHaveLength(writes.length);
    expect(sent.every((s) => s.method === "POST" && s.generation === "3")).toBe(true);
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
