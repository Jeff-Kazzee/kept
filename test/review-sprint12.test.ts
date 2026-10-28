// Sprint 12 review round 1 (Muse Wonder): one test per finding, each
// failing before its fix.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../mcp/server.ts";
import { RateLimiter } from "../mcp/rate-limit.ts";
import { createApi } from "../server/api.ts";
import { CaseAgent } from "../src/agent/agent.ts";
import { availableTools } from "../src/agent/tools.ts";
import { despaced, hasClinicalContent } from "../src/domain/scope.ts";
import { ChatGptAuth } from "../src/model/providers/chatgpt-auth.ts";
import { createProviderClient } from "../src/model/providers/factory.ts";
import { NO_PROVIDER_TEXT } from "../src/model/providers/messages.ts";
import type { SecretsStore } from "../src/model/providers/secrets.ts";
import { checkReply, type ReplyOutput } from "../src/reply/suggest.ts";
import type { ReplyContext } from "../src/reply/draft.ts";
import { EventStore } from "../src/store/event-log.ts";
import { processIdentity, stopChild } from "../scripts/demo-check.ts";
import { CLOCK, agentFor, fixtureMessage, message, reply, say, sequence, services } from "./agent-helpers.ts";
import { tempStore } from "./provider-fakes.ts";
import { acceptMessages } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const NOW = Date.parse("2026-11-05T17:00:00.000Z");
const PLAN = "chatgpt.tokens.use.direct";

// ChatGPT chosen, with the given session (null: signed out).
function chatGptStore(session: { scopes?: string[]; expiresAt?: number; refreshToken?: string | null } | null): SecretsStore {
  const t = tempStore();
  cleanups.push(t.cleanup);
  t.store.update(
    (s) => ({
      ...s,
      provider: "chatgpt",
      chatgpt: {
        ...s.chatgpt,
        clientId: "oaiapp_test_client",
        account: session ? { issuer: "https://auth.openai.com", subject: "user-1", email: "sample.person@example.com", name: "Sample Person" } : null,
        session: session
          ? {
              id: "s-1",
              accessToken: "access-token-for-test",
              refreshToken: session.refreshToken === undefined ? "refresh-token-for-test" : session.refreshToken,
              expiresAt: session.expiresAt ?? NOW + 3_600_000,
              earliestRefreshAt: null,
              scopes: session.scopes ?? ["openid", "offline_access", PLAN],
              savedAt: new Date(NOW).toISOString(),
            }
          : null,
      },
    }),
    { bump: true },
  );
  return t.store;
}

const providers = (store: SecretsStore) => createProviderClient({ store, auth: new ChatGptAuth({ store, port: 5193, now: () => NOW }), serverMetaKey: null });

describe("review round 1, finding 1: ChatGPT readiness from the stored connection", () => {
  it("a signed-out ChatGPT, one without plan usage, or one that cannot refresh an expired token is not ready", () => {
    expect(providers(chatGptStore(null)).ready()).toBe(false);
    expect(providers(chatGptStore({ scopes: ["openid", "offline_access"] })).ready()).toBe(false);
    expect(providers(chatGptStore({ expiresAt: NOW - 1000, refreshToken: null })).ready()).toBe(false);
    // Signed in with plan usage: a token still valid, or one a refresh token renews.
    expect(providers(chatGptStore({})).ready()).toBe(true);
    expect(providers(chatGptStore({ expiresAt: NOW - 1000 })).ready()).toBe(true);
  });

  it("a signed-out ChatGPT refuses the chat turn before it starts, and the model routes answer 422", async () => {
    const client = providers(chatGptStore(null));
    const app = services(new EventStore(":memory:", CLOCK));
    const before = app.store.readAll().length;
    const r = await say(agentFor(app, client, { ready: () => client.ready() }), app, "What is confirmed?");
    expect(r.events.map((e) => e.event)).toEqual(["turn.error"]);
    expect(r.of("turn.error")[0]).toMatchObject({ code: "provider_not_ready", message: NO_PROVIDER_TEXT });
    expect(app.store.readAll()).toHaveLength(before);
    const api = createApi(app.intake, app.kase, { ready: () => client.ready() }, app.reply, { store: app.store, records: app.records });
    const res = await api({ method: "POST", path: "/api/reply/suggest", body: { expectedVersion: 0, intent: "MON" }, generation: app.kase.generation() });
    expect(res).toEqual({ status: 422, body: { error: "provider_not_ready", message: NO_PROVIDER_TEXT } });
  });
});

describe("review round 1, finding 2: MCP tools that need the model are refused before any write", () => {
  it("import_message, explain_conflict, ask_next_question and gmail_import answer provider_not_ready and write nothing but the access log", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    const deps = { store: app.store, services: app, limiter: new RateLimiter(), ready: () => false };
    const m = fixtureMessage("m1");
    const before = app.store.readAll().filter((e) => !e.streamId.startsWith("access")).length;
    const calls: Array<[string, unknown]> = [
      ["import_message", { text: m.text, channel: "sms", from: m.from, received_at: m.received_at }],
      ["explain_conflict", { conflict_id: "c-1" }],
      ["ask_next_question", {}],
      ["gmail_import", { message_id: "18f0a1" }],
    ];
    for (const [name, args] of calls) {
      const r = (await callTool(deps, name, args)) as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError, name).toBe(true);
      expect(JSON.parse(r.content[0]!.text), name).toEqual({ error: "provider_not_ready", message: NO_PROVIDER_TEXT });
    }
    expect(app.store.readAll().filter((e) => !e.streamId.startsWith("access"))).toHaveLength(before);
    expect(app.intake.messages()).toEqual([]);
    // A read that needs no model still works.
    const read = (await callTool(deps, "get_schedule", {})) as { isError?: boolean };
    expect(read.isError).toBeUndefined();
  });
});

describe("review round 1, finding 3: the offered tools are read before the person's message is saved", () => {
  it("a Google status that cannot be read means no Google tools this turn, and the turn answers", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    const broken = {
      ...app,
      google: {
        connection: {
          status: () => {
            throw new Error("The settings database cannot be read.");
          },
        },
      } as unknown as NonNullable<Parameters<typeof availableTools>[0]["google"]>,
    };
    expect(availableTools(broken).some((t) => t.name.startsWith("gmail_") || t.name.startsWith("calendar_"))).toBe(false);
    const model = sequence(reply(message("I can help with your appointments.")));
    const agent = new CaseAgent(app.store, broken, model, { now: CLOCK });
    const r = await say(agent, app, "Hi");
    expect(r.of("turn.error")).toEqual([]);
    expect(agent.chat().messages.map((x) => x.role)).toEqual(["user", "assistant"]);
  });
});

describe("review round 1, finding 4: clinical words split into chunks", () => {
  it("joins chunks of two or more letters that spell a clinical word, and runs the diet check on the despaced text", () => {
    for (const bad of ["Tell me about my symp toms", "Should I stop my medi cation?", "Is it can cer?", "Is the rapy needed before Monday?", "f a s t i n g before Thursday?", "What about fas ting?", "My diag nosis came back"]) {
      expect(hasClinicalContent(bad), bad).toBe(true);
    }
    for (const ok of [
      "I moved to Spain last year.",
      "I sent a screenshot of the message.",
      "Dosey Clinic on Elm Street",
      "Show the results of my appointments.",
      "I can certainly come on Monday.",
      "The rapper at the front desk said Monday.",
      "Joe's can wait until Thursday.",
      "See you at 9 a.m. in the U S A office.",
    ]) {
      expect(hasClinicalContent(ok), ok).toBe(false);
    }
    expect(despaced("f a s t i n g")).toBe("fasting");
  });
});

describe("review round 1, finding 5: other-language result words need clinical context", () => {
  it("passes results of appointments, and still declines lab results", () => {
    for (const ok of ["Bitte zeigen Sie die Ergebnisse meiner Termine.", "Los resultados de la reunión del lunes.", "Les résultats de mes rendez-vous."]) {
      expect(hasClinicalContent(ok), ok).toBe(false);
    }
    for (const bad of ["¿Qué significan mis resultados de laboratorio?", "Mes résultats d'analyse sont arrivés.", "Meine Laborergebnisse sind da.", "Was bedeuten meine Ergebnisse vom Bluttest?"]) {
      expect(hasClinicalContent(bad), bad).toBe(true);
    }
  });
});

describe("review round 1, finding 6: a short note that names more than one slot", () => {
  const slot = (key: string, state: "offered" | "confirmed" | "change_proposed") => {
    const [date, time] = key.split("T") as [string, string];
    return {
      key,
      date,
      time,
      state,
      location: null,
      label: key,
      stateLabel: state,
      sourceType: "office_message",
      sourceLabel: "office message",
      evidenceIds: [],
      proposalEvidenceIds: [],
      staleEvidenceIds: [],
      stateEvidenceId: "e",
      missing: [],
      locationDisputed: false,
    };
  };
  const ctx = (keys: string[]) => ({ slots: keys.map((k) => slot(k, "offered")), evidence: [], messages: [], userName: "Dana", archived: [] }) as unknown as ReplyContext;
  const pick = (slotId: string): ReplyOutput => ({ template: "accept_offer", slot_id: slotId, fields: { date: null, time: null, location: null }, no_fit_reason: null });

  it("refuses a pick when the note's time or weekday fits another listed slot too", () => {
    // Two offers at 10:30.
    expect(checkReply(pick("2026-11-12T10:30"), ctx(["2026-11-10T10:30", "2026-11-12T10:30"]), "Confirmed, 10:30")).toContain("ambiguous_slot");
    // Two offers on Thursday.
    expect(checkReply(pick("2026-11-12T10:30"), ctx(["2026-11-12T10:30", "2026-11-12T14:00"]), "See you Thursday")).toContain("ambiguous_slot");
    // One slot fits: no problem, also when the note adds the time to the day.
    expect(checkReply(pick("2026-11-12T10:30"), ctx(["2026-11-10T14:00", "2026-11-12T10:30"]), "Confirmed, 10:30")).toEqual([]);
    expect(checkReply(pick("2026-11-12T10:30"), ctx(["2026-11-12T10:30", "2026-11-12T14:00"]), "See you Thursday at 10:30 AM")).toEqual([]);
    // A note that gives both times cannot be read by code: ambiguous.
    expect(checkReply(pick("2026-11-12T10:30"), ctx(["2026-11-12T10:30", "2026-11-12T14:00"]), "Thursday 10:30 AM, not 2:00 PM")).toContain("ambiguous_slot");
  });
});

describe("review round 1, finding 7: demo:check stops only the process it started", () => {
  it("records the child's command line and start time, and does not signal when either no longer matches", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    cleanups.push(() => child.kill("SIGKILL"));
    await new Promise((r) => child.once("spawn", r));
    const id = processIdentity(child.pid!);
    expect(id).not.toBeNull();
    expect(id!.cmdline).toContain("setInterval");
    // A different start time, as a reused process id would have: no signal.
    expect(await stopChild(child, { ...id!, start: `${id!.start}0` })).toBe(false);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    // No recorded identity: no signal.
    expect(await stopChild(child, null)).toBe(false);
    expect(child.signalCode).toBeNull();
    // The same process: stopped through its handle.
    expect(await stopChild(child, id)).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
    // A process that is gone has no identity.
    expect(processIdentity(child.pid!)).toBeNull();
  });
});

// Keeps the shared helpers in use when a finding's test changes.
void acceptMessages;
void mkdtempSync;
void rmSync;
void tmpdir;
void path;
