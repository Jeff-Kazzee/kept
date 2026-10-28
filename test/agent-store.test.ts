// The chat stream (G9): expected versions, the case generation, reopen and
// Delete case.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zonedIso } from "../src/domain/zone.ts";
import type { ToolCall, ToolModelClient, ToolReply } from "../src/model/responses.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, useZone } from "./helpers.ts";
import { CLOCK, agentFor, fixtureMessage, fnCall, message, pasted, reasoning, reply, say, sequence, services } from "./agent-helpers.ts";

const dirs: string[] = [];
const stores: EventStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function onFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-store-"));
  dirs.push(dir);
  return { dir, file: path.join(dir, "app.sqlite") };
}

function open(file: string) {
  const store = new EventStore(file, CLOCK);
  stores.push(store);
  return services(store);
}

const filesWith = (dir: string, text: string) => readdirSync(dir).filter((f) => readFileSync(path.join(dir, f)).includes(Buffer.from(text, "utf8")));

describe("G9: the chat stream", () => {
  it("refuses a stale chat version before any write or model call", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    const model = sequence(reply(message("Hello.")), reply(message("Hi again.")));
    const agent = agentFor(app, model);
    await say(agent, app, "Hi");
    const r = await say(agent, app, "Hi from an old tab", { expectedVersion: 0 });
    expect(r.events.map((e) => e.event)).toEqual(["turn.error"]);
    expect(r.of("turn.error")[0]!.code).toBe("stale_edit");
    expect(model.calls).toHaveLength(1);
    expect(agent.chat().chatVersion).toBe(2);
    // The clinical path checks the version too.
    expect((await say(agent, app, "What do my lab results mean?", { expectedVersion: 1 })).of("turn.error")[0]!.code).toBe("stale_edit");
    expect(agent.chat().chatVersion).toBe(2);
  });

  it("a reopened app shows the same chat, and Delete case erases it from the file", async () => {
    const { dir, file } = onFile();
    let app = open(file);
    await acceptMessages(app.intake, ["m1", "m2", "m3"]);
    const m4 = fixtureMessage("m4");
    let agent = agentFor(
      app,
      sequence(
        reply(fnCall("import_message", { text: m4.text, channel: "sms", from: m4.from, received_at: m4.received_at })),
        reply(message("Review the two claims on the card.")),
      ),
    );
    await say(agent, app, pasted("m4", "Unique words zebra lantern:"));
    const before = agent.chat();
    expect(before.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    app.store.close();
    stores.splice(stores.indexOf(app.store), 1);

    app = open(file);
    agent = agentFor(app, sequence());
    expect(agent.chat()).toEqual(before);
    const labels = app.kase.history().map((h) => h.label);
    expect(labels.indexOf("You wrote in the chat")).toBeLessThan(labels.indexOf("Message m4 added (sms)"));
    expect(labels.at(-1)).toBe("Assistant answered in the chat (answer passed the code checks)");
    expect(filesWith(dir, "zebra lantern").length).toBeGreaterThan(0);

    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    expect(agent.chat()).toEqual({ chatVersion: 0, messages: [] });
    expect(filesWith(dir, "zebra lantern")).toEqual([]);
  });

  it("a turn that crosses a Delete case is refused, and nothing lands in the empty case", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    await acceptMessages(app.intake, ["m1", "m2", "m3"]);
    const m4 = fixtureMessage("m4");
    // The model's first reply arrives after the person deleted the case.
    const deleting: ToolModelClient = {
      label: "deleting",
      async respond(_request: ToolCall): Promise<ToolReply> {
        app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
        return {
          output: [reasoning(), fnCall("import_message", { text: m4.text, channel: "sms", from: m4.from, received_at: m4.received_at })],
          usage: { input: 100, cachedInput: 0, output: 10, reasoning: 0 },
          latencyMs: 10,
          firstByteMs: 5,
        };
      },
    };
    const agent = agentFor(app, deleting);
    const r = await say(agent, app, pasted("m4"));
    expect(r.events.map((e) => e.event)).toEqual(["turn.started", "tool.started", "turn.error"]);
    expect(r.of("turn.error")[0]!.code).toBe("case_deleted");
    // Only the settings, which Delete case keeps.
    expect(app.store.readAll().filter((e) => e.streamId !== "settings")).toEqual([]);
    expect(agent.chat()).toEqual({ chatVersion: 0, messages: [] });
  });

  it("a page from before a Delete case cannot write a chat message", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    const model = sequence(reply(message("Hello.")));
    const agent = agentFor(app, model);
    const old = app.kase.generation();
    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    const r = await say(agent, app, "Hi", { generation: old });
    expect(r.of("turn.error")[0]!.code).toBe("case_deleted");
    expect(model.calls).toHaveLength(0);
    // Only the settings, which Delete case keeps.
    expect(app.store.readAll().filter((e) => e.streamId !== "settings")).toEqual([]);
  });

  it("refuses a second turn while one runs with busy, and writes nothing for it", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: ToolModelClient = {
      label: "slow",
      async respond(): Promise<ToolReply> {
        await gate;
        return { output: [reasoning(), message("Done.")], usage: { input: 1, cachedInput: 0, output: 1, reasoning: 0 }, latencyMs: 1, firstByteMs: 1 };
      },
    };
    const agent = agentFor(app, slow);
    const first = say(agent, app, "First");
    const second = await say(agent, app, "Second", { expectedVersion: 1 });
    expect(second.events.map((e) => e.event)).toEqual(["turn.error"]);
    expect(second.of("turn.error")[0]!.code).toBe("busy");
    release();
    expect((await first).report.outcome).toBe("answered");
    expect(agent.chat().messages.map((m) => m.text)).toEqual(["First", "Done."]);
  });

  it("every chat write runs as a case command", async () => {
    class ScopedOnly extends EventStore {
      override transaction<T>(fn: () => T): T {
        if (!this.inCaseScope()) throw new Error("A case write ran outside inCase.");
        return super.transaction(fn);
      }
    }
    const app = services(new ScopedOnly(":memory:", CLOCK));
    await app.kase.inCase(() => acceptMessages(app.intake, ["m1", "m2", "m3"]));
    const m4 = fixtureMessage("m4");
    const model = sequence(
      reply(fnCall("import_message", { text: m4.text, channel: "sms", from: m4.from, received_at: m4.received_at })),
      reply(fnCall("explain_conflict", { conflict_id: app.kase.view().conflicts[0]!.id })),
      reply(fnCall("ask_next_question", {})),
      reply(message("Review the claims, then answer the question on the card.")),
    );
    const r = await say(agentFor(app, model), app, pasted("m4"));
    expect(r.report.outcome).toBe("answered");
    expect(r.report.tools.every((t) => t.ok)).toBe(true);
    expect((await say(agentFor(app, sequence()), app, "What are my lab results?")).report.outcome).toBe("declined");
  });

  it("writes createdAt with the case zone's offset across its daylight change", () => {
    const denver = (iso: string) => zonedIso(iso, "America/Denver");
    expect(denver("2026-10-31T15:00:00.000Z")).toBe("2026-10-31T09:00:00.000-06:00");
    expect(denver("2026-11-01T07:59:59.000Z")).toBe("2026-11-01T01:59:59.000-06:00");
    expect(denver("2026-11-01T08:00:00.000Z")).toBe("2026-11-01T01:00:00.000-07:00");
    expect(denver("2026-11-05T17:00:00.123Z")).toBe("2026-11-05T10:00:00.123-07:00");
    // London leaves summer time on 2026-10-25 at 01:00 UTC. Tokyo has none.
    expect(zonedIso("2026-10-25T00:59:59.000Z", "Europe/London")).toBe("2026-10-25T01:59:59.000+01:00");
    expect(zonedIso("2026-10-25T01:00:00.000Z", "Europe/London")).toBe("2026-10-25T01:00:00.000+00:00");
    expect(zonedIso("2026-11-05T17:00:00.000Z", "Asia/Tokyo")).toBe("2026-11-06T02:00:00.000+09:00");
  });

  it("shows the chat's times in the zone set now, so a change of zone moves them", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    const agent = agentFor(app, sequence(reply(message("Hi."))));
    await say(agent, app, "Hello");
    expect(agent.chat().messages[0]!.createdAt).toBe("2026-11-05T10:00:00.000-07:00");
    useZone(app.store, "Asia/Tokyo");
    expect(agent.chat().messages[0]!.createdAt).toBe("2026-11-06T02:00:00.000+09:00");
  });
});
