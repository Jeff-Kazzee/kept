// Recorded chat turns (G10): keys, record and replay, faults and the
// recording:key command.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_FAULTS_DIR,
  CHAT_RECORDINGS_DIR,
  ChatFault,
  ChatRecording,
  RecordedChatClient,
  RecordingChatClient,
  chatRecordingKey,
  fixtureMessageIds,
} from "../src/agent/recorded.ts";
import { defaultMessageId, functionTools } from "../src/agent/tools.ts";
import { buildToolRequest, type InputItem } from "../src/model/responses.ts";
import { hasClinicalContent } from "../src/domain/scope.ts";
import { fromPackage } from "../src/paths.ts";
import { EventStore } from "../src/store/event-log.ts";
import { keyForFile } from "../scripts/recording-key.ts";
import { acceptMessages } from "./helpers.ts";
import { CLOCK, RuleModel, agentFor, currentUserText, fixtureMessage, fnCall, message, say, services, turnOutputs } from "./agent-helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), "chat-rec-"));
  dirs.push(d);
  return d;
};

const scheduleModel = () =>
  new RuleModel([
    (input) => (turnOutputs(input).length === 0 && /monday/i.test(currentUserText(input)) ? [fnCall("get_schedule", {}, "s1")] : undefined),
    (input) => (turnOutputs(input).length > 0 ? [message("Monday 11/16 1:00 PM is offered. It is not booked yet.")] : undefined),
  ]);

async function demoCase() {
  const app = services(new EventStore(":memory:", CLOCK));
  await acceptMessages(app.intake, ["m1", "m2", "m3"]);
  return app;
}

describe("G10: recorded chat turns", () => {
  it("keys a request by its model, effort, tool choice, instructions, tools and input, without encrypted reasoning", () => {
    const input: InputItem[] = [{ role: "user", content: "Hi" }, { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "AAA" }];
    const body = buildToolRequest({ model: "muse-spark-1.3", effort: "low", instructions: "x", input, tools: functionTools() });
    const reordered = JSON.parse(JSON.stringify({ ...body, input: [{ content: "Hi", role: "user" }, { encrypted_content: "BBB", summary: [], id: "rs_1", type: "reasoning" }] }));
    expect(chatRecordingKey(body)).toMatch(/^[0-9a-f]{16}$/);
    expect(chatRecordingKey(reordered)).toBe(chatRecordingKey(body));
    // Finding 13: each of these changes the key.
    const variants = [
      { ...body, input: [{ role: "user" as const, content: "Hi!" }] },
      { ...body, reasoning: { effort: "minimal" as const } },
      { ...body, model: "muse-spark-1.4" },
      { ...body, tool_choice: "none" as const },
      { ...body, instructions: "y" },
      { ...body, tools: functionTools().slice(1) },
    ];
    for (const v of variants) expect(chatRecordingKey(v)).not.toBe(chatRecordingKey(body));
    // Streaming does not change the answer, so it is not keyed.
    expect(chatRecordingKey({ ...body, stream: false } as typeof body)).toBe(chatRecordingKey(body));
  });

  it("a low-effort recording does not answer a minimal-effort turn", async () => {
    const dir = tempDir();
    const first = await demoCase();
    await say(agentFor(first, new RecordingChatClient(scheduleModel(), dir)), first, "Am I booked Monday?");
    const second = await demoCase();
    const r = await say(agentFor(second, RecordedChatClient.fromDirectory(dir), { effort: "minimal" }), second, "Am I booked Monday?");
    expect(r.of("turn.error").map((e) => e.code)).toEqual(["model_unavailable"]);
  });

  it("a recorded turn replays offline with the same events, and recordings keep no encrypted reasoning", async () => {
    const dir = tempDir();
    const live = new RecordingChatClient(scheduleModel(), dir, () => "2026-10-28T12:00:00.000Z");
    const first = await demoCase();
    const recorded = await say(agentFor(first, live), first, "Am I booked Monday?");
    expect(live.written).toBe(2);
    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    for (const f of files) {
      const rec = ChatRecording.parse(JSON.parse(readFileSync(path.join(dir, f), "utf8")));
      expect(rec).toMatchObject({ source: "live", model: "muse-spark-1.3", effort: "low" });
      expect(`${rec.key}.json`).toBe(f);
      expect(JSON.stringify(rec)).not.toContain("encrypted_content");
    }

    const second = await demoCase();
    const replay = RecordedChatClient.fromDirectory(dir);
    const replayed = await say(agentFor(second, replay), second, "Am I booked Monday?");
    expect(replayed.events).toEqual(recorded.events);
    expect(replay.calls).toHaveLength(2);
  });

  it("a request with no recording fails as model_unavailable", async () => {
    const app = await demoCase();
    const r = await say(agentFor(app, RecordedChatClient.fromDirectory(tempDir())), app, "Something new");
    expect(r.of("turn.error").map((e) => e.code)).toEqual(["model_unavailable"]);
  });

  it("no chat recording or fault holds clinical text", () => {
    const strings = (v: unknown): string[] =>
      typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
    const files = readdirSync(CHAT_RECORDINGS_DIR, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      const json = JSON.parse(readFileSync(path.join(CHAT_RECORDINGS_DIR, f), "utf8"));
      const replies = json.replies ?? [json.reply];
      for (const text of strings(replies.map((r: { output?: unknown }) => r.output))) expect(hasClinicalContent(text), `${f}: ${text}`).toBe(false);
    }
  });

  it("every fault and recording file in the repository parses", () => {
    const faults = readdirSync(CHAT_FAULTS_DIR).filter((f) => f.endsWith(".json"));
    expect(faults.length).toBeGreaterThanOrEqual(7);
    for (const f of faults) expect(() => ChatFault.parse(JSON.parse(readFileSync(path.join(CHAT_FAULTS_DIR, f), "utf8"))), f).not.toThrow();
    for (const f of readdirSync(CHAT_RECORDINGS_DIR).filter((x) => x.endsWith(".json"))) {
      const rec = ChatRecording.parse(JSON.parse(readFileSync(path.join(CHAT_RECORDINGS_DIR, f), "utf8")));
      expect(`${rec.key}.json`, f).toBe(f);
      expect(JSON.stringify(rec), f).not.toContain("encrypted_content");
    }
  });

  it("pnpm recording:key prints the key of a request file", () => {
    const dir = tempDir();
    const request = buildToolRequest({ model: "muse-spark-1.3", effort: "low", instructions: "x", input: [{ role: "user", content: "Am I booked Monday?" }], tools: functionTools() });
    const body = path.join(dir, "body.json");
    const bare = path.join(dir, "input.json");
    writeFileSync(body, JSON.stringify(request));
    writeFileSync(bare, JSON.stringify(request.input));
    expect(keyForFile(body)).toBe(chatRecordingKey(request));
    expect(() => keyForFile(bare)).toThrow(/whole request body/);
    const out = execFileSync(process.execPath, [fromPackage("scripts/recording-key.ts"), body], { encoding: "utf8" });
    expect(out.trim()).toBe(chatRecordingKey(request));
  });

  it("in recorded mode a pasted fixture message keeps its fixture id, so its extraction replays", () => {
    const ids = fixtureMessageIds(defaultMessageId);
    expect(ids(fixtureMessage("m1").text)).toBe("m1");
    expect(ids(`  ${fixtureMessage("m3").text.replace(/ /g, "\n")} `)).toBe("m3");
    expect(ids("Some other text")).toBe(defaultMessageId("Some other text"));
    expect(defaultMessageId("a  b")).toBe(defaultMessageId("a b"));
  });
});
