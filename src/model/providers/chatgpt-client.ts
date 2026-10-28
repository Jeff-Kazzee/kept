// The OpenAI Responses client for the ChatGPT path (0010, design item 1).
// It takes the same requests as the Meta client and gives the same reply
// shapes, so extraction, explanations, questions, templates and the chat
// agent use it unchanged. What it changes on the way out, following the
// ChatGPT plan usage preview requirements:
//
// - `model` is the connection's model (models.ts), not the Meta model.
// - `store: false` and `stream: true` on every request. A JSON call reads
//   the stream to response.completed like a tool turn does.
// - A string `input` becomes one user message, as `input` must be an array.
// - Function tools go inside one namespace, as top-level function tools are
//   not accepted on this route. Function calls come back with that
//   namespace and their own name, and go back to the API as they came.
// - Reasoning effort `minimal` is sent as `low`.
//
// The access token stays in this object and the auth module. Errors carry
// the HTTP status and the documented error code, never response text.
import { ModelCallError, apiError, assertAllowedModel, type ModelCall, type ModelClient, type ModelReply } from "../client.ts";
import { meterAdd, meterCheck } from "../meter.ts";
import { outputText, readCompletedBody, readSse, type ToolCall, type ToolModelClient, type ToolReply } from "../responses.ts";
import { ChatGptAuthError, type ChatGptAuth } from "./chatgpt-auth.ts";
import {
  CHATGPT_SESSION_ENDED_TEXT,
  CHATGPT_SIGNED_OUT_TEXT,
  CHATGPT_UNAVAILABLE_TEXT,
  PLAN_USAGE_OFF_TEXT,
  SETTINGS_BUSY_TEXT,
  SETTINGS_FILE_TEXT,
  chatGptFailureText,
  providerError,
} from "./messages.ts";
import type { FetchLike } from "./oidc.ts";
import { SecretsBusyError, SecretsFileError } from "./secrets.ts";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const TOOL_NAMESPACE = "case_tools";
const TOOL_NAMESPACE_DESCRIPTION = "Tools that read and act on the user's appointment case in this app.";

// Request fields the preview does not accept. The app sends none of them
// today. They are removed so a later change cannot add one by accident.
const UNSUPPORTED_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

export function chatGptBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, model, store: false, stream: true };
  if (typeof body.input === "string") out.input = [{ role: "user", content: body.input }];
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = [{ type: "namespace", name: TOOL_NAMESPACE, description: TOOL_NAMESPACE_DESCRIPTION, tools: body.tools }];
  }
  const reasoning = body.reasoning as { effort?: string } | undefined;
  if (reasoning?.effort === "minimal") out.reasoning = { ...reasoning, effort: "low" };
  for (const field of UNSUPPORTED_FIELDS) delete out[field];
  return out;
}

const elapsed = (started: number) => Math.round(performance.now() - started);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function authFailure(err: ChatGptAuthError): ModelCallError {
  const text =
    err.kind === "signed_out"
      ? CHATGPT_SIGNED_OUT_TEXT
      : err.kind === "plan_usage_off"
        ? PLAN_USAGE_OFF_TEXT
        : err.kind === "session_ended"
          ? CHATGPT_SESSION_ENDED_TEXT
          : CHATGPT_UNAVAILABLE_TEXT;
  return providerError(text, { type: "chatgpt_auth", code: err.kind });
}

export class ChatGptResponsesClient implements ModelClient, ToolModelClient {
  readonly label = "chatgpt-responses";
  readonly #auth: ChatGptAuth;
  readonly #model: () => string;
  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: { auth: ChatGptAuth; model: () => string; url?: string; fetch?: FetchLike; timeoutMs?: number }) {
    this.#auth = options.auth;
    this.#model = options.model;
    this.#url = options.url ?? OPENAI_RESPONSES_URL;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  async call(request: ModelCall): Promise<ModelReply> {
    const reply = await this.#run(request.body as unknown as Record<string, unknown>);
    return { outputText: outputText(reply.output), usage: reply.usage, latencyMs: reply.latencyMs };
  }

  async respond(request: ToolCall): Promise<ToolReply> {
    const reply = await this.#run(request.body as unknown as Record<string, unknown>);
    return { output: reply.output, usage: reply.usage, latencyMs: reply.latencyMs, firstByteMs: reply.firstByteMs };
  }

  async #run(body: Record<string, unknown>) {
    assertAllowedModel(String(body.model));
    if (body.store !== false) throw new Error("Requests must set store: false.");
    meterCheck();
    const reply = await this.#stream(chatGptBody(body, this.#model()));
    meterAdd(reply.usage);
    return reply;
  }

  async #post(token: string, body: Record<string, unknown>, started: number): Promise<Response> {
    // The model actually sent, checked right before it goes out.
    assertAllowedModel(String(body.model));
    try {
      return await this.#fetch(this.#url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.name : "unknown";
      throw providerError(CHATGPT_UNAVAILABLE_TEXT, { latencyMs: elapsed(started), type: "network", code: reason.toLowerCase() });
    }
  }

  async #token(rejected?: string): Promise<string> {
    try {
      return await this.#auth.accessToken(rejected === undefined ? {} : { rejected });
    } catch (err) {
      if (err instanceof ChatGptAuthError) throw authFailure(err);
      if (err instanceof SecretsFileError) throw providerError(SETTINGS_FILE_TEXT, { type: "chatgpt_auth", code: "settings_file" });
      if (err instanceof SecretsBusyError) throw providerError(SETTINGS_BUSY_TEXT, { type: "chatgpt_auth", code: "settings_busy" });
      throw err;
    }
  }

  async #stream(body: Record<string, unknown>) {
    const started = performance.now();
    let token = await this.#token();
    let res = await this.#post(token, body, started);
    // A 401 refreshes the token once and tries once more.
    if (res.status === 401) {
      await res.body?.cancel();
      token = await this.#token(token);
      res = await this.#post(token, body, started);
    }
    if (!res.ok) {
      const err = apiError(parseJson(await res.text()));
      throw providerError(chatGptFailureText(res.status, err.code), { status: res.status, latencyMs: elapsed(started), type: err.type, code: err.code, param: err.param });
    }
    const contentType = res.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!res.body || (contentType && contentType !== "text/event-stream")) {
      await res.body?.cancel();
      throw providerError(CHATGPT_UNAVAILABLE_TEXT, { status: res.status, latencyMs: elapsed(started), type: "invalid_stream" });
    }
    let firstByteMs: number | null = null;
    try {
      for await (const event of readSse(res.body)) {
        firstByteMs ??= elapsed(started);
        const name = event.event !== "message" ? event.event : String((parseJson(event.data) as { type?: unknown } | null)?.type ?? "message");
        if (name === "response.completed") {
          const data = JSON.parse(event.data) as { response?: unknown };
          return { ...readCompletedBody(data.response), latencyMs: elapsed(started), firstByteMs };
        }
        if (name === "response.failed" || name === "response.incomplete" || name === "error") {
          const err = apiError(parseJson(event.data));
          throw providerError(chatGptFailureText(null, err.code), { status: res.status, latencyMs: elapsed(started), type: err.type ?? name, code: err.code, param: err.param });
        }
      }
    } catch (err) {
      if (err instanceof ModelCallError) throw err;
      const reason = err instanceof Error ? err.name : "unknown";
      throw providerError(CHATGPT_UNAVAILABLE_TEXT, { status: res.status, latencyMs: elapsed(started), type: "stream", code: reason.toLowerCase() });
    }
    throw providerError(CHATGPT_UNAVAILABLE_TEXT, { status: res.status, latencyMs: elapsed(started), type: "stream_ended" });
  }
}
