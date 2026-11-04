// The DeepSeek client for the operator's fallback (0024). DeepSeek serves
// the Responses API format at the address below, with the same function
// calls, server-sent events and usage fields as Meta's, so the Meta client
// carries the call and every error sentence stays the same. Unsupported
// fields such as `store` and `include` are ignored there.
//
// What it changes on the way out:
//
// - `model` is the fallback model (models.ts).
// - Thinking is off. With it on, a request with tools must hand back the
//   reasoning of every earlier turn, or DeepSeek answers 400, and the
//   chat's history is plain text. It also spares the reasoning tokens.
// - A JSON call also states its schema in the instructions. DeepSeek's JSON
//   mode needs the word JSON in the prompt, and its guides describe only
//   json_object output, so the words carry the shape as well as text.format.
//   The hold is taken before this, and a usage count beyond the hold is
//   charged the hold, so a charge still never exceeds it.
//
// What it changes on the way back: `call` names the model that answered, or
// failed, so attempt records do not credit the model the request names.
//
// The key stays in the inner client. It never moves a call anywhere else.
import { MetaResponsesClient, ModelCallError, type ModelCall, type ModelReply } from "../client.ts";
import type { ToolCall, ToolReply } from "../responses.ts";
import type { LiveClient } from "./factory.ts";
import { DEEPSEEK_MODEL } from "./models.ts";

export const DEEPSEEK_RESPONSES_URL = "https://api.deepseek.com/responses";

const JSON_ANSWER = "Answer with one JSON object and nothing else. It must match this JSON schema:";

type Body = { instructions: string; text?: { format?: { schema?: object } } };

export function deepSeekBody<T extends Body>(body: T): T {
  const schema = body.text?.format?.schema;
  return {
    ...body,
    model: DEEPSEEK_MODEL,
    reasoning: { effort: "none" },
    ...(schema ? { instructions: `${body.instructions} ${JSON_ANSWER} ${JSON.stringify(schema)}` } : {}),
  };
}

export class DeepSeekResponsesClient implements LiveClient {
  readonly label = "deepseek-responses";
  readonly #inner: MetaResponsesClient;

  constructor(options: { apiKey: string; url?: string; timeoutMs?: number }) {
    this.#inner = new MetaResponsesClient({ apiKey: options.apiKey, url: options.url ?? DEEPSEEK_RESPONSES_URL, timeoutMs: options.timeoutMs ?? 120_000 });
  }

  async call(request: ModelCall): Promise<ModelReply> {
    try {
      return { ...(await this.#inner.call({ ...request, body: deepSeekBody(request.body) })), model: DEEPSEEK_MODEL };
    } catch (err) {
      if (err instanceof ModelCallError) err.model = DEEPSEEK_MODEL;
      throw err;
    }
  }

  respond(request: ToolCall): Promise<ToolReply> {
    return this.#inner.respond({ ...request, body: deepSeekBody(request.body) });
  }
}
