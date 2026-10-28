// Recorded chat clients (0007, G10). A recording holds one model reply to
// one tool request, keyed by a hash of the request's input, so tests and
// the recorded app replay chat turns with no network:
//   fixtures/recordings/chat/<key>.json            live answers, recorded
//                                                  only by the coordinator's
//                                                  live runs (--record-chat)
//   fixtures/recordings/chat/faults/<name>.json    hand-written faults, each
//                                                  a sequence of replies
// `pnpm recording:key <request file>` prints the key for a request body.
// The key covers the model, effort, tool choice, instructions, tools and
// input, so a recording answers only the request it was made for.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { corpusMessages, loadScenarios } from "../fixtures/load.ts";
import { normalizeWhitespace } from "../domain/quote.ts";
import { ModelCallError } from "../model/client.ts";
import { assertAllowedModel } from "../model/request.ts";
import { meterAdd, meterCheck } from "../model/meter.ts";
import { OutputItem, type ToolCall, type ToolModelClient, type ToolReply, type ToolRequestBody } from "../model/responses.ts";
import { RECORDINGS_DIR } from "../paths.ts";

export const CHAT_RECORDINGS_DIR = path.join(RECORDINGS_DIR, "chat");
export const CHAT_FAULTS_DIR = path.join(CHAT_RECORDINGS_DIR, "faults");

// Encrypted reasoning stays inside one turn (G1). Recordings never store
// it, and the key leaves it out, so a replayed turn finds its recordings.
const NOT_KEYED = new Set(["encrypted_content"]);

// Keys sorted, so the same input always gives the same text.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k, v]) => v !== undefined && !NOT_KEYED.has(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// The parts of a request that decide the answer.
export type KeyedRequest = Pick<ToolRequestBody, "model" | "reasoning" | "tool_choice" | "instructions" | "tools" | "input">;

// SP12.3: the clock's values in tool results. A tool result gives the
// turn's date (`today`) and the time code read the clock, such as an
// imported message's received_at. They change with the day the demo runs,
// so the key reads each as a fixed placeholder, and a recording made on one
// day replays on another. Code still checks each replayed answer against
// the turn's facts, so an answer that names a date from the recording day
// is replaced.
const CLOCK_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function withoutClock(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutClock);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, k === "today" ? "<today>" : withoutClock(v)]));
  }
  return typeof value === "string" && CLOCK_TIME.test(value) ? "<time>" : value;
}

// An input item as the key reads it: a tool result without the clock.
function keyedItem(item: unknown): unknown {
  const it = item as { type?: unknown; output?: unknown };
  if (it?.type !== "function_call_output" || typeof it.output !== "string") return item;
  try {
    return { ...it, output: withoutClock(JSON.parse(it.output)) };
  } catch {
    return item;
  }
}

// The recording key: the first 16 hex digits of the SHA-256 of the
// request's model, effort, tool choice, instructions, tool schemas and
// input, written canonically without encrypted reasoning and without the
// clock's values in tool results. A recording made at one effort, or with
// other instructions or tools, never answers another request (sprint 7A
// review, finding 13).
export function chatRecordingKey(body: KeyedRequest): string {
  const keyed = {
    model: body.model,
    effort: body.reasoning.effort,
    tool_choice: body.tool_choice,
    instructions: body.instructions,
    tools: body.tools,
    input: body.input.map(keyedItem),
  };
  return createHash("sha256").update(canonical(keyed)).digest("hex").slice(0, 16);
}

const Usage = z
  .object({
    input: z.number().int().nonnegative(),
    cached_input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
  })
  .strict();

export const ChatReply = z
  .object({
    output: z.array(OutputItem).optional(),
    error: z
      .object({ status: z.number().int().nullable(), message: z.string(), type: z.string().optional(), code: z.string().optional() })
      .strict()
      .optional(),
    usage: Usage,
    latency_ms: z.number().int().nonnegative(),
    first_byte_ms: z.number().int().nonnegative().nullable().optional(),
  })
  .strict()
  .refine((r) => (r.output === undefined) !== (r.error === undefined), { message: "A reply has exactly one of output or error." });
export type ChatReply = z.infer<typeof ChatReply>;

export const ChatRecording = z
  .object({
    key: z.string().regex(/^[0-9a-f]{16}$/),
    source: z.enum(["live", "hand-written"]),
    note: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    recorded_at: z.string().optional(),
    reply: ChatReply,
  })
  .strict();
export type ChatRecording = z.infer<typeof ChatRecording>;

// A hand-written fault: replies given in order, whatever the request.
export const ChatFault = z
  .object({
    source: z.literal("hand-written"),
    note: z.string(),
    replies: z.array(ChatReply).min(1),
  })
  .strict();
export type ChatFault = z.infer<typeof ChatFault>;

export function readChatFault(name: string, dir: string = CHAT_FAULTS_DIR): ChatFault {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Bad fault name.");
  return ChatFault.parse(JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8")));
}

function toReply(r: ChatReply): ToolReply {
  if (r.error) throw new ModelCallError(r.error.message, r.error.status, r.latency_ms, { type: r.error.type, code: r.error.code });
  return {
    output: structuredClone(r.output!) as ToolReply["output"],
    usage: { input: r.usage.input, cachedInput: r.usage.cached_input, output: r.usage.output, reasoning: r.usage.reasoning },
    latencyMs: r.latency_ms,
    firstByteMs: r.first_byte_ms ?? null,
  };
}

export class RecordedChatClient implements ToolModelClient {
  readonly label: string;
  readonly calls: ToolCall[] = [];
  readonly #next: (request: ToolCall) => ChatReply | undefined;

  constructor(next: (request: ToolCall) => ChatReply | undefined, label = "recorded-chat") {
    this.#next = next;
    this.label = label;
  }

  // Replays recordings from `dir` by key. A request with no recording fails
  // like a model call that got no answer.
  static fromDirectory(dir: string = CHAT_RECORDINGS_DIR): RecordedChatClient {
    return new RecordedChatClient((request) => {
      const file = path.join(dir, `${chatRecordingKey(request.body)}.json`);
      return existsSync(file) ? ChatRecording.parse(JSON.parse(readFileSync(file, "utf8"))).reply : undefined;
    });
  }

  // Replays replies in order, whatever the request. For hand-written faults
  // and test scripts.
  static sequence(replies: ChatReply[], label = "recorded-chat-sequence"): RecordedChatClient {
    const queue = [...replies];
    return new RecordedChatClient(() => queue.shift(), label);
  }

  async respond(request: ToolCall): Promise<ToolReply> {
    assertAllowedModel(request.body.model);
    if (request.body.store !== false) throw new Error("Requests must set store: false.");
    meterCheck();
    this.calls.push(structuredClone(request));
    const reply = this.#next(request);
    if (!reply) throw new ModelCallError(`No chat recording for ${request.key}.`);
    const out = toReply(reply);
    meterAdd(out.usage);
    return out;
  }
}

// Wraps a live client and writes each reply as a recording. Only the
// coordinator's live runs use it.
export class RecordingChatClient implements ToolModelClient {
  readonly label: string;
  readonly #inner: ToolModelClient;
  readonly #dir: string;
  readonly #now: () => string;
  readonly #source: ChatRecording["source"];
  readonly #note: string | undefined;
  written = 0;

  // `source` is "hand-written" when `inner` is a scripted stand-in, never
  // the live model.
  constructor(
    inner: ToolModelClient,
    dir: string = CHAT_RECORDINGS_DIR,
    now: () => string = () => new Date().toISOString(),
    options: { source?: ChatRecording["source"]; note?: string } = {},
  ) {
    this.#inner = inner;
    this.#dir = dir;
    this.#now = now;
    this.#source = options.source ?? "live";
    this.#note = options.note;
    this.label = `${inner.label}+recording`;
  }

  async respond(request: ToolCall): Promise<ToolReply> {
    const reply = await this.#inner.respond(request);
    const key = chatRecordingKey(request.body);
    const recording: ChatRecording = {
      key,
      source: this.#source,
      ...(this.#note ? { note: this.#note } : {}),
      model: request.body.model,
      effort: request.effort,
      recorded_at: this.#now(),
      reply: {
        output: reply.output.map(({ encrypted_content: _drop, ...item }) => item),
        usage: { input: reply.usage.input, cached_input: reply.usage.cachedInput, output: reply.usage.output, reasoning: reply.usage.reasoning },
        latency_ms: reply.latencyMs,
        first_byte_ms: reply.firstByteMs,
      },
    };
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(path.join(this.#dir, `${key}.json`), JSON.stringify(recording, null, 2) + "\n");
    this.written++;
    return reply;
  }
}

// In recorded mode, a pasted fixture message keeps its fixture id, so its
// extraction recording replays. Other text gets the default id.
export function fixtureMessageIds(fallback: (text: string) => string): (text: string) => string {
  const byText = new Map(corpusMessages(loadScenarios()).map((m) => [normalizeWhitespace(m.text), m.id]));
  return (text) => byText.get(normalizeWhitespace(text)) ?? fallback(text);
}
