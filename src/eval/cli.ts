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
//
// The spend limit covers the whole command. The D2 calls get what the
// extraction runs left.
//
// Exit codes: 0 target met, 1 extraction target missed or S8 failed, 2 bad
// usage or MODEL_API_KEY missing, 3 stopped by the spend guard. The D2 calls
// have no pass criterion yet. Their report states the rates.
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

export type CliDeps = {
  createClient?: (apiKey: string) => ModelClient;
  log?: (line: string) => void;
  error?: (line: string) => void;
  now?: () => string;
};

export async function main(argv: string[], env: Record<string, string | undefined>, deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  let values: { "max-usd"?: string; out?: string; recorded?: boolean; d2?: boolean; "d2-only"?: boolean; "d2-effort"?: string };
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
  const d2Only = values["d2-only"] === true;
  const withD2 = d2Only || values.d2 === true;

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
    values.out ?? path.join("eval-results", `eval-${d2Only ? "d2" : "live"}-${startedAt.replace(/[:.]/g, "-")}.json`),
  );

  const client = values.recorded
    ? RecordedModelClient.fromDirectory()
    : (deps.createClient ?? ((key) => new MetaResponsesClient({ apiKey: key })))(apiKey!);
  const report: EvalReport | null = d2Only
    ? null
    : await runEval({
        client,
        messages,
        maxUsd,
        model: MODEL,
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
      model: MODEL,
      now,
      onProgress: log,
    });
  }

  const written = report === null ? d2 : withD2 ? { ...report, d2 } : report;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(written, null, 2) + "\n");
  if (report) log(formatSummary(report));
  if (d2) log(formatConflictSummary(d2));
  log(`Report: ${out}`);

  if (report?.stoppedBySpendGuard || d2?.stoppedBySpendGuard) return 3;
  if (report === null) return 0;
  return report.perEffort.every((e) => e.meetsTarget) && report.s8.passed ? 0 : 1;
}
