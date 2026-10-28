// The scripted chat (?mockchat=1) against the real local API: it follows
// the chat contract, changes the case only through the existing routes,
// and declines a health question without running a script.
import { describe, expect, it } from "vitest";
import { createApi } from "../../server/api.ts";
import { SCOPE_DECLINE } from "../../src/domain/scope.ts";
import { CaseService } from "../../src/case/service.ts";
import { RecordedModelClient } from "../../src/model/recorded.ts";
import { ReplyService } from "../../src/reply/service.ts";
import { EventStore } from "../../src/store/event-log.ts";
import { agentAccess, asFreshPage, fixtureMessage, intake } from "../../test/helpers.ts";
import type { AppState } from "../api.ts";
import { WITHHELD_USER_TEXT } from "../../src/agent/types.ts";
import { createFakeBackend } from "../dev/fakeBackend.ts";
import { createMockTransport, intentOf, type MockApi } from "./mockStream.ts";
import type { ChatEvent } from "./types.ts";
import type { ActivityLog } from "../contract.ts";
import { createHybridBackend } from "../dev/fakeBackend.ts";

function setup() {
  const store = new EventStore(":memory:");
  const svc = intake(store);
  const client = RecordedModelClient.fromDirectory();
  const kase = new CaseService(store, svc, client);
  const handle = asFreshPage(createApi(svc, kase, { mode: "recorded" }, new ReplyService(store, kase, client), agentAccess(store, svc, kase)), kase);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handle({ method, path, body });
    if (res.status !== 200) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as never;
  };
  const writes: string[] = [];
  const post = (path: string, body: unknown) => {
    writes.push(path);
    return call("POST", path, body);
  };
  const api: MockApi = {
    state: () => call("GET", "/api/state"),
    fixtures: () => call("GET", "/api/fixtures"),
    addMessage: (m) => post("/api/messages", m),
    extract: (id, effort, expectedVersion) => post(`/api/messages/${id}/extract`, { effort, expectedVersion }),
    accept: (id, expectedVersion) => post(`/api/evidence/${id}/accept`, { expectedVersion }),
    explain: (id, expectedVersion) => post(`/api/conflicts/${id}/explain`, { expectedVersion }),
    nextQuestion: (expectedVersion) => post("/api/questions/next", { expectedVersion }),
  };
  const agent = createFakeBackend({ now: () => "2026-11-05T09:00:00.000Z" });
  // Sprint 8's real activity log, as the page reads it.
  const activity = () => call("GET", "/api/activity") as Promise<ActivityLog>;
  const mock = createMockTransport({ api, delayMs: 0, now: () => "2026-11-05T09:00:00.000Z", agent, activity });
  const turn = async (text: string, version?: number) => {
    const events: ChatEvent[] = [];
    await mock.send(text, version ?? (await mock.load())!.chatVersion, (e) => events.push(e));
    return events;
  };
  const accept = async () => {
    const s = (await api.state()) as AppState;
    for (const e of s.evidence.filter((x) => x.status === "pending")) await call("POST", `/api/evidence/${e.id}/accept`, { expectedVersion: e.version });
  };
  return { api, call, mock, turn, accept, writes, agent, activity };
}

describe("scripted chat", () => {
  it("routes a message by what it asks", () => {
    expect(intentOf(fixtureMessage("m2").text)).toBe("message");
    expect(intentOf("What is confirmed?")).toBe("status");
    expect(intentOf("What should I do about the change?")).toBe("conflict");
    expect(intentOf("Show my reply draft")).toBe("reply");
    expect(intentOf("What do I need to bring?")).toBe("checklist");
    expect(intentOf("hello")).toBe("help");
  });

  it("reads a pasted demo message, accepts its facts through the routes, streams each server entry as an action, and stores the turn", async () => {
    const { mock, turn, writes, activity } = setup();
    const events = await turn(fixtureMessage("m1").text);
    expect(events[0]).toMatchObject({ event: "turn.started" });
    expect(events.filter((e) => e.event === "tool.started").map((e) => e.data)).toMatchObject([{ label: "Reading the message" }, { label: "Checking each fact against the message" }]);
    const card = events.find((e) => e.event === "card");
    expect(card?.data).toMatchObject({ card: { kind: "claims", messageId: "m1", evidenceIds: ["m1-e1", "m1-e2"] } });
    expect(events.at(-1)).toMatchObject({ event: "turn.done", data: { chatVersion: 1 } });
    // 0007, C4 and 0009: actions and cards come between their tool's start
    // and finish, the held text at the end in pieces.
    const names = events.map((e) => e.event);
    expect(names.slice(0, 2)).toEqual(["turn.started", "tool.started"]);
    expect(names.lastIndexOf("card")).toBeLessThan(names.indexOf("text.delta"));
    const deltas = events.filter((e) => e.event === "text.delta").map((e) => (e.data as { text: string }).text);
    expect(deltas.every((d) => d.length <= 81)).toBe(true);
    expect(writes).toEqual(["/api/messages", "/api/messages/m1/extract", "/api/evidence/m1-e1/accept", "/api/evidence/m1-e2/accept"]);
    // Every entry the server wrote reaches the page once, oldest first, and
    // the stored answer names them.
    const log = await activity();
    const streamed = events.filter((e) => e.event === "action").map((e) => (e.data as { entry: { id: string; kind: string } }).entry);
    expect(streamed.map((e) => e.id)).toEqual([...log.entries].reverse().map((e) => e.id));
    expect(streamed.filter((e) => e.kind === "claim_accepted")).toHaveLength(2);
    expect(log.entries.find((e) => e.kind === "claim_accepted")).toMatchObject({ undoable: true, target: { type: "claim" } });
    const stored = (await mock.load())!;
    expect(stored.messages[1]!.actions).toEqual(streamed.map((e) => e.id));
    expect(stored.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(stored.messages[1]!.cards).toEqual([{ kind: "claims", messageId: "m1", evidenceIds: ["m1-e1", "m1-e2"] }]);
    expect(stored.messages[1]!.text).toContain("accepted 2 facts");
    expect(deltas.join("")).toBe(stored.messages[1]!.text);
  });

  it("the hybrid backend sends the time zone, activity and undo to sprint 8's routes, and only the provider part and Google to the fake", async () => {
    const { turn, call, agent, activity } = setup();
    await turn(fixtureMessage("m1").text);
    const real = {
      kind: "real" as const,
      settings: async () => ({ ...((await call("GET", "/api/settings")) as object), model: undefined, models: undefined }) as never,
      setTimezone: (zone: string, v: number, from?: "browser" | "you") => call("PUT", "/api/settings/timezone", { timezone: zone, expectedVersion: v, ...(from === "browser" ? { source: "browser" } : {}) }),
      setProvider: async () => Promise.reject(new Error("not on sprint 8")),
      setModel: async () => Promise.reject(new Error("not on sprint 8")),
      saveMetaKey: async () => Promise.reject(new Error("not on sprint 8")),
      removeMetaKey: async () => Promise.reject(new Error("not on sprint 8")),
      chatgptStart: async () => Promise.reject(new Error("not on sprint 8")),
      chatgptSignOut: async () => Promise.reject(new Error("not on sprint 8")),
      activity,
      undo: (id: string, v: number) => call("POST", `/api/activity/${id}/undo`, { expectedVersion: v }),
      google: async () => null,
      googleConnect: async () => Promise.reject(new Error("not on sprint 8")),
      googleDisconnect: async () => Promise.reject(new Error("not on sprint 8")),
    };
    const hybrid = createHybridBackend(real, agent);
    // The provider part is the fake's, so it works before sprint 10.
    await hybrid.saveMetaKey("synthetic-demo-key-0000", 0);
    expect((await hybrid.settings())!).toMatchObject({ provider: "meta", model: "muse-spark-1.3", providersInBuild: true });
    // An accepted fact is undone by the server.
    const log = (await hybrid.activity())!;
    const fact = log.entries.find((e) => e.kind === "claim_accepted")!;
    await hybrid.undo(fact.id, log.activityVersion);
    const after = (await activity()).entries.find((e) => e.id === fact.id)!;
    expect(after.undone).toBe(true);
    // The first-load zone goes to the server with source "browser".
    const s = (await hybrid.settings())!;
    await hybrid.setTimezone("Europe/Berlin", s.settingsVersion, "browser");
    expect((await hybrid.settings())!).toMatchObject({ timezone: "Europe/Berlin", timezoneSource: "browser" });
  });

  it("with Google connected, finds a message in Gmail and keeps a confirmed time on Google Calendar, with Undo", async () => {
    const { turn, agent } = setup();
    const off = await turn("Check my email for appointments");
    expect(off.filter((e) => e.event === "text.delta").map((e) => (e.data as { text: string }).text).join("")).toContain("Gmail is not connected.");
    await agent.googleConnect();
    for (const id of ["m1", "m2"]) await turn(fixtureMessage(id).text);
    const mail = await turn("Check my email for appointments");
    const kinds = mail.filter((e) => e.event === "action").map((e) => (e.data as { entry: { kind: string } }).entry.kind);
    // The server logs the import, and the fake adds where it came from.
    expect(kinds).toContain("message_imported");
    expect(kinds).toContain("gmail_message_imported");
    const log = (await agent.activity())!;
    const added = log.entries.filter((e) => e.kind === "calendar_event_added");
    expect(added.length).toBeGreaterThan(0);
    expect(added[0]!.target?.type).toBe("slot");
    await agent.undo(added[0]!.id, log.activityVersion);
    expect((await agent.activity())!.entries.find((e) => e.id === added[0]!.id)?.undone).toBe(true);
  });

  it("walks the change: explanation and question cards, then fact chips from the live case", async () => {
    const { turn, accept } = setup();
    // The scripted agent accepts each message's facts itself.
    for (const id of ["m1", "m2", "m3"]) await turn(fixtureMessage(id).text);
    await accept();
    const change = await turn("What should I do about the change?");
    const cards = change.filter((e) => e.event === "card").map((e) => (e.data as { card: { kind: string } }).card.kind);
    expect(cards).toEqual(["explanation", "question"]);
    const status = await turn("What is confirmed?");
    const facts = status.find((e) => e.event === "facts")!.data as { chips: Array<{ slotKey: string; stateLabel: string }> };
    expect(facts.chips).toContainEqual(expect.objectContaining({ slotKey: "2026-11-12T10:30", stateLabel: "Confirmed · office message, change proposed" }));
  });

  it("declines a health question with the fixed text and runs no script", async () => {
    const { mock, turn, writes } = setup();
    const events = await turn("What dose of my medication should I take?");
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("turn.started");
    expect(names.slice(-2)).toEqual(["turn.error", "turn.done"]);
    expect(names.slice(1, -2).every((n) => n === "text.delta")).toBe(true);
    expect(events.at(-2)!.data).toMatchObject({ code: "out_of_scope", message: SCOPE_DECLINE });
    expect(writes).toEqual([]);
    // The person's words are not kept. A fixed sentence is stored in their place.
    const stored = (await mock.load())!.messages;
    expect(stored[0]).toMatchObject({ role: "user", text: WITHHELD_USER_TEXT });
    expect(stored[1]).toMatchObject({ declined: true, text: SCOPE_DECLINE });
    expect(JSON.stringify(stored)).not.toContain("medication");
  });

  it("refuses a stale chat version and stores nothing", async () => {
    const { mock, turn } = setup();
    await turn("hello");
    const events = await turn("hello again", 0);
    // Refused before it starts: only turn.error.
    expect(events.map((e) => e.event)).toEqual(["turn.error"]);
    expect(events[0]).toMatchObject({ data: { code: "stale_edit" } });
    expect((await mock.load())!.chatVersion).toBe(1);
  });

  it("forgets the chat after Delete case", async () => {
    const { api, call, mock, turn } = setup();
    await turn("hello");
    expect((await mock.load())!.messages).toHaveLength(2);
    const s = (await api.state()) as AppState;
    await call("POST", "/api/case/delete", { expectedVersion: s.caseVersion, confirmation: "DELETE" });
    expect((await mock.load())!.messages).toHaveLength(0);
  });
});
