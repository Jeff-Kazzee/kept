// Hand-written placeholder recordings of the demo story (SP12.3), so the
// recorded app, `pnpm demo:check` and the tests answer "Try the demo" with
// no key before the coordinator's live recording exists. A stand-in model
// (test/script-model.ts) plays the chat script fixtures/chat/demo-story.json
// through the chat eval, with recorded extraction, and each of its replies
// is written to fixtures/recordings/chat/<key>.json with source
// "hand-written". Live recordings are never touched.
//
//   pnpm demo:recordings          replace the placeholders
//   pnpm demo:recordings --clear  remove the placeholders only, before a
//                                 live recording with --record-chat
import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { CHAT_RECORDINGS_DIR, ChatRecording, RecordingChatClient } from "../src/agent/recorded.ts";
import { formatChatSummary, loadChatScripts, runChatEval } from "../src/eval/chat-eval.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { scriptModel } from "../test/script-model.ts";

export const PLACEHOLDER_NOTE = "Placeholder for the demo story, written by a stand-in model, not a model. A live recording replaces it.";
const WRITTEN_AT = "2026-10-28T12:00:00.000Z";

// Removes the keyed recordings that are placeholders. Returns how many.
export function clearPlaceholders(dir: string = CHAT_RECORDINGS_DIR): number {
  let removed = 0;
  for (const f of readdirSync(dir).filter((x) => /^[0-9a-f]{16}\.json$/.test(x))) {
    const file = path.join(dir, f);
    const r = ChatRecording.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (r.success && r.data.source === "hand-written") {
      rmSync(file);
      removed++;
    }
  }
  return removed;
}

export async function writePlaceholders(dir: string = CHAT_RECORDINGS_DIR): Promise<{ written: number; ok: boolean; summary: string }> {
  clearPlaceholders(dir);
  const chat = new RecordingChatClient(scriptModel(), dir, () => WRITTEN_AT, { source: "hand-written", note: PLACEHOLDER_NOTE });
  const report = await runChatEval({
    chatClient: chat,
    client: RecordedModelClient.fromDirectory(),
    scripts: loadChatScripts().filter((s) => s.id === "demo-story"),
    runs: 1,
    maxUsd: 1,
    now: () => WRITTEN_AT,
  });
  const s = report.scripts[0]!;
  const ok = s.turns > 0 && s.toolsMatched === s.turns && s.actionsMatched === s.turns && s.cardsMatched === s.turns && s.replacedAnswers === 0 && s.skippedActions.length === 0;
  return { written: chat.written, ok, summary: formatChatSummary(report) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--clear")) {
    console.log(`Removed ${clearPlaceholders()} placeholder chat recordings.`);
  } else {
    const r = await writePlaceholders();
    console.log(r.summary);
    console.log(`Wrote ${r.written} placeholder chat recordings in fixtures/recordings/chat/.`);
    if (!r.ok) {
      console.error("The stand-in model did not play the demo story as expected.");
      process.exitCode = 1;
    }
  }
}
