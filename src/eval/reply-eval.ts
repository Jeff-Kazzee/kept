// Evaluation of the reply template call over the suggest steps in the D3
// fixtures. Each case state is built offline with recorded extraction and
// the recorded model for the steps before the suggest step. Only the
// template call goes to the client. Each distinct input is called once per
// run. A step's fault recording is not used here: the client answers.
import type { CallAttempt } from "../conflicts/call.ts";
import type { OutputProblem } from "../conflicts/check.ts";
import type { Effort } from "../domain/claim.ts";
import type { D3Step, ResolvedScenario } from "../fixtures/schema.ts";
import type { ModelClient } from "../model/client.ts";
import { ZERO_USAGE, addUsage, type TokenUsage } from "../model/request.ts";
import type { ReplyContext } from "../reply/draft.ts";
import { replyInput, replyKey, suggestReply } from "../reply/suggest.ts";
import type { TemplateId } from "../reply/templates.ts";
import { replayCheckpoint } from "./d2-fixtures.ts";
import { GuardedClient, PRICES_PER_MILLION, SpendGuardError, estimateUsd, percentile, type CallLog } from "./eval.ts";

type Pick = { template: TemplateId; slot: string } | null;

export type ReplyItem = { key: string; source: string; intent: string | null; context: ReplyContext; expect: Pick | undefined };

// The distinct template call inputs across the D3 checkpoints.
export async function replyItems(scenarios: ResolvedScenario[]): Promise<ReplyItem[]> {
  const items = new Map<string, ReplyItem>();
  for (const s of scenarios) {
    for (const [i, checkpoint] of (s.d3 ?? []).entries()) {
      for (const [j, step] of checkpoint.steps.entries()) {
        if (!("suggest" in step)) continue;
        const prefix: D3Step[] = checkpoint.steps.slice(0, j);
        const { kase } = await replayCheckpoint(s, { steps: prefix });
        const context = kase.replyState().context;
        const key = replyKey(replyInput(step.suggest.intent, context));
        if (!items.has(key)) items.set(key, { key, source: `${s.id}.${i + 1}`, intent: step.suggest.intent, context, expect: step.suggest.expect });
      }
    }
  }
  return [...items.values()];
}

export type ReplyRunResult = {
  run: number;
  complete: boolean;
  items: Array<{
    key: string;
    source: string;
    outcome: string;
    // The draft code opened, or null after the fallback.
    pick: Pick;
    // The template and slot in the model's final parsed output, valid or
    // not. Null when the final output did not parse.
    modelPick: Pick;
    expected: Pick | null;
    // The system outcome matches the expected pick: a draft for an expected
    // pick, the fallback for an expected null.
    outcomeMatches: boolean | null;
    // The model's own final pick equals a non-null expected pick.
    modelPickMatches: boolean | null;
    attempts: number;
    problems: OutputProblem[][];
  }>;
};

export type ReplyEvalReport = {
  startedAt: string;
  finishedAt: string;
  client: string;
  model: string;
  effort: Effort;
  runs: number;
  maxUsd: number;
  stoppedBySpendGuard: boolean;
  stopReason: string | null;
  prices: typeof PRICES_PER_MILLION;
  corpus: { inputs: number; withExpectedPick: number };
  // Final results that passed every code check, out of all results.
  validTemplateRate: number | null;
  // The model's final pick, valid or not, equal to the expected pick, out of
  // results with a non-null expected pick. Scores the model alone.
  modelPickRate: number | null;
  // System outcomes that match the expected pick, out of results with one.
  // An expected null is met by the fallback to manual entry, which is the
  // code check working, not the model.
  expectedOutcomeRate: number | null;
  // Results where no template fits (expected null), and how many of them
  // the model still answered with a pick that code had to block.
  noFit: { results: number; modelProposedPick: number };
  // Results that fell back to manual entry.
  fallbacks: number;
  rejections: Partial<Record<OutputProblem, number>>;
  calls: number;
  latencyMs: { p50: number | null; p95: number | null };
  usage: TokenUsage;
  costUsd: number;
  runResults: ReplyRunResult[];
  callLog: CallLog[];
};

export type ReplyEvalOptions = {
  client: ModelClient;
  scenarios: ResolvedScenario[];
  runs?: number;
  effort?: Effort;
  maxUsd: number;
  model: string;
  now?: () => string;
  onProgress?: (line: string) => void;
};

const samePick = (a: Pick, b: Pick) => (a === null || b === null ? a === b : a.template === b.template && a.slot === b.slot);

export async function runReplyEval(options: ReplyEvalOptions): Promise<ReplyEvalReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const runs = options.runs ?? 3;
  const effort = options.effort ?? "low";
  const progress = options.onProgress ?? (() => {});
  const startedAt = now();
  const items = await replyItems(options.scenarios);
  const guarded = new GuardedClient(options.client, options.maxUsd);
  let stopReason: string | null = null;
  const runResults: ReplyRunResult[] = [];
  const attempts: Array<CallAttempt<unknown>> = [];

  for (let run = 1; run <= runs && stopReason === null; run++) {
    guarded.run = run;
    const result: ReplyRunResult = { run, complete: false, items: [] };
    runResults.push(result);
    try {
      for (const item of items) {
        const r = await suggestReply(item.intent, item.context, guarded, { effort, model: options.model });
        attempts.push(...r.attempts);
        const pick: Pick = r.outcome === "valid" ? { template: r.template!, slot: r.slotKey! } : null;
        const raw = r.attempts.at(-1)?.output ?? null;
        const modelPick: Pick = raw ? { template: raw.template, slot: raw.slot_id } : null;
        result.items.push({
          key: item.key,
          source: item.source,
          outcome: r.outcome,
          pick,
          modelPick,
          expected: item.expect ?? null,
          outcomeMatches: item.expect === undefined ? null : samePick(pick, item.expect),
          modelPickMatches: item.expect ? samePick(modelPick, item.expect) : null,
          attempts: r.attempts.length,
          problems: r.attempts.map((a) => a.problems),
        });
        progress(`reply run ${run} ${item.key}: ${r.outcome}${pick ? ` ${pick.template} ${pick.slot}` : ""}`);
      }
      result.complete = true;
    } catch (err) {
      if (!(err instanceof SpendGuardError)) throw err;
      stopReason = err.message;
    }
  }

  const finals = runResults.flatMap((r) => r.items);
  const scored = finals.filter((f) => f.outcomeMatches !== null);
  const modelScored = finals.filter((f) => f.modelPickMatches !== null);
  const noFit = finals.filter((f) => f.outcomeMatches !== null && f.expected === null);
  const rejections: Partial<Record<OutputProblem, number>> = {};
  for (const a of attempts) for (const p of a.problems) rejections[p] = (rejections[p] ?? 0) + 1;
  const ok = guarded.log.filter((c) => c.ok).map((c) => c.latencyMs);
  const usage = guarded.log.reduce((sum, c) => addUsage(sum, c.usage), ZERO_USAGE);
  return {
    startedAt,
    finishedAt: now(),
    client: options.client.label,
    model: options.model,
    effort,
    runs,
    maxUsd: options.maxUsd,
    stoppedBySpendGuard: stopReason !== null,
    stopReason,
    prices: PRICES_PER_MILLION,
    corpus: { inputs: items.length, withExpectedPick: items.filter((i) => i.expect !== undefined).length },
    validTemplateRate: finals.length === 0 ? null : finals.filter((f) => f.outcome === "valid").length / finals.length,
    modelPickRate: modelScored.length === 0 ? null : modelScored.filter((f) => f.modelPickMatches).length / modelScored.length,
    expectedOutcomeRate: scored.length === 0 ? null : scored.filter((f) => f.outcomeMatches).length / scored.length,
    noFit: { results: noFit.length, modelProposedPick: noFit.filter((f) => f.modelPick !== null).length },
    fallbacks: finals.filter((f) => f.outcome === "manual_needed").length,
    rejections,
    calls: guarded.log.length,
    latencyMs: { p50: percentile(ok, 50), p95: percentile(ok, 95) },
    usage,
    costUsd: estimateUsd(usage),
    runResults,
    callLog: guarded.log,
  };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

export function formatReplySummary(r: ReplyEvalReport): string {
  const rejections = Object.entries(r.rejections).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  const lines = [
    `D3 eval: model ${r.model}, effort ${r.effort}, client ${r.client}, ${r.runs} runs, ${r.corpus.inputs} template inputs`,
    `[template] valid templates ${pct(r.validTemplateRate)}, model picks as expected ${pct(r.modelPickRate)}, ` +
      `system outcomes as expected ${pct(r.expectedOutcomeRate)}, fallbacks ${r.fallbacks}, calls ${r.calls}`,
    `  no template fits: ${r.noFit.results} results, the model still proposed a pick that code blocked in ${r.noFit.modelProposedPick}`,
    `  rejections by reason: ${rejections}`,
    `  latency p50 ${r.latencyMs.p50 ?? "n/a"} ms, p95 ${r.latencyMs.p95 ?? "n/a"} ms`,
    `  tokens: input ${r.usage.input}, cached ${r.usage.cachedInput}, output ${r.usage.output}, reasoning ${r.usage.reasoning}. ` +
      `Estimated cost $${r.costUsd.toFixed(4)} (limit $${r.maxUsd})`,
  ];
  if (r.stoppedBySpendGuard) lines.push(`D3 stopped early: ${r.stopReason}`);
  return lines.join("\n");
}
