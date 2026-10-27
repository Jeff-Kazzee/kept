// Command line for `pnpm eval:live`. Kept apart from scripts/eval-live.ts so
// a test can run it end to end with the recorded client.
//
// Options:
//   --max-usd <n>  stop before the next call once the estimate reaches n (default 5)
//   --out <path>   report file. A relative path resolves from the package
//                  root. Default: eval-results/eval-live-<time>.json
//   --recorded     replay the recorded responses instead of calling the
//                  model. Needs no key. For a smoke test of the script.
//
// Exit codes: 0 target met, 1 target missed or S8 failed, 2 bad usage or
// MODEL_API_KEY missing, 3 stopped by the spend guard.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { corpusMessages, loadScenarios } from "../fixtures/load.ts";
import { MetaResponsesClient, type ModelClient } from "../model/client.ts";
import { RecordedModelClient, readRecording } from "../model/recorded.ts";
import { MODEL } from "../model/request.ts";
import { FIXTURES_DIR, PACKAGE_ROOT } from "../paths.ts";
import { formatSummary, runEval, type EvalReport } from "./eval.ts";

export type CliDeps = {
  createClient?: (apiKey: string) => ModelClient;
  log?: (line: string) => void;
  error?: (line: string) => void;
  now?: () => string;
};

export async function main(argv: string[], env: Record<string, string | undefined>, deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  let values: { "max-usd"?: string; out?: string; recorded?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv[0] === "--" ? argv.slice(1) : argv,
      options: { "max-usd": { type: "string" }, out: { type: "string" }, recorded: { type: "boolean" } },
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

  const apiKey = env.MODEL_API_KEY;
  if (!apiKey && !values.recorded) {
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
    values.out ?? path.join("eval-results", `eval-live-${startedAt.replace(/[:.]/g, "-")}.json`),
  );

  const client = values.recorded
    ? RecordedModelClient.fromDirectory()
    : (deps.createClient ?? ((key) => new MetaResponsesClient({ apiKey: key })))(apiKey!);
  const report: EvalReport = await runEval({
    client,
    messages,
    maxUsd,
    model: MODEL,
    fabricated,
    now,
    onProgress: log,
  });

  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  log(formatSummary(report));
  log(`Report: ${out}`);

  if (report.stoppedBySpendGuard) return 3;
  return report.perEffort.every((e) => e.meetsTarget) && report.s8.passed ? 0 : 1;
}
