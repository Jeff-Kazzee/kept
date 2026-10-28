// Tool calls and streaming on the Responses API, for the case agent (0007,
// G1). A request sets store: false, carries function tools and asks for the
// encrypted reasoning items, so a turn can hand them back on its next call
// without the server keeping anything. Those items stay inside one turn and
// are never stored. Shared by the live and recorded chat clients so both
// read output the same way.
import { z } from "zod";
import type { Effort } from "../domain/claim.ts";
import { assertAllowedModel, parseResponseBody, type TokenUsage } from "./request.ts";

export type FunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: object;
  strict: false;
};

// One input item. Earlier output items go back as they came. Code adds
// plain messages and function call outputs.
export type InputItem =
  | { role: "user" | "assistant" | "developer"; content: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | OutputItem;

export type ToolRequestBody = {
  model: string;
  store: false;
  stream: boolean;
  reasoning: { effort: Effort };
  include: ["reasoning.encrypted_content"];
  instructions: string;
  input: InputItem[];
  tools: FunctionTool[];
  tool_choice: "auto" | "none";
  parallel_tool_calls: false;
};

export function buildToolRequest(options: {
  model: string;
  effort: Effort;
  instructions: string;
  input: InputItem[];
  tools: FunctionTool[];
  toolChoice?: "auto" | "none";
  stream?: boolean;
}): ToolRequestBody {
  assertAllowedModel(options.model);
  return {
    model: options.model,
    store: false,
    stream: options.stream ?? true,
    reasoning: { effort: options.effort },
    include: ["reasoning.encrypted_content"],
    instructions: options.instructions,
    input: options.input,
    tools: options.tools,
    tool_choice: options.toolChoice ?? "auto",
    parallel_tool_calls: false,
  };
}

// Output items. Unknown fields pass through, because they go back to the
// API unchanged on the next call of the turn.
export const FunctionCallItem = z.looseObject({
  type: z.literal("function_call"),
  call_id: z.string().min(1),
  name: z.string(),
  arguments: z.string(),
});
export type FunctionCallItem = z.infer<typeof FunctionCallItem>;

export const MessageItem = z.looseObject({
  type: z.literal("message"),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional().default([]),
});

export const OutputItem = z.looseObject({ type: z.string() });
export type OutputItem = z.infer<typeof OutputItem> & Record<string, unknown>;

export type ToolCall = {
  // Names the call for recordings and logs, such as chat-<turn>-<n>.
  key: string;
  effort: Effort;
  body: ToolRequestBody;
};

export type ToolReply = {
  output: OutputItem[];
  usage: TokenUsage;
  latencyMs: number;
  // Time to the first streamed byte, when the call streamed.
  firstByteMs: number | null;
};

// A model client that can run a tool turn. The live client and the
// recorded chat clients implement it.
export interface ToolModelClient {
  readonly label: string;
  respond(request: ToolCall): Promise<ToolReply>;
}

// The text of every assistant message in the output, joined.
export function outputText(output: OutputItem[]): string {
  return output
    .flatMap((item) => {
      const m = MessageItem.safeParse(item);
      return m.success ? m.data.content : [];
    })
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

export function functionCalls(output: OutputItem[]): Array<FunctionCallItem | { malformed: true; item: OutputItem }> {
  return output
    .filter((item) => item.type === "function_call")
    .map((item) => {
      const parsed = FunctionCallItem.safeParse(item);
      return parsed.success ? parsed.data : { malformed: true as const, item };
    });
}

export function parseUsage(usage: unknown): TokenUsage {
  return parseResponseBody({ output: [], usage }).usage;
}

// A completed Responses API body, as a non-streaming call or the
// response.completed event returns it.
const CompletedBody = z.looseObject({ output: z.array(OutputItem).optional().default([]), usage: z.unknown().optional() });

export function readCompletedBody(body: unknown): { output: OutputItem[]; usage: TokenUsage } {
  const parsed = CompletedBody.parse(body);
  return { output: parsed.output as OutputItem[], usage: parseUsage(parsed.usage ?? {}) };
}

export type SseEvent = { event: string; data: string };

// Splits a server-sent event stream into events. Lines that start with a
// colon are comments. A blank line ends an event.
export async function* readSse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  const flushLine = function* (line: string): Generator<SseEvent> {
    if (line === "") {
      if (data.length > 0) yield { event, data: data.join("\n") };
      event = "message";
      data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
      yield* flushLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") yield* flushLine(buffer);
  yield* flushLine("");
}
