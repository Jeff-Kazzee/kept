// Prints the chat recording key for a request file (0007, G10). The file
// holds a Responses API request body, or only its input array. The key is
// the first 16 hex digits of the SHA-256 of the canonical input, without
// encrypted reasoning. A recording for that request lives in
// fixtures/recordings/chat/<key>.json.
//
//   pnpm recording:key <request.json>
import { readFileSync } from "node:fs";
import path from "node:path";
import { chatRecordingKey } from "../src/agent/recorded.ts";
import type { InputItem } from "../src/model/responses.ts";

export function keyForFile(file: string): string {
  const json = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const input = Array.isArray(json) ? json : (json as { input?: unknown } | null)?.input;
  if (!Array.isArray(input)) throw new Error("The file holds no input array.");
  return chatRecordingKey(input as InputItem[]);
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
