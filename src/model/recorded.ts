// A model client that replays hand-written responses from files. Recordings
// are keyed by message id and effort level:
//   fixtures/recordings/<effort>/<message id>.json
// Attempt N of a call returns the recording's Nth attempt, or its last one.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Effort } from "../domain/claim.ts";
import { RECORDINGS_DIR } from "../paths.ts";
import { ModelCallError, assertAllowedModel, type ModelCall, type ModelClient, type ModelReply } from "./client.ts";
import { parseResponseBody } from "./request.ts";

const RecordedUsage = z
  .object({
    input: z.number().int().nonnegative(),
    cached_input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
  })
  .strict();

// `output` is serialized to JSON. `output_text` is used as is, for faults
// such as text that is not JSON. `error` replays a failed HTTP call.
const RecordedAttempt = z
  .object({
    output: z.unknown().optional(),
    output_text: z.string().optional(),
    error: z.object({ status: z.number().int(), message: z.string() }).strict().optional(),
    usage: RecordedUsage,
    latency_ms: z.number().int().nonnegative(),
  })
  .strict()
  .refine((a) => [a.output, a.output_text, a.error].filter((x) => x !== undefined).length === 1, {
    message: "An attempt has exactly one of output, output_text or error.",
  });

export const Recording = z
  .object({
    message_id: z.string().min(1),
    effort: z.union([Effort, z.literal("any")]),
    note: z.string().optional(),
    attempts: z.array(RecordedAttempt).min(1),
  })
  .strict();
export type Recording = z.infer<typeof Recording>;

export function readRecording(file: string): Recording {
  return Recording.parse(JSON.parse(readFileSync(file, "utf8")));
}

export type RecordingLookup = (messageId: string, effort: Effort) => Recording | undefined;

export class RecordedModelClient implements ModelClient {
  readonly label: string;
  readonly #lookup: RecordingLookup;
  readonly calls: ModelCall[] = [];

  constructor(lookup: RecordingLookup, label = "recorded") {
    this.#lookup = lookup;
    this.label = label;
  }

  static fromDirectory(dir: string = RECORDINGS_DIR): RecordedModelClient {
    return new RecordedModelClient((messageId, effort) => {
      if (!/^[A-Za-z0-9_-]+$/.test(messageId)) return undefined;
      const file = path.join(dir, effort, `${messageId}.json`);
      return existsSync(file) ? readRecording(file) : undefined;
    });
  }

  // Replays the given recordings first and falls back to `base` for the rest.
  static withOverrides(overrides: Recording[], base?: RecordedModelClient): RecordedModelClient {
    return new RecordedModelClient((messageId, effort) => {
      const hit = overrides.find((r) => r.message_id === messageId && (r.effort === "any" || r.effort === effort));
      return hit ?? base?.lookup(messageId, effort);
    }, "recorded-overrides");
  }

  lookup(messageId: string, effort: Effort): Recording | undefined {
    return this.#lookup(messageId, effort);
  }

  async call(request: ModelCall): Promise<ModelReply> {
    assertAllowedModel(request.body.model);
    this.calls.push(request);
    const recording = this.#lookup(request.messageId, request.effort);
    if (!recording) {
      throw new ModelCallError(`No recording for message ${request.messageId} at effort ${request.effort}.`);
    }
    const attempt = recording.attempts[Math.min(request.attempt, recording.attempts.length) - 1]!;
    if (attempt.error) throw new ModelCallError(attempt.error.message, attempt.error.status, attempt.latency_ms);
    const text = attempt.output_text ?? JSON.stringify(attempt.output);
    // Build a Responses API body so replies go through the live parsing path.
    const body = {
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: {
        input_tokens: attempt.usage.input,
        input_tokens_details: { cached_tokens: attempt.usage.cached_input },
        output_tokens: attempt.usage.output,
        output_tokens_details: { reasoning_tokens: attempt.usage.reasoning },
      },
    };
    return { ...parseResponseBody(body), latencyMs: attempt.latency_ms };
  }
}
