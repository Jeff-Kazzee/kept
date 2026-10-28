// J12: with no provider ready (no Meta key from the person or the server,
// no ChatGPT sign-in), the chat and every model step answer a fixed
// sentence written by code that says what to set up. Nothing is invented,
// replayed or written. The code-only parts keep working.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../server/api.ts";
import { createChat } from "../server/chat.ts";
import { CaseAgent } from "../src/agent/agent.ts";
import type { ChatEvent } from "../src/agent/types.ts";
import { CaseService } from "../src/case/service.ts";
import { loadCaseProfile, readFixtureText } from "../src/fixtures/load.ts";
import { IntakeService } from "../src/intake/service.ts";
import { ChatGptAuth } from "../src/model/providers/chatgpt-auth.ts";
import { createProviderClient } from "../src/model/providers/factory.ts";
import { NO_PROVIDER_TEXT } from "../src/model/providers/messages.ts";
import { SecretsStore } from "../src/model/providers/secrets.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { fixtureMessage } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The app as server/main.ts wires it, on the provider factory with no key.
function app(serverMetaKey: string | null = null) {
  const dir = mkdtempSync(path.join(tmpdir(), "no-provider-"));
  dirs.push(dir);
  const secrets = new SecretsStore(path.join(dir, "app-secrets.sqlite"));
  const client = createProviderClient({ store: secrets, auth: new ChatGptAuth({ store: secrets, port: 5193 }), serverMetaKey });
  const ready = () => client.ready();
  const store = new EventStore(":memory:");
  const intake = new IntakeService(store, client);
  const kase = new CaseService(store, intake, client, { userName: loadCaseProfile().user_name });
  const reply = new ReplyService(store, kase, client);
  const records = new RecordsService(store, intake, kase);
  const api = createApi(intake, kase, { ready }, reply, { store, records });
  const chat = createChat(new CaseAgent(store, { intake, kase, reply, records }, client, { ready }));
  const call = async (method: string, p: string, body?: unknown) => api({ method, path: p, body, generation: kase.generation() });
  const say = async (text: string) => {
    const events: ChatEvent[] = [];
    const chatVersion = (await new Promise<{ chatVersion: number }>((resolve) => chat.serve({ method: "GET", body: undefined }, { json: (_s, b) => resolve(b as { chatVersion: number }), event: () => {}, end: () => {} }))).chatVersion;
    await chat.serve({ method: "POST", body: { text, expectedVersion: chatVersion }, generation: kase.generation() }, { json: () => {}, event: (e) => events.push(e), end: () => {} });
    return events;
  };
  return { client, store, kase, call, say };
}

describe("J12: no provider ready", () => {
  it("the factory says whether a provider can take a call", () => {
    expect(app().client.ready()).toBe(false);
    expect(app("server-key-for-test").client.ready()).toBe(true);
  });

  it("a chat turn is refused before it starts with the setup sentence, and nothing is saved", async () => {
    const a = app();
    const before = a.store.readAll().length;
    const events = await a.say("What is confirmed?");
    expect(events.map((e) => e.event)).toEqual(["turn.error"]);
    expect(events[0]!.data).toMatchObject({ code: "provider_not_ready", message: NO_PROVIDER_TEXT });
    expect(a.store.readAll()).toHaveLength(before);
    expect(NO_PROVIDER_TEXT).toMatch(/Meta Model API key or Sign in with ChatGPT\. Add one in Settings\./);
  });

  it("every model route answers 422 provider_not_ready and writes nothing, and the code-only routes work", async () => {
    const a = app();
    // Code only: load the demo calendar, import a message, read the state.
    const cal = await a.call("POST", "/api/calendar", { name: "dana.ics", text: readFixtureText("calendar/dana.ics"), expectedVersion: 0 });
    expect(cal.status).toBe(200);
    const imported = await a.call("POST", "/api/messages", fixtureMessage("m1"));
    expect(imported.status).toBe(200);
    const count = a.store.readAll().length;
    const refused = [
      await a.call("POST", "/api/messages/m1/extract", { effort: "minimal", expectedVersion: (imported.body as { version: number }).version }),
      await a.call("POST", "/api/conflicts/c-1/explain", { expectedVersion: 0 }),
      await a.call("POST", "/api/questions/next", { expectedVersion: 0 }),
      await a.call("POST", "/api/reply/suggest", { expectedVersion: 0, intent: "MON" }),
    ];
    for (const r of refused) expect(r).toEqual({ status: 422, body: { error: "provider_not_ready", message: NO_PROVIDER_TEXT } });
    expect(a.store.readAll()).toHaveLength(count);
    expect((await a.call("GET", "/api/state")).status).toBe(200);
    expect((await a.call("GET", "/api/activity")).status).toBe(200);
  });
});
