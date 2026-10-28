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

function fakeSessionStorage() {
  const items = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  });
  return items;
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
    // No pairing code is stored, so none is sent.
    expect(sent.some((s) => s.pairing !== undefined)).toBe(false);
  });

  it("sends the pairing code from this tab only with grant create and proposal confirm, and drops a refused one", async () => {
    const items = fakeSessionStorage();
    const sent = fakeServer([3], (p) => (p === "/api/proposals/p-2/confirm" ? { status: 403, body: { error: "pairing_failed", message: "That pairing code is not right." } } : null));
    const { api, pairing } = await import("./api.ts");
    pairing.set(" ABCD-EFGH ");
    await api.state();
    await api.createGrant("Agent", "read");
    await api.confirmProposal("p-1", 1);
    await api.rejectProposal("p-1", 2);
    await api.revokeGrant("g-1", 1);
    await api.archive("2026-11-12T10:30", 0);
    expect(sent.filter((s) => s.method === "POST").map((s) => [s.path, s.pairing])).toEqual([
      ["/api/grants", "ABCD-EFGH"],
      ["/api/proposals/p-1/confirm", "ABCD-EFGH"],
      ["/api/proposals/p-1/reject", undefined],
      ["/api/grants/g-1/revoke", undefined],
      ["/api/records/2026-11-12T10%3A30/archive", undefined],
    ]);
    await expect(api.confirmProposal("p-2", 1)).rejects.toThrow("That pairing code is not right.");
    expect(pairing.get()).toBeNull();
    expect(items.size).toBe(0);
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
