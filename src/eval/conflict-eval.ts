// Evaluation of the explanation and next-question calls over the conflict
// states in the D2 fixtures. The states are built offline with recorded
// extraction and recorded questions. Only the calls being measured go to the
// client. Each distinct explanation input and question input is called once
// per run, so states that share a conflict are not paid for twice.
import { checkCitations, type OutputProblem } from "../conflicts/check.ts";
import { explainConflict, explanationKey } from "../conflicts/explain.ts";
import { proposeQuestion, questionKey } from "../conflicts/question.ts";
import type { CallAttempt } from "../conflicts/call.ts";
import type { Effort } from "../domain/claim.ts";
import type { ResolvedScenario } from "../fixtures/schema.ts";
import type { EvidenceView } from "../intake/events.ts";
import type { ModelClient } from "../model/client.ts";
import { ZERO_USAGE, addUsage, type TokenUsage } from "../model/request.ts";
import type { Conflict } from "../slots/types.ts";
import { replayCheckpoint } from "./d2-fixtures.ts";
import { GuardedClient, PRICES_PER_MILLION, SpendGuardError, estimateUsd, percentile, type CallLog } from "./eval.ts";

export type ExplainItem = { key: string; source: string; conflict: Conflict; evidence: EvidenceView[] };
export type QuestionItem = { key: string; source: string; candidates: Conflict[]; evidence: EvidenceView[] };

// The distinct explanation and question inputs across the D2 checkpoints.
export async function conflictItems(scenarios: ResolvedScenario[]): Promise<{ explanations: ExplainItem[]; questions: QuestionItem[] }> {
  const explanations = new Map<string, ExplainItem>();
  const questions = new Map<string, QuestionItem>();
  for (const s of scenarios) {
    for (const [i, checkpoint] of (s.d2 ?? []).entries()) {
      const { intake, kase } = await replayCheckpoint(s, checkpoint);
      const evidence = intake.evidence();
      const view = kase.view();
      const source = `${s.id}.${i + 1}`;
      for (const conflict of view.conflicts) {
        const key = explanationKey(conflict);
        if (!explanations.has(key)) explanations.set(key, { key, source, conflict, evidence });
      }
      const waiting = new Set(view.conflicts.filter((c) => c.askable && c.status === "open").map((c) => c.id));
      const candidates = view.conflicts.filter((c) => waiting.has(c.id));
      if (candidates.length > 0) {
        const key = questionKey(candidates);
        if (!questions.has(key)) questions.set(key, { key, source, candidates, evidence });
      }
    }
  }
  return { explanations: [...explanations.values()], questions: [...questions.values()] };
}

type Counts = Record<OutputProblem, number>;

export type CallKindReport = {
  items: number;
  calls: number;
  // Parsed attempts whose citations name at least one evidence item and only
  // items of the conflict, out of attempts that parsed.
  validCitationRate: number | null;
  // Final results that passed every check.
  validRate: number | null;
  // Explanations shown as unavailable, or questions in fixed wording.
  fallbacks: number;
  rejections: Partial<Counts>;
  latencyMs: { p50: number | null; p95: number | null };
  usage: TokenUsage;
  costUsd: number;
};

export type ConflictRunResult = {
  run: number;
  complete: boolean;
  explanations: Array<{ key: string; source: string; outcome: string; attempts: number; problems: OutputProblem[][]; text: string | null }>;
  questions: Array<{ key: string; source: string; origin: string; conflictId: string; attempts: number; problems: OutputProblem[][]; text: string }>;
};

export type ConflictEvalReport = {
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
  corpus: { explanationInputs: number; questionInputs: number };
  explanation: CallKindReport;
  question: CallKindReport;
  runResults: ConflictRunResult[];
  usageTotal: TokenUsage;
  costUsdTotal: number;
  calls: CallLog[];
};

export type ConflictEvalOptions = {
  client: ModelClient;
  scenarios: ResolvedScenario[];
  runs?: number;
  effort?: Effort;
  maxUsd: number;
  model: string;
  now?: () => string;
  onProgress?: (line: string) => void;
};

const CITATION_PROBLEMS = new Set<OutputProblem>(["no_citation", "unknown_evidence_id", "evidence_not_in_conflict"]);

function kindReport(
  items: number,
  attempts: Array<CallAttempt<unknown>>,
  finals: boolean[],
  fallbacks: number,
  log: CallLog[],
): CallKindReport {
  const parsed = attempts.filter((a) => a.output !== null);
  const rejections: Partial<Counts> = {};
  for (const a of attempts) for (const p of a.problems) rejections[p] = (rejections[p] ?? 0) + 1;
  const ok = log.filter((c) => c.ok).map((c) => c.latencyMs);
  const usage = log.reduce((sum, c) => addUsage(sum, c.usage), ZERO_USAGE);
  return {
    items,
    calls: log.length,
    validCitationRate: parsed.length === 0 ? null : parsed.filter((a) => !a.problems.some((p) => CITATION_PROBLEMS.has(p))).length / parsed.length,
    validRate: finals.length === 0 ? null : finals.filter(Boolean).length / finals.length,
    fallbacks,
    rejections,
    latencyMs: { p50: percentile(ok, 50), p95: percentile(ok, 95) },
    usage,
    costUsd: estimateUsd(usage),
  };
}

export async function runConflictEval(options: ConflictEvalOptions): Promise<ConflictEvalReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const runs = options.runs ?? 3;
  const effort = options.effort ?? "low";
  const progress = options.onProgress ?? (() => {});
  const startedAt = now();
  const items = await conflictItems(options.scenarios);
  const guarded = new GuardedClient(options.client, options.maxUsd);
  let stopReason: string | null = null;
  const runResults: ConflictRunResult[] = [];
  const explainAttempts: Array<CallAttempt<unknown>> = [];
  const questionAttempts: Array<CallAttempt<unknown>> = [];
  const explainFinals: boolean[] = [];
  const questionFinals: boolean[] = [];

  outer: for (let run = 1; run <= runs; run++) {
    guarded.run = run;
    const result: ConflictRunResult = { run, complete: false, explanations: [], questions: [] };
    runResults.push(result);
    try {
      for (const item of items.explanations) {
        const r = await explainConflict(item.conflict, item.evidence, guarded, { effort, model: options.model });
        explainAttempts.push(...r.attempts);
        explainFinals.push(r.outcome === "valid");
        result.explanations.push({
          key: item.key,
          source: item.source,
          outcome: r.outcome,
          attempts: r.attempts.length,
          problems: r.attempts.map((a) => a.problems),
          text: r.text,
        });
        progress(`explain run ${run} ${item.key}: ${r.outcome}`);
      }
      for (const item of items.questions) {
        const r = await proposeQuestion(item.candidates, item.evidence, guarded, { effort, model: options.model });
        questionAttempts.push(...r.attempts);
        questionFinals.push(r.origin === "model");
        result.questions.push({
          key: item.key,
          source: item.source,
          origin: r.origin,
          conflictId: r.conflictId,
          attempts: r.attempts.length,
          problems: r.attempts.map((a) => a.problems),
          text: r.text,
        });
        progress(`question run ${run} ${item.key}: ${r.origin}`);
      }
      result.complete = true;
    } catch (err) {
      if (!(err instanceof SpendGuardError)) throw err;
      stopReason = err.message;
      break outer;
    }
  }

  const logOf = (prefix: string) => guarded.log.filter((c) => c.key.startsWith(prefix));
  const usageTotal = guarded.log.reduce((sum, c) => addUsage(sum, c.usage), ZERO_USAGE);
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
    corpus: { explanationInputs: items.explanations.length, questionInputs: items.questions.length },
    explanation: kindReport(
      items.explanations.length,
      explainAttempts,
      explainFinals,
      explainFinals.filter((v) => !v).length,
      logOf("explain-"),
    ),
    question: kindReport(items.questions.length, questionAttempts, questionFinals, questionFinals.filter((v) => !v).length, logOf("question-")),
    runResults,
    usageTotal,
    costUsdTotal: estimateUsd(usageTotal),
    calls: guarded.log,
  };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const tokens = (u: TokenUsage) => `input ${u.input}, cached ${u.cachedInput}, output ${u.output}, reasoning ${u.reasoning}`;

export function formatConflictSummary(report: ConflictEvalReport): string {
  const lines = [
    `D2 eval: model ${report.model}, effort ${report.effort}, client ${report.client}, ${report.runs} runs, ` +
      `${report.corpus.explanationInputs} explanation inputs, ${report.corpus.questionInputs} question inputs`,
  ];
  for (const [name, r] of [
    ["explanation", report.explanation],
    ["question", report.question],
  ] as const) {
    const rejections = Object.entries(r.rejections).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
    lines.push(
      `[${name}] valid citations ${pct(r.validCitationRate)} of parsed attempts, valid results ${pct(r.validRate)}, ` +
        `fallbacks ${r.fallbacks}, calls ${r.calls}`,
    );
    lines.push(`  rejections by reason: ${rejections}`);
    lines.push(`  latency p50 ${r.latencyMs.p50 ?? "n/a"} ms, p95 ${r.latencyMs.p95 ?? "n/a"} ms`);
    lines.push(`  tokens: ${tokens(r.usage)}. Estimated cost $${r.costUsd.toFixed(4)}`);
  }
  lines.push(`D2 total tokens: ${tokens(report.usageTotal)}. Estimated cost $${report.costUsdTotal.toFixed(4)} (limit $${report.maxUsd})`);
  if (report.stoppedBySpendGuard) lines.push(`D2 stopped early: ${report.stopReason}`);
  return lines.join("\n");
}
