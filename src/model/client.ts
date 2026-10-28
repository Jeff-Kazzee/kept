// The model client interface. Extraction depends only on this interface, so
// a fallback host can replace the Meta endpoint later without other changes.
import type { Effort } from "../domain/claim.ts";
import { assertAllowedModel, parseResponseBody, type ResponsesRequestBody, type TokenUsage } from "./request.ts";
import { meterAdd, meterCheck } from "./meter.ts";
import { readCompletedBody, readSse, type ToolCall, type ToolModelClient, type ToolReply } from "./responses.ts";

export { assertAllowedModel };

export type ModelCall = {
  // Names the call for recordings and logs. For extraction it is the message
  // id. For conflict calls it is a key such as explain-<conflict id>.
  key: string;
  attempt: number; // 1 for the first call, 2 for the one retry
  effort: Effort;
  body: ResponsesRequestBody;
};

export type ModelReply = {
  outputText: string;
  usage: TokenUsage;
  latencyMs: number;
};

export interface ModelClient {
  readonly label: string;
  call(request: ModelCall): Promise<ModelReply>;
}

export class ModelCallError extends Error {
  override name = "ModelCallError";
  readonly status: number | null;
  readonly latencyMs: number;

  constructor(message: string, status: number | null = null, latencyMs = 0) {
    super(message);
    this.status = status;
    this.latencyMs = latencyMs;
  }
}

export const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";

export type LiveClientOptions = {
  apiKey: string;
  url?: string;
  timeoutMs?: number;
};

// Calls the Meta Model API. The key stays in this object and is never logged.
// Error messages carry the HTTP status and a short slice of the body, never
// request headers.
export class MetaResponsesClient implements ModelClient, ToolModelClient {
  readonly label = "meta-responses";
  readonly #apiKey: string;
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(options: LiveClientOptions) {
    if (!options.apiKey) throw new Error("MODEL_API_KEY is not set.");
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? META_RESPONSES_URL;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async call(request: ModelCall): Promise<ModelReply> {
    assertAllowedModel(request.body.model);
    if (request.body.store !== false) throw new Error("Requests must set store: false.");
    meterCheck();
    const reply = await this.#call(request);
    meterAdd(reply.usage);
    return reply;
  }

  async #call(request: ModelCall): Promise<ModelReply> {
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(this.#url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.name : "unknown";
      throw new ModelCallError(`Model call failed before a response (${reason}).`, null, elapsed(started));
    }
    const raw = await res.text();
    const latencyMs = elapsed(started);
    if (!res.ok) throw new ModelCallError(`Model call returned HTTP ${res.status}: ${raw.slice(0, 200)}`, res.status, latencyMs);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ModelCallError("Model response body was not JSON.", res.status, latencyMs);
    }
    return { ...parseResponseBody(json), latencyMs };
  }

  // A tool turn for the case agent (0007, G1). With stream: true it reads
  // the server-sent events and takes the output and usage from
  // response.completed. Text deltas are not passed on: the agent checks the
  // whole answer before the user sees any of it (G4).
  async respond(request: ToolCall): Promise<ToolReply> {
    assertAllowedModel(request.body.model);
    if (request.body.store !== false) throw new Error("Requests must set store: false.");
    meterCheck();
    const reply = await this.#respond(request);
    meterAdd(reply.usage);
    return reply;
  }

  async #respond(request: ToolCall): Promise<ToolReply> {
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(this.#url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          Accept: request.body.stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.name : "unknown";
      throw new ModelCallError(`Model call failed before a response (${reason}).`, null, elapsed(started));
    }
    if (!res.ok) {
      const raw = await res.text();
      throw new ModelCallError(`Model call returned HTTP ${res.status}: ${raw.slice(0, 200)}`, res.status, elapsed(started));
    }
    if (!request.body.stream) {
      let json: unknown;
      try {
        json = JSON.parse(await res.text());
      } catch {
        throw new ModelCallError("Model response body was not JSON.", res.status, elapsed(started));
      }
      return { ...readCompletedBody(json), latencyMs: elapsed(started), firstByteMs: null };
    }
    if (!res.body) throw new ModelCallError("Model response had no body.", res.status, elapsed(started));
    let firstByteMs: number | null = null;
    try {
      for await (const event of readSse(res.body)) {
        firstByteMs ??= elapsed(started);
        if (event.event === "response.completed") {
          const data = JSON.parse(event.data) as { response?: unknown };
          return { ...readCompletedBody(data.response), latencyMs: elapsed(started), firstByteMs };
        }
        if (event.event === "response.failed" || event.event === "response.incomplete" || event.event === "error") {
          throw new ModelCallError(`Model stream ended with ${event.event}.`, res.status, elapsed(started));
        }
      }
    } catch (err) {
      if (err instanceof ModelCallError) throw err;
      const reason = err instanceof Error ? err.name : "unknown";
      throw new ModelCallError(`Model stream could not be read (${reason}).`, res.status, elapsed(started));
    }
    throw new ModelCallError("Model stream ended before response.completed.", res.status, elapsed(started));
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
