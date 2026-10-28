// Command line for `pnpm eval:live`. Kept apart from scripts/eval-live.ts so
// a test can run it end to end with the recorded client.
//
// Options:
//   --max-usd <n>  stop before the next call once the estimate reaches n (default 5)
//   --out <path>   report file. A relative path resolves from the package
//                  root. Default: eval-results/eval-live-<time>.json
//   --recorded     replay the recorded responses instead of calling the
//                  model. Needs no key. For a smoke test of the script.
//   --d2           after the extraction runs, also run the explanation and
//                  question calls over the D2 conflict fixtures
//   --d2-only      run only the explanation and question calls
//   --d2-effort <minimal|low>  reasoning effort for those calls (default low)
//   --d3           also run the reply template call over the D3 fixtures
//   --d3-only      run only the reply template call. With --d2-only, run
//                  the D2 and D3 calls and no extraction.
//   --d3-effort <minimal|low>  reasoning effort for the template call (default low)
//   --chat         run only the chat eval (0007, G11): the scripted
//                  conversations in fixtures/chat/*.json, with no extraction
//                  runs. Exit 1 when a turn approved or sent a reply, or left
//                  a slot in a state no office message or report of the
//                  person supports (0009, design 7).
//   --chat-runs <n>      runs per script (default 3)
//   --chat-script <ids>  comma-separated script ids (default all)
//   --chat-effort <minimal|low>  reasoning effort for the agent (default low)
//   --record-chat  write each live agent reply as a recording in
//                  fixtures/recordings/chat/. For the coordinator's live runs.
//   --provider <meta|chatgpt>  the live provider (default meta, 0010). meta
//                  uses MODEL_API_KEY. chatgpt uses the ChatGPT connection
//                  saved by the app (sign in in the app first), from the
//                  settings file beside APP_DB. The spend guard still
//                  prices tokens at the Meta rates: ChatGPT plan usage has
//                  no per-token price.
//   --model <id>   the model on that provider. meta: muse-spark-1.3 (default)
//                  or muse-wonder-1.0. chatgpt: a model the saved connection
//                  lists (default: the app's choice for that connection).
//
// The spend limit covers the whole command. The D2 calls get what the
// extraction runs left, and the D3 call what the D2 calls left.
//
// Exit codes: 0 target met, 1 extraction target missed or S8 failed, 2 bad
// usage, MODEL_API_KEY missing or no ChatGPT connection, 3 stopped by the
// spend guard. The D2 and
// D3 calls have no pass criterion yet. Their reports state the rates.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Effort } from "../domain/claim.ts";
import { corpusMessages, loadScenarios } from "../fixtures/load.ts";
import { MetaResponsesClient, type ModelClient } from "../model/client.ts";
import { RecordedModelClient, readRecording } from "../model/recorded.ts";
import { MODEL } from "../model/request.ts";
import { FIXTURES_DIR, PACKAGE_ROOT } from "../paths.ts";
import { formatConflictSummary, runConflictEval, type ConflictEvalReport } from "./conflict-eval.ts";
import { formatSummary, runEval, type EvalReport } from "./eval.ts";
import { formatReplySummary, runReplyEval, type ReplyEvalReport } from "./reply-eval.ts";
import { formatChatSummary, loadChatScripts, runChatEval } from "./chat-eval.ts";
import { RecordedChatClient, RecordingChatClient } from "../agent/recorded.ts";
import type { ToolModelClient } from "../model/responses.ts";
import { ChatGptAuth } from "../model/providers/chatgpt-auth.ts";
import { ChatGptResponsesClient } from "../model/providers/chatgpt-client.ts";
import { META_MODELS, chatGptModel, modelOptions } from "../model/providers/models.ts";
import { SecretsFileError, SecretsStore, appSecretsPath } from "../model/providers/secrets.ts";
import type { FetchLike } from "../model/providers/oidc.ts";

export type CliDeps = {
  createClient?: (apiKey: string) => ModelClient;
  createChatClient?: (apiKey: string) => ToolModelClient;
  // For tests of --provider chatgpt: the fetch the ChatGPT client uses.
  chatGptFetch?: FetchLike;
  log?: (line: string) => void;
  error?: (line: string) => void;
  now?: () => string;
};

export async function main(argv: string[], env: Record<string, string | undefined>, deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  let values: {
    "max-usd"?: string;
    out?: string;
    recorded?: boolean;
    d2?: boolean;
    "d2-only"?: boolean;
    "d2-effort"?: string;
    d3?: boolean;
    "d3-only"?: boolean;
    "d3-effort"?: string;
    chat?: boolean;
    "chat-runs"?: string;
    "chat-script"?: string;
    "chat-effort"?: string;
    "record-chat"?: boolean;
    provider?: string;
    model?: string;
  };
  try {
    ({ values } = parseArgs({
      args: argv[0] === "--" ? argv.slice(1) : argv,
      options: {
        "max-usd": { type: "string" },
        out: { type: "string" },
        recorded: { type: "boolean" },
        d2: { type: "boolean" },
        "d2-only": { type: "boolean" },
        "d2-effort": { type: "string" },
        d3: { type: "boolean" },
        "d3-only": { type: "boolean" },
        "d3-effort": { type: "string" },
        chat: { type: "boolean" },
        "chat-runs": { type: "string" },
        "chat-script": { type: "string" },
        "chat-effort": { type: "string" },
        "record-chat": { type: "boolean" },
        provider: { type: "string" },
        model: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const maxUsd = values["max-usd"] === undefined ? 5 : Number(values["max-usd"]);
  if (!Number.isFinite(maxUsd) || maxUsd < 0) {
    error("--max-usd must be a number of dollars, 0 or more.");
    return 2;
  }

  const d2Effort = Effort.safeParse(values["d2-effort"] ?? "low");
  if (!d2Effort.success) {
    error("--d2-effort must be minimal or low.");
    return 2;
  }
  const d3Effort = Effort.safeParse(values["d3-effort"] ?? "low");
  if (!d3Effort.success) {
    error("--d3-effort must be minimal or low.");
    return 2;
  }
  const provider = values.provider ?? "meta";
  if (provider !== "meta" && provider !== "chatgpt") {
    error("--provider must be meta or chatgpt.");
    return 2;
  }
  if (provider === "chatgpt" && values.recorded) {
    error("--provider chatgpt calls the live model. It cannot run with --recorded.");
    return 2;
  }
  let chatGpt: ChatGptResponsesClient | null = null;
  let evalModel = values.model ?? MODEL;
  if (provider === "meta" && !META_MODELS.some((m) => m.id === evalModel)) {
    error(`--model for meta must be one of ${META_MODELS.map((m) => m.id).join(", ")}.`);
    return 2;
  }
  if (provider === "chatgpt") {
    const made = chatGptClient(env, deps, values.model);
    if (typeof made === "string") {
      error(made);
      return 2;
    }
    chatGpt = made.client;
    evalModel = made.model;
  }
  if (values.chat) return runChat(values, maxUsd, env, deps, log, error, chatGpt, evalModel);

  const d2Only = values["d2-only"] === true;
  const d3Only = values["d3-only"] === true;
  const withD2 = d2Only || values.d2 === true;
  const withD3 = d3Only || values.d3 === true;
  const skipExtraction = d2Only || d3Only;

  const apiKey = env.MODEL_API_KEY;
  if (!apiKey && !values.recorded && !chatGpt) {
    error("MODEL_API_KEY is not set. Provide it in the environment, for example through varlock.");
    return 2;
  }

  const scenarios = loadScenarios();
  const messages = corpusMessages(scenarios);
  const s8 = scenarios.find((s) => s.model_fault);
  if (!s8?.model_fault) throw new Error("No scenario defines the fabricated-quote fault.");
  const fault = s8.model_fault;
  const fabricated = {
    message: messages.find((m) => m.id === fault.message)!,
    recording: readRecording(path.resolve(FIXTURES_DIR, fault.recording)),
  };

  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const out = path.resolve(
    PACKAGE_ROOT,
    values.out ?? path.join("eval-results", `eval-${d2Only ? "d2" : d3Only ? "d3" : "live"}-${startedAt.replace(/[:.]/g, "-")}.json`),
  );

  const client = values.recorded
    ? RecordedModelClient.fromDirectory()
    : (chatGpt ?? (deps.createClient ?? ((key) => new MetaResponsesClient({ apiKey: key })))(apiKey!));
  const report: EvalReport | null = skipExtraction
    ? null
    : await runEval({
        client,
        messages,
        maxUsd,
        model: evalModel,
        fabricated,
        now,
        onProgress: log,
      });
  let d2: ConflictEvalReport | null = null;
  if (withD2 && !report?.stoppedBySpendGuard) {
    d2 = await runConflictEval({
      client,
      scenarios,
      effort: d2Effort.data,
      maxUsd: Math.max(0, maxUsd - (report?.costUsdTotal ?? 0)),
      model: evalModel,
      now,
      onProgress: log,
    });
  }

  let d3: ReplyEvalReport | null = null;
  if (withD3 && !report?.stoppedBySpendGuard && !d2?.stoppedBySpendGuard) {
    d3 = await runReplyEval({
      client,
      scenarios,
      effort: d3Effort.data,
      maxUsd: Math.max(0, maxUsd - (report?.costUsdTotal ?? 0) - (d2?.costUsdTotal ?? 0)),
      model: evalModel,
      now,
      onProgress: log,
    });
  }

  // A report with extraction carries the D2 and D3 reports as fields. With
  // no extraction, a single D2 or D3 report is written on its own.
  const extras = { ...(withD2 ? { d2 } : {}), ...(withD3 ? { d3 } : {}) };
  const written = report !== null ? { ...report, ...extras } : withD2 && withD3 ? extras : withD2 ? d2 : d3;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(written, null, 2) + "\n");
  if (report) log(formatSummary(report));
  if (d2) log(formatConflictSummary(d2));
  if (d3) log(formatReplySummary(d3));
  log(`Report: ${out}`);

  if (report?.stoppedBySpendGuard || d2?.stoppedBySpendGuard || d3?.stoppedBySpendGuard) return 3;
  if (report === null) return 0;
  return report.perEffort.every((e) => e.meetsTarget) && report.s8.passed ? 0 : 1;
}

async function runChat(
  values: { recorded?: boolean; out?: string; "chat-runs"?: string; "chat-script"?: string; "chat-effort"?: string; "record-chat"?: boolean },
  maxUsd: number,
  env: Record<string, string | undefined>,
  deps: CliDeps,
  log: (line: string) => void,
  error: (line: string) => void,
  chatGpt: ChatGptResponsesClient | null,
  model: string,
): Promise<number> {
  const runs = values["chat-runs"] === undefined ? 3 : Number(values["chat-runs"]);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) {
    error("--chat-runs must be a whole number from 1 to 20.");
    return 2;
  }
  const effort = Effort.safeParse(values["chat-effort"] ?? "low");
  if (!effort.success) {
    error("--chat-effort must be minimal or low.");
    return 2;
  }
  if (values.recorded && values["record-chat"]) {
    error("--record-chat records live answers. It cannot run with --recorded.");
    return 2;
  }
  const all = loadChatScripts();
  const wanted = values["chat-script"]?.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = (wanted ?? []).filter((id) => !all.some((s) => s.id === id));
  if (unknown.length > 0) {
    error(`No chat script ${unknown.join(", ")}. Scripts: ${all.map((s) => s.id).join(", ")}.`);
    return 2;
  }
  const scripts = wanted ? all.filter((s) => wanted.includes(s.id)) : all;
  const apiKey = env.MODEL_API_KEY;
  if (!apiKey && !values.recorded && !chatGpt) {
    error("MODEL_API_KEY is not set. Provide it in the environment, for example through varlock.");
    return 2;
  }
  const now = deps.now ?? (() => new Date().toISOString());
  const client = values.recorded
    ? RecordedModelClient.fromDirectory()
    : (chatGpt ?? (deps.createClient ?? ((key) => new MetaResponsesClient({ apiKey: key })))(apiKey!));
  const base = values.recorded
    ? RecordedChatClient.fromDirectory()
    : (chatGpt ?? (deps.createChatClient ?? ((key) => new MetaResponsesClient({ apiKey: key })))(apiKey!));
  const chatClient = values["record-chat"] ? new RecordingChatClient(base) : base;
  const report = await runChatEval({ chatClient, client, scripts, runs, effort: effort.data, model, maxUsd, now, onProgress: log });
  const out = path.resolve(PACKAGE_ROOT, values.out ?? path.join("eval-results", `eval-chat-${report.startedAt.replace(/[:.]/g, "-")}.json`));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  log(formatChatSummary(report));
  if (chatClient instanceof RecordingChatClient) log(`Recorded ${chatClient.written} chat replies in fixtures/recordings/chat/.`);
  log(`Report: ${out}`);
  if (report.stoppedBySpendGuard) return 3;
  return report.personOnlyChanges === 0 && report.unsupportedStates === 0 ? 0 : 1;
}

// The ChatGPT client on the connection the app saved, or why there is none.
function chatGptClient(
  env: Record<string, string | undefined>,
  deps: CliDeps,
  wanted: string | undefined,
): { client: ChatGptResponsesClient; model: string } | string {
  const store = new SecretsStore(appSecretsPath(env as NodeJS.ProcessEnv));
  let view: ReturnType<typeof ChatGptAuth.view>;
  try {
    view = ChatGptAuth.view(store.read());
  } catch (err) {
    if (err instanceof SecretsFileError) return err.message;
    throw err;
  }
  if (!view.signedIn) return "No ChatGPT connection is saved. Start the app, sign in with ChatGPT in its settings, then run this again.";
  if (!view.planUsage) return "The saved ChatGPT connection may not use the ChatGPT plan. Sign in with ChatGPT again in the app and allow plan usage.";
  const settings = store.read();
  const options = modelOptions(settings, "chatgpt");
  if (wanted !== undefined && !options.some((m) => m.id === wanted)) {
    return `--model for chatgpt must be a model the connection lists: ${options.map((m) => m.id).join(", ")}.`;
  }
  const model = wanted ?? chatGptModel(settings);
  const port = Number(env.APP_PORT ?? 5180);
  const auth = new ChatGptAuth({ store, port, fetch: deps.chatGptFetch });
  return { client: new ChatGptResponsesClient({ auth, model: () => model, fetch: deps.chatGptFetch }), model };
}
