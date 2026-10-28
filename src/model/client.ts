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
  // The API's error type and code, when it sent them. Short identifiers
  // only, never message text, so they are safe to log.
  readonly errorType: string | null;
  readonly errorCode: string | null;
  // The request field the API named, such as "tools", when it named one.
  readonly errorParam: string | null;
  // A fixed sentence written by code for the person, such as how to sign
  // in again (0010). Null when the generic sentence fits. Never holds a
  // key, a token or response text.
  readonly userText: string | null;

  constructor(
    message: string,
    status: number | null = null,
    latencyMs = 0,
    error: { type?: string | null; code?: string | null; param?: string | null } = {},
    userText: string | null = null,
  ) {
    super(message);
    this.status = status;
    this.latencyMs = latencyMs;
    this.errorType = identifier(error.type);
    this.errorCode = identifier(error.code);
    this.errorParam = identifier(error.param);
    this.userText = userText;
  }
}

// API error types, codes and params are lower-case identifiers such as
// invalid_request_error or text.format. Anything else, such as mixed-case
// text that could be an echoed key, is dropped.
const identifier = (v: unknown): string | null => (typeof v === "string" && /^[a-z][a-z0-9_.:-]{0,63}$/.test(v) ? v : null);

// The error type and code from an API error body or stream event, such as
// { "error": { "type": "invalid_request_error", "code": "..." } }.
export function apiError(json: unknown): { type: string | null; code: string | null; param: string | null } {
  const o = (json ?? {}) as Record<string, unknown>;
  const inner = (o.error ?? (o.response as Record<string, unknown> | undefined)?.error ?? o) as Record<string, unknown> | null;
  return { type: identifier(inner?.type), code: identifier(inner?.code ?? o.code), param: identifier(inner?.param ?? o.param) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";

export type LiveClientOptions = {
  apiKey: string;
  url?: string;
  timeoutMs?: number;
};

// Calls the Meta Model API. The key stays in this object and is never logged.
// Error messages carry the HTTP status and the API's error type and code,
// checked as short identifiers. Never body text, which could echo a key,
// and never request headers. Extraction stores the message in the event log.
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
    if (!res.ok) throw httpError(res.status, latencyMs, apiError(parseJson(raw)));
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
      throw httpError(res.status, elapsed(started), apiError(parseJson(raw)));
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
          const err = apiError(parseJson(event.data));
          throw new ModelCallError(`Model stream ended with ${event.event}.`, res.status, elapsed(started), { type: err.type ?? event.event, code: err.code });
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

// A failed HTTP call, described by its status and identifiers only.
function httpError(status: number, latencyMs: number, error: { type: string | null; code: string | null; param: string | null }): ModelCallError {
  const err = new ModelCallError("", status, latencyMs, error);
  const ids = [err.errorType && `type ${err.errorType}`, err.errorCode && `code ${err.errorCode}`].filter(Boolean).join(", ");
  err.message = `Model call returned HTTP ${status}${ids ? ` (${ids})` : ""}.`;
  return err;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
