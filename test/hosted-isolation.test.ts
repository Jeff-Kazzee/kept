// Hosted mode, design item 2 (0014): one workspace per account. Account A
// tries to read, write, undo, import, connect Google and chat against B's
// case, and each attempt is refused or lands in A's own workspace. Then
// Delete account, and the workspace cache.
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureMessage } from "./helpers.ts";
import { fakeMeta, sseEvents, startHosted, type Browser, type Hosted } from "./hosted-helpers.ts";

let h: Hosted | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const gen = (state: { generation: number }) => ({ "X-Case-Generation": String(state.generation) });

async function twoAccounts() {
  h = await startHosted();
  const a = h.browser();
  const b = h.browser();
  await h.googleSignIn(a, { sub: "sub-a", email: "a@example.com" });
  await h.googleSignIn(b, { sub: "sub-b", email: "b@example.com" });
  const idOf = (x: Browser) => h!.app.store.session(x.cookies.get(`appt_session_${h!.port}`)!)!.account.id;
  return { a, b, idA: idOf(a), idB: idOf(b) };
}

describe("isolation across accounts", () => {
  it("each account reads and writes only its own case, its own files, and its own activity", async () => {
    const { a, b, idA, idB } = await twoAccounts();
    const sa = (await a.call("GET", "/api/state")).body;
    const imported = await a.call("POST", "/api/messages", fixtureMessage("m2"), gen(sa));
    expect(imported.status).toBe(200);
    const after = (await a.call("GET", "/api/state")).body;
    expect(after.messages.map((m: { id: string }) => m.id)).toEqual(["m2"]);
    // B sees an empty case.
    const sb = (await b.call("GET", "/api/state")).body;
    expect(sb.messages).toEqual([]);
    expect((await b.call("GET", "/api/activity")).body.entries ?? []).toEqual([]);
    // Each workspace is its own folder.
    expect(existsSync(path.join(h!.dir, "accounts", idA, "app.sqlite"))).toBe(true);
    expect(existsSync(path.join(h!.dir, "accounts", idB, "app.sqlite"))).toBe(true);
    expect(idA).not.toBe(idB);

    // B cannot reach A's message, evidence or activity by id.
    const entry = (await a.call("GET", "/api/activity")).body.entries[0];
    expect(entry).toBeTruthy();
    const undo = await b.call("POST", `/api/activity/${encodeURIComponent(entry.id)}/undo`, { expectedVersion: 0 }, gen(sb));
    expect(undo.status).toBe(404);
    const own = await b.call("POST", "/api/messages/m2/own-report", { expectedVersion: 1, answer: "yes" }, gen(sb));
    // Refused: B's case has no such message at any version.
    expect([404, 409]).toContain(own.status);
    expect((await b.call("GET", "/api/state")).body.messages).toEqual([]);
    const del = await b.call("POST", "/api/case/delete", { expectedVersion: sb.caseVersion, confirmation: "DELETE" }, gen(sb));
    expect(del.status).toBe(200);
    // B's Delete case left A's case alone.
    expect((await a.call("GET", "/api/state")).body.messages).toHaveLength(1);
    // A's own undo works, in A's workspace.
    const aEntry = (await a.call("GET", "/api/activity")).body;
    const undoA = await a.call("POST", `/api/activity/${encodeURIComponent(aEntry.entries[0].id)}/undo`, { expectedVersion: aEntry.activityVersion }, gen(after));
    expect(undoA.status).toBe(200);
  });

  it("settings and the time zone are per account", async () => {
    const { a, b } = await twoAccounts();
    const set = (await a.call("GET", "/api/settings")).body;
    const sa = (await a.call("GET", "/api/state")).body;
    const r = await a.call("PUT", "/api/settings/timezone", { timezone: "Europe/Berlin", expectedVersion: set.settingsVersion }, gen(sa));
    expect(r.status).toBe(200);
    expect((await a.call("GET", "/api/settings")).body.timezone).toBe("Europe/Berlin");
    expect((await b.call("GET", "/api/settings")).body.timezone).not.toBe("Europe/Berlin");
  });

  it("the chat of one account is not the other's", async () => {
    const meta = fakeMeta();
    const { a, b, idA } = await twoAccounts();
    h!.app.store.grant(idA, 5_000_000, "judge:j000000000000");
    const sa = (await a.call("GET", "/api/state")).body;
    const turn = await a.call("POST", "/api/chat", { text: "What is on my schedule?", expectedVersion: 0 }, gen(sa));
    const events = sseEvents(turn.text);
    expect(events.at(-1)!.event).toBe("turn.done");
    expect(meta.calls.length).toBeGreaterThan(0);
    expect((await a.call("GET", "/api/chat")).body.messages).toHaveLength(2);
    expect((await b.call("GET", "/api/chat")).body.messages).toEqual([]);
    // B has no credit: B's turn is refused before anything is saved.
    const sb = (await b.call("GET", "/api/state")).body;
    const refused = sseEvents((await b.call("POST", "/api/chat", { text: "What is on my schedule?", expectedVersion: 0 }, gen(sb))).text);
    expect(refused.map((e) => e.event)).toEqual(["turn.error"]);
    expect(refused[0]!.data.code).toBe("credits_exhausted");
    expect((await b.call("GET", "/api/chat")).body.messages).toEqual([]);
    // A's balance paid for A's turn only.
    expect(h!.app.store.charges(idA).length).toBeGreaterThan(0);
  });

  it("a Google connect started by A cannot finish in B's session, and each status is its own", async () => {
    const { a, b } = await twoAccounts();
    const ga = (await a.call("GET", "/api/google")).body;
    const sa = (await a.call("GET", "/api/state")).body;
    const start = await a.call("POST", "/api/google/connect", { expectedVersion: ga.version }, gen(sa));
    expect(start.status).toBe(200);
    const back = h!.google!.fake.consent(start.body.authorizeUrl);
    // B's browser, with B's session, arrives at the callback with A's state
    // and A's flow cookie.
    const flow = [...a.cookies].find(([k]) => k.startsWith("appt_google_flow_"))!;
    b.cookies.set(flow[0], flow[1]);
    const cb = await b.visit(`${back.pathname}${back.search}`);
    expect(cb.headers.location).toBe("/?google_error=invalid_state");
    expect((await b.call("GET", "/api/google")).body.connected).toBe(false);
    expect((await a.call("GET", "/api/google")).body.connected).toBe(false);

    // A's own callback connects A only.
    const start2 = await a.call("POST", "/api/google/connect", { expectedVersion: ga.version }, gen(sa));
    const back2 = h!.google!.fake.consent(start2.body.authorizeUrl);
    expect((await a.visit(`${back2.pathname}${back2.search}`)).headers.location).toBe("/?connected=google");
    expect((await a.call("GET", "/api/google")).body.connected).toBe(true);
    expect((await b.call("GET", "/api/google")).body.connected).toBe(false);
    // A signed-out browser cannot finish a connect.
    const anon = h!.browser();
    expect((await anon.visit(`${back2.pathname}${back2.search}`)).headers.location).toBe("/?google_error=signed_out");
  });

  it("a person's own Meta key and ChatGPT sign-in are refused, and the settings say why", async () => {
    const { a } = await twoAccounts();
    const set = (await a.call("GET", "/api/settings")).body;
    expect(set.hosted).toMatchObject({ chatgptAvailable: false });
    expect(set.meta).toEqual({ keySet: true, source: "server" });
    // 18,000 input and 1,800 output tokens at 3 times the price, to the cent.
    expect(set.models.map((m: { id: string; turnCost: string }) => [m.id, m.turnCost])).toEqual([
      ["muse-spark-1.3", "about $0.09 a turn"],
      ["muse-wonder-1.0", "about $0.32 a turn"],
    ]);
    expect((await a.call("POST", "/api/auth/meta-key", { key: "user-meta-key-0123456789", expectedVersion: set.settingsVersion })).body.error).toBe("not_offered");
    expect((await a.call("POST", "/api/auth/chatgpt/start", {})).body.error).toBe("chatgpt_unavailable");
    expect((await a.call("PUT", "/api/settings/provider", { provider: "chatgpt", expectedVersion: set.settingsVersion })).body.error).toBe("chatgpt_unavailable");
    expect((await a.visit("/auth/callback?code=x&state=y")).headers.location).toBe("/?signInError=chatgpt_not_available_here");
    // The model choice still works, per account.
    expect((await a.call("PUT", "/api/settings/model", { model: "muse-wonder-1.0", expectedVersion: set.settingsVersion })).status).toBe(200);
  });

  it("Delete account removes the workspace and the sessions, and keeps the ledger without the email", async () => {
    const { a, b, idA } = await twoAccounts();
    const sa = (await a.call("GET", "/api/state")).body;
    await a.call("POST", "/api/messages", fixtureMessage("m2"), gen(sa));
    h!.app.store.grant(idA, 1_000_000, "judge:j000000000000");
    expect((await a.call("POST", "/api/account/delete", { confirmation: "nope" })).status).toBe(422);
    const del = await a.call("POST", "/api/account/delete", { confirmation: "DELETE" });
    expect(del.body).toEqual({ deleted: true });
    expect(existsSync(path.join(h!.dir, "accounts", idA))).toBe(false);
    expect((await a.call("GET", "/api/session")).body.signedIn).toBe(false);
    const row = h!.app.store.account(idA)!;
    expect(row).toMatchObject({ deleted: true, email: null, name: null });
    expect(h!.app.store.ledger(idA).map((r) => r.kind)).toEqual(["grant"]);
    // B is untouched, and signing in again as A makes a new, empty account.
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(true);
    await h!.googleSignIn(a, { sub: "sub-a", email: "a@example.com" });
    const again = h!.app.store.session(a.cookies.get(`appt_session_${h!.port}`)!)!.account;
    expect(again.id).not.toBe(idA);
    expect((await a.call("GET", "/api/state")).body.messages).toEqual([]);
  });

  it("the cache closes idle workspaces and opens them again on the next request", async () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    h = await startHosted({ now: () => now });
    const a = h.browser();
    await h.googleSignIn(a);
    const id = h.app.store.session(a.cookies.get(`appt_session_${h.port}`)!)!.account.id;
    const s = (await a.call("GET", "/api/state")).body;
    await a.call("POST", "/api/messages", fixtureMessage("m2"), gen(s));
    expect(h.app.workspaces.isOpen(id)).toBe(true);
    now += 31 * 60_000;
    expect(h.app.workspaces.sweep()).toBe(1);
    expect(h.app.workspaces.isOpen(id)).toBe(false);
    expect((await a.call("GET", "/api/state")).body.messages).toHaveLength(1);
    expect(() => h!.app.workspaces.dir("../etc")).toThrow();
    expect(() => h!.app.workspaces.dir(`${id}/..`)).toThrow();
  });
});
