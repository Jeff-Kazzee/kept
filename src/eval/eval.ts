// Evaluation of extraction against the fixture corpus. The same code runs
// with the live client (pnpm eval:live) and with the recorded client in
// tests.
import type { Effort, EvidenceClaim, Message } from "../domain/claim.ts";
import { extractClaims } from "../extract/extract.ts";
import type { ExpectedClaim, FixtureMessage } from "../fixtures/schema.ts";
import { ModelCallError, type ModelCall, type ModelClient, type ModelReply } from "../model/client.ts";
import { RecordedModelClient, type Recording } from "../model/recorded.ts";
import { ZERO_USAGE, addUsage, type TokenUsage } from "../model/request.ts";

// Standard prices for Muse Spark 1.3, US dollars per million tokens. Cached
// input tokens are a subset of input tokens and are billed at the cached
// price. Reasoning tokens are a subset of output tokens.
export const PRICES_PER_MILLION = { input: 1.25, cachedInput: 0.15, output: 4.25 } as const;

export const TARGET_ACCURACY = 0.95;

export function estimateUsd(u: TokenUsage): number {
  const uncached = Math.max(0, u.input - u.cachedInput);
  return (
    (uncached * PRICES_PER_MILLION.input + u.cachedInput * PRICES_PER_MILLION.cachedInput + u.output * PRICES_PER_MILLION.output) /
    1_000_000
  );
}

export class SpendGuardError extends Error {
  override name = "SpendGuardError";
}

export type CallLog = {
  effort: Effort;
  run: number;
  messageId: string;
  attempt: number;
  ok: boolean;
  latencyMs: number;
  usage: TokenUsage;
  costUsd: number;
};

// Wraps a client, logs every call, and refuses a call once the running cost
// estimate has reached the limit.
export class GuardedClient implements ModelClient {
  readonly label: string;
  readonly #inner: ModelClient;
  readonly maxUsd: number;
  readonly log: CallLog[] = [];
  run = 0;
  spentUsd = 0;

  constructor(inner: ModelClient, maxUsd: number) {
    this.#inner = inner;
    this.maxUsd = maxUsd;
    this.label = inner.label;
  }

  async call(request: ModelCall): Promise<ModelReply> {
    if (this.spentUsd >= this.maxUsd) {
      throw new SpendGuardError(`Spend guard reached: estimate $${this.spentUsd.toFixed(4)} of $${this.maxUsd} limit.`);
    }
    const base = { effort: request.effort, run: this.run, messageId: request.messageId, attempt: request.attempt };
    try {
      const reply = await this.#inner.call(request);
      const costUsd = estimateUsd(reply.usage);
      this.spentUsd += costUsd;
      this.log.push({ ...base, ok: true, latencyMs: reply.latencyMs, usage: reply.usage, costUsd });
      return reply;
    } catch (err) {
      const latencyMs = err instanceof ModelCallError ? err.latencyMs : 0;
      this.log.push({ ...base, ok: false, latencyMs, usage: ZERO_USAGE, costUsd: 0 });
      throw err;
    }
  }
}

const normalizePlace = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// A location matches when one normalized value contains the other, so
// "our Elm Street office" matches "Elm Street office".
export function locationMatches(expected: string, actual: string): boolean {
  const e = normalizePlace(expected);
  const a = normalizePlace(actual);
  return e.length > 0 && a.length > 0 && (a.includes(e) || e.includes(a));
}

export function claimMatches(expected: ExpectedClaim, actual: EvidenceClaim): boolean {
  if (expected.claim_type !== actual.claim_type) return false;
  if (expected.date !== undefined && expected.date !== actual.slot.date) return false;
  if (expected.time !== undefined && expected.time !== actual.slot.time) return false;
  if (expected.location !== undefined) {
    if (expected.location === null) return actual.slot.location === null;
    if (actual.slot.location === null || !locationMatches(expected.location, actual.slot.location)) return false;
  }
  return true;
}

const specificity = (e: ExpectedClaim) =>
  [e.date, e.time, e.location].filter((v) => v !== undefined).length;

export type MessageScore = {
  matched: number;
  missed: ExpectedClaim[];
  extra: EvidenceClaim[];
};

// Pairs each expected claim with at most one extracted claim. The most
// specific expectations are paired first.
export function scoreMessage(expected: ExpectedClaim[], actual: EvidenceClaim[]): MessageScore {
  const unmatched = [...actual];
  const missed: ExpectedClaim[] = [];
  let matched = 0;
  for (const e of [...expected].sort((a, b) => specificity(b) - specificity(a))) {
    const i = unmatched.findIndex((a) => claimMatches(e, a));
    if (i === -1) missed.push(e);
    else {
      unmatched.splice(i, 1);
      matched++;
    }
  }
  return { matched, missed, extra: unmatched };
}

export type Counts = { expected: number; extracted: number; matched: number; missed: number; extra: number };

// Accuracy counts both misses and extra claims against the result:
// matched / (matched + missed + extra). Recall and precision are reported
// beside it.
export function rates(c: Counts) {
  const denom = c.matched + c.missed + c.extra;
  return {
    accuracy: denom === 0 ? 1 : c.matched / denom,
    recall: c.expected === 0 ? 1 : c.matched / c.expected,
    precision: c.extracted === 0 ? 1 : c.matched / c.extracted,
  };
}

const addCounts = (a: Counts, b: Counts): Counts => ({
  expected: a.expected + b.expected,
  extracted: a.extracted + b.extracted,
  matched: a.matched + b.matched,
  missed: a.missed + b.missed,
  extra: a.extra + b.extra,
});
const ZERO_COUNTS: Counts = { expected: 0, extracted: 0, matched: 0, missed: 0, extra: 0 };

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

export type MessageRunResult = Counts & {
  messageId: string;
  attempts: number;
  quoteRejections: number;
  otherRejections: number;
  manualEntry: boolean;
  missedClaims: ExpectedClaim[];
  extraClaims: Array<Pick<EvidenceClaim, "claim_type" | "slot" | "quote">>;
};

export type RunResult = Counts & ReturnType<typeof rates> & {
  run: number;
  complete: boolean;
  quoteRejections: number;
  manualEntryMessages: number;
  messages: MessageRunResult[];
};

export type EffortReport = {
  effort: Effort;
  runs: RunResult[];
  totals: Counts & ReturnType<typeof rates>;
  meetsTarget: boolean;
  quoteRejections: number;
  calls: number;
  latencyMs: { p50: number | null; p95: number | null };
  usage: TokenUsage;
  costUsd: number;
};

export type S8Report = {
  messageId: string;
  fabricatedClaims: number;
  rejected: number;
  rejectionRate: number;
  manualEntry: boolean;
  passed: boolean;
};

export type EvalReport = {
  startedAt: string;
  finishedAt: string;
  client: string;
  model: string;
  runsPerEffort: number;
  efforts: Effort[];
  maxUsd: number;
  stoppedBySpendGuard: boolean;
  stopReason: string | null;
  targetAccuracy: number;
  prices: typeof PRICES_PER_MILLION;
  corpus: { messages: number; expectedClaims: number };
  perEffort: EffortReport[];
  quoteCheck: { rejectionsTotal: number };
  s8: S8Report;
  usageTotal: TokenUsage;
  costUsdTotal: number;
  calls: CallLog[];
};

export type EvalOptions = {
  client: ModelClient;
  messages: FixtureMessage[];
  efforts?: Effort[];
  runs?: number;
  maxUsd: number;
  model: string;
  fabricated: { message: Message; recording: Recording };
  now?: () => string;
  onProgress?: (line: string) => void;
};

// S8 check: a recorded fabricated-quote response goes through the same
// extraction and quote check path. It never reaches the network.
export async function checkFabricatedQuote(message: Message, recording: Recording): Promise<S8Report> {
  const client = RecordedModelClient.withOverrides([{ ...recording, effort: "any" }]);
  const result = await extractClaims(message, client, { effort: "low" });
  const fabricatedClaims = client.calls.reduce((n, call) => {
    const attempt = recording.attempts[Math.min(call.attempt, recording.attempts.length) - 1]!;
    const claims = (attempt.output as { claims?: unknown[] } | undefined)?.claims ?? [];
    return n + claims.length;
  }, 0);
  const rejected = result.rejected.filter((r) => r.problems.includes("quote_not_in_source")).length;
  const rejectionRate = fabricatedClaims === 0 ? 0 : rejected / fabricatedClaims;
  return {
    messageId: message.id,
    fabricatedClaims,
    rejected,
    rejectionRate,
    manualEntry: result.needsManualEntry,
    passed: fabricatedClaims > 0 && rejectionRate === 1 && result.passed.length === 0,
  };
}

export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const efforts = options.efforts ?? ["low", "minimal"];
  const runs = options.runs ?? 3;
  const progress = options.onProgress ?? (() => {});
  const guarded = new GuardedClient(options.client, options.maxUsd);
  const startedAt = now();
  let stopReason: string | null = null;
  const perEffortRuns = new Map<Effort, RunResult[]>(efforts.map((e) => [e, []]));

  outer: for (const effort of efforts) {
    for (let run = 1; run <= runs; run++) {
      guarded.run = run;
      const messages: MessageRunResult[] = [];
      const record = (complete: boolean) => {
        const counts = messages.reduce<Counts>((sum, m) => addCounts(sum, m), ZERO_COUNTS);
        perEffortRuns.get(effort)!.push({
          run,
          complete,
          ...counts,
          ...rates(counts),
          quoteRejections: messages.reduce((n, m) => n + m.quoteRejections, 0),
          manualEntryMessages: messages.filter((m) => m.manualEntry).length,
          messages,
        });
      };
      for (const message of options.messages) {
        let result;
        try {
          result = await extractClaims(message, guarded, { effort, model: options.model });
        } catch (err) {
          if (!(err instanceof SpendGuardError)) throw err;
          stopReason = err.message;
          record(false);
          break outer;
        }
        const score = scoreMessage(message.expected, result.passed);
        const quoteRejections = result.rejected.filter((r) => r.problems.includes("quote_not_in_source")).length;
        messages.push({
          messageId: message.id,
          expected: message.expected.length,
          extracted: result.passed.length,
          matched: score.matched,
          missed: score.missed.length,
          extra: score.extra.length,
          attempts: result.attempts.length,
          quoteRejections,
          otherRejections: result.rejected.length - quoteRejections,
          manualEntry: result.needsManualEntry,
          missedClaims: score.missed,
          extraClaims: score.extra.map((c) => ({ claim_type: c.claim_type, slot: c.slot, quote: c.quote })),
        });
        progress(`${effort} run ${run} ${message.id}: matched ${score.matched}/${message.expected.length}`);
      }
      record(true);
    }
  }

  const perEffort: EffortReport[] = efforts.map((effort) => {
    const effortRuns = perEffortRuns.get(effort)!;
    const counts = effortRuns.reduce<Counts>((sum, r) => addCounts(sum, r), ZERO_COUNTS);
    const calls = guarded.log.filter((c) => c.effort === effort);
    const usage = calls.reduce((sum, c) => addUsage(sum, c.usage), ZERO_USAGE);
    const totals = { ...counts, ...rates(counts) };
    return {
      effort,
      runs: effortRuns,
      totals,
      meetsTarget: effortRuns.length === runs && effortRuns.every((r) => r.complete) && totals.accuracy >= TARGET_ACCURACY,
      quoteRejections: effortRuns.reduce((n, r) => n + r.quoteRejections, 0),
      calls: calls.length,
      latencyMs: {
        p50: percentile(calls.filter((c) => c.ok).map((c) => c.latencyMs), 50),
        p95: percentile(calls.filter((c) => c.ok).map((c) => c.latencyMs), 95),
      },
      usage,
      costUsd: estimateUsd(usage),
    };
  });

  const usageTotal = guarded.log.reduce((sum, c) => addUsage(sum, c.usage), ZERO_USAGE);
  return {
    startedAt,
    finishedAt: now(),
    client: options.client.label,
    model: options.model,
    runsPerEffort: runs,
    efforts,
    maxUsd: options.maxUsd,
    stoppedBySpendGuard: stopReason !== null,
    stopReason,
    targetAccuracy: TARGET_ACCURACY,
    prices: PRICES_PER_MILLION,
    corpus: {
      messages: options.messages.length,
      expectedClaims: options.messages.reduce((n, m) => n + m.expected.length, 0),
    },
    perEffort,
    quoteCheck: { rejectionsTotal: perEffort.reduce((n, e) => n + e.quoteRejections, 0) },
    s8: await checkFabricatedQuote(options.fabricated.message, options.fabricated.recording),
    usageTotal,
    costUsdTotal: estimateUsd(usageTotal),
    calls: guarded.log,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(4)}`;
const tokens = (u: TokenUsage) => `input ${u.input}, cached ${u.cachedInput}, output ${u.output}, reasoning ${u.reasoning}`;

export function formatSummary(report: EvalReport): string {
  const lines = [
    `Eval: model ${report.model}, client ${report.client}, ${report.corpus.messages} messages, ${report.corpus.expectedClaims} expected claims per run`,
  ];
  for (const e of report.perEffort) {
    lines.push(
      `[${e.effort}] accuracy ${pct(e.totals.accuracy)} (recall ${pct(e.totals.recall)}, precision ${pct(e.totals.precision)}) ` +
        `target ${pct(report.targetAccuracy)}: ${e.meetsTarget ? "met" : "NOT met"}`,
    );
    for (const r of e.runs) {
      lines.push(
        `  run ${r.run}${r.complete ? "" : " (stopped)"}: matched ${r.matched}, missed ${r.missed}, extra ${r.extra}, ` +
          `accuracy ${pct(r.accuracy)}, quote rejections ${r.quoteRejections}, manual entry ${r.manualEntryMessages}`,
      );
    }
    lines.push(`  calls ${e.calls}, latency p50 ${e.latencyMs.p50 ?? "n/a"} ms, p95 ${e.latencyMs.p95 ?? "n/a"} ms`);
    lines.push(`  tokens: ${tokens(e.usage)}. Estimated cost ${usd(e.costUsd)}`);
  }
  lines.push(`Quote-check rejections across the corpus: ${report.quoteCheck.rejectionsTotal}`);
  lines.push(
    `S8 fabricated quote: ${report.s8.rejected}/${report.s8.fabricatedClaims} rejected (${pct(report.s8.rejectionRate)}), ` +
      `manual entry ${report.s8.manualEntry ? "yes" : "no"}: ${report.s8.passed ? "pass" : "FAIL"}`,
  );
  lines.push(`Total tokens: ${tokens(report.usageTotal)}. Estimated cost ${usd(report.costUsdTotal)} (limit $${report.maxUsd})`);
  if (report.stoppedBySpendGuard) lines.push(`Stopped early: ${report.stopReason}`);
  return lines.join("\n");
}
