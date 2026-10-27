// The model client interface. Extraction depends only on this interface, so
// a fallback host can replace the Meta endpoint later without other changes.
import type { Effort } from "../domain/claim.ts";
import { assertAllowedModel, parseResponseBody, type ResponsesRequestBody, type TokenUsage } from "./request.ts";

export { assertAllowedModel };

export type ModelCall = {
  messageId: string;
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
export class MetaResponsesClient implements ModelClient {
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
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
