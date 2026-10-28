// Prints the chat recording key for a request file (0007, G10). The file
// holds a whole Responses API request body. The key is the first 16 hex
// digits of the SHA-256 of its canonical model, effort, tool choice,
// instructions, tools and input, without encrypted reasoning. A recording
// for that request lives in fixtures/recordings/chat/<key>.json.
//
//   pnpm recording:key <request.json>
import { readFileSync } from "node:fs";
import path from "node:path";
import { chatRecordingKey } from "../src/agent/recorded.ts";
import type { KeyedRequest } from "../src/agent/recorded.ts";

export function keyForFile(file: string): string {
  const body = JSON.parse(readFileSync(file, "utf8")) as Partial<KeyedRequest> | null;
  if (
    !body ||
    typeof body.model !== "string" ||
    typeof body.reasoning?.effort !== "string" ||
    typeof body.tool_choice !== "string" ||
    typeof body.instructions !== "string" ||
    !Array.isArray(body.tools) ||
    !Array.isArray(body.input)
  ) {
    throw new Error("The file must hold a whole request body: model, reasoning.effort, tool_choice, instructions, tools and input.");
  }
  return chatRecordingKey(body as KeyedRequest);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv.slice(2).find((a) => a !== "--");
  if (!file) {
    console.error("Usage: pnpm recording:key <request.json>");
    process.exitCode = 2;
  } else {
    try {
      console.log(keyForFile(path.resolve(process.cwd(), file)));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  }
}
