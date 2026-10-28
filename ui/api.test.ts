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
    // Pairing is gone: no code header.
    expect(sent.some((s) => s.pairing !== undefined)).toBe(false);
  });

  it("sends settings, activity and sign-in writes with the same headers, and reads a missing route as not available", async () => {
    const sent = fakeServer([5], (p) => (p === "/api/settings" || p === "/api/activity" || p === "/api/google" ? { status: 404, body: { error: "not_found" } } : null));
    const { realBackend } = await import("./agentApi.ts");
    expect(await realBackend.settings()).toBeNull();
    expect(await realBackend.activity()).toBeNull();
    expect(await realBackend.google()).toBeNull();
    sent.length = 0;
    await realBackend.setTimezone("Europe/Berlin", 3);
    await realBackend.setProvider("meta", 4);
    await realBackend.setModel("muse-spark-1.3", 5);
    await realBackend.saveMetaKey("synthetic-key-for-test");
    await realBackend.removeMetaKey();
    await realBackend.chatgptStart();
    await realBackend.chatgptSignOut();
    await realBackend.undo("act-1", 7);
    await realBackend.googleConnect();
    await realBackend.googleDisconnect();
    const writes = sent.filter((s) => s.path !== "/api/state");
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "PUT /api/settings/timezone",
      "PUT /api/settings/provider",
      "PUT /api/settings/model",
      "POST /api/auth/meta-key",
      "DELETE /api/auth/meta-key",
      "POST /api/auth/chatgpt/start",
      "POST /api/auth/chatgpt/signout",
      "POST /api/activity/act-1/undo",
      "POST /api/google/connect",
      "POST /api/google/disconnect",
    ]);
    expect(writes.every((w) => w.generation === "5" && w.app === "1")).toBe(true);
  });

  it("opens a sign-in address only on this origin or over https", async () => {
    const { safeAuthorizeUrl } = await import("./agentApi.ts");
    const origin = "http://127.0.0.1:5180";
    expect(safeAuthorizeUrl("/?signedIn=chatgpt", origin)).toBe("http://127.0.0.1:5180/?signedIn=chatgpt");
    expect(safeAuthorizeUrl("https://auth.example.com/authorize?x=1", origin)).toBe("https://auth.example.com/authorize?x=1");
    expect(safeAuthorizeUrl("javascript:alert(1)", origin)).toBeNull();
    expect(safeAuthorizeUrl("http://evil.example.com/", origin)).toBeNull();
    expect(safeAuthorizeUrl("data:text/html,hi", origin)).toBeNull();
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
