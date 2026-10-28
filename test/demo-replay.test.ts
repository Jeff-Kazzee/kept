// SP12.3: the recorded mode answers "Try the demo" with no key. The chat
// recording key leaves out the clock's values in tool results, so a
// recording made on one day replays on another. --record-chat records only
// the agent's calls live, with the other calls replayed, so its recordings
// replay in the recorded app. The committed recordings play the whole demo
// story with no network.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_RECORDINGS_DIR, ChatRecording, RecordedChatClient, chatRecordingKey } from "../src/agent/recorded.ts";
import { functionTools } from "../src/agent/tools.ts";
import { main } from "../src/eval/cli.ts";
import { loadChatScripts, runChatEval, type ChatEvalReport } from "../src/eval/chat-eval.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { buildToolRequest, type InputItem } from "../src/model/responses.ts";
import { appEnv, parseEvents } from "../scripts/demo-check.ts";
import { PLACEHOLDER_NOTE } from "../scripts/demo-recordings.ts";
import { scriptModel } from "./script-model.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), "demo-replay-"));
  dirs.push(d);
  return d;
};

// The demo story on another day than the one it was recorded on.
const demoStory = (now: string) => loadChatScripts().filter((s) => s.id === "demo-story").map((s) => ({ ...s, now }));

function expectWholeDemo(report: ChatEvalReport) {
  const s = report.scripts[0]!;
  expect(s.runsCompleted).toBe(1);
  expect(s.turns).toBe(8);
  expect(s.modelUnavailable).toBe(0);
  expect(s.replacedAnswers).toBe(0);
  expect(s.toolsMatched).toBe(s.turns);
  expect(s.actionsMatched).toBe(s.turns);
  expect(s.cardsMatched).toBe(s.turns);
  expect(s.errorsMatched).toBe(s.turns);
  expect(s.skippedActions).toEqual([]);
  expect(report.personOnlyChanges).toBe(0);
  expect(report.unsupportedStates).toBe(0);
}

describe("SP12.3: the recorded demo", () => {
  it("the key reads the turn's date and the clock's times in tool results as placeholders, and nothing else", () => {
    const tools = functionTools();
    const out = (o: unknown): InputItem => ({ type: "function_call_output", call_id: "call_1", output: JSON.stringify(o) });
    const body = (o: unknown) =>
      buildToolRequest({ model: "muse-spark-1.3", effort: "low", instructions: "x", tools, input: [{ role: "user", content: "Hi" }, out(o)] });
    const base = { today: { date: "2026-11-05", label: "Thursday 11/5" }, source: { received_at: "2026-11-05T10:00:00.000-07:00" }, slot_key: "2026-11-16T13:00" };
    const key = chatRecordingKey(body(base));
    expect(chatRecordingKey(body({ ...base, today: { date: "2027-01-20", label: "Wednesday 1/20" } }))).toBe(key);
    expect(chatRecordingKey(body({ ...base, source: { received_at: "2027-01-20T08:13:07Z" } }))).toBe(key);
    // A slot, a date or a time that is not the clock's still changes the key.
    expect(chatRecordingKey(body({ ...base, slot_key: "2026-11-16T14:00" }))).not.toBe(key);
    expect(chatRecordingKey(body({ ...base, source: { received_at: "2026-11-05" } }))).not.toBe(key);
    // The person's words are never read as the clock.
    const said = (content: string) => chatRecordingKey(buildToolRequest({ model: "muse-spark-1.3", effort: "low", instructions: "x", tools, input: [{ role: "user", content }] }));
    expect(said("2026-11-05T10:00:00Z")).not.toBe(said("2027-01-20T08:13:07Z"));
  });

  it("the committed recordings play the whole demo story, on a day other than the one they were made on, with no network", async () => {
    const report = await runChatEval({
      chatClient: RecordedChatClient.fromDirectory(),
      client: RecordedModelClient.fromDirectory(),
      scripts: demoStory("2026-12-21T16:42:13.000Z"),
      runs: 1,
      maxUsd: 1,
    });
    expectWholeDemo(report);
    const texts = report.scripts[0]!.turnsDetail.map((t) => t.text);
    expect(texts.at(-1)).toMatch(/insurance card/i);
  });

  it("every keyed recording is a live answer or a placeholder that says so", () => {
    const files = readdirSync(CHAT_RECORDINGS_DIR).filter((f) => /^[0-9a-f]{16}\.json$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const rec = ChatRecording.parse(JSON.parse(readFileSync(path.join(CHAT_RECORDINGS_DIR, f), "utf8")));
      if (rec.source === "hand-written") expect(rec.note, f).toBe(PLACEHOLDER_NOTE);
    }
  });

  it("--record-chat records the agent's calls with the other calls replayed, and the recordings replay in a later run", async () => {
    const dir = tempDir();
    const out = path.join(tempDir(), "report.json");
    const lines: string[] = [];
    const code = await main(["--chat", "--record-chat", "--chat-runs", "1", "--chat-script", "demo-story", "--out", out], { MODEL_API_KEY: "test-key" }, {
      // Extraction and the other calls must not go to the live client.
      createClient: () => {
        throw new Error("--record-chat called the live client for extraction.");
      },
      createChatClient: () => scriptModel(),
      chatRecordingsDir: dir,
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/Recorded \d+ chat replies/);
    expect(readdirSync(dir).length).toBeGreaterThan(8);
    const replay = await runChatEval({
      chatClient: RecordedChatClient.fromDirectory(dir),
      client: RecordedModelClient.fromDirectory(),
      scripts: demoStory("2026-11-20T09:13:07.000Z"),
      runs: 1,
      maxUsd: 1,
    });
    expectWholeDemo(replay);
  });

  it("demo:check starts the app with no key or Google client in recorded mode, and reads the chat's event stream", () => {
    const base = { PATH: "/bin", MODEL_API_KEY: "k-123", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", APP_LIVE_MODEL: "1", APP_ALLOWED_HOSTS: "x", APP_DB: "data/app.sqlite" };
    expect(appEnv(base, 5193, "/tmp/x/app.sqlite", false)).toEqual({ PATH: "/bin", APP_PORT: "5193", APP_DB: "/tmp/x/app.sqlite" });
    expect(appEnv(base, 5193, "/tmp/x/app.sqlite", true)).toEqual({ PATH: "/bin", APP_PORT: "5193", APP_DB: "/tmp/x/app.sqlite", APP_LIVE_MODEL: "1", MODEL_API_KEY: "k-123" });
    const body = 'event: turn.started\ndata: {"turnId":"t1","userMessageId":"cm1"}\n\nevent: text.delta\ndata: {"turnId":"t1","text":"Hi"}\n\n';
    expect(parseEvents(body)).toEqual([
      { event: "turn.started", data: { turnId: "t1", userMessageId: "cm1" } },
      { event: "text.delta", data: { turnId: "t1", text: "Hi" } },
    ]);
  });
});
