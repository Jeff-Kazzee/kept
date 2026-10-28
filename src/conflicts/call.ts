// One structured model call with at most one retry. An attempt is valid only
// when the output is JSON, matches the schema and passes the caller's code
// checks. A retry carries only problem codes, never message text. Nothing
// here writes state.
import type { z } from "zod";
import type { Effort } from "../domain/claim.ts";
import type { EvidenceView } from "../intake/events.ts";
import { ModelCallError, type ModelClient } from "../model/client.ts";
import { ZERO_USAGE, addUsage, buildJsonRequest, type TokenUsage } from "../model/request.ts";
import type { OutputProblem } from "./check.ts";

export const MAX_ATTEMPTS = 2;

// D-h: the conflict calls default to effort low. The extraction default is
// set elsewhere and does not change.
export const DEFAULT_CONFLICT_EFFORT: Effort = "low";

export type CallAttempt<T> = {
  attempt: number;
  effort: Effort;
  model: string;
  latencyMs: number;
  usage: TokenUsage;
  outcome: "valid" | "invalid";
  problems: OutputProblem[];
  detail: string | null;
  // The parsed output, kept for the record even when a check failed.
  output: T | null;
};

export type CallSpec<T> = {
  client: ModelClient;
  key: string;
  effort: Effort;
  model: string;
  instructions: string;
  input: string;
  schemaName: string;
  schema: object;
  parser: z.ZodType<T>;
  check: (output: T) => OutputProblem[];
};

export async function callWithRetry<T>(spec: CallSpec<T>): Promise<CallAttempt<T>[]> {
  const attempts: CallAttempt<T>[] = [];
  let reasons: OutputProblem[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const instructions =
      reasons.length === 0 ? spec.instructions : `${spec.instructions} A previous answer was rejected for: ${reasons.join(", ")}.`;
    const body = buildJsonRequest({
      model: spec.model,
      effort: spec.effort,
      instructions,
      input: spec.input,
      schemaName: spec.schemaName,
      schema: spec.schema,
    });
    const base = { attempt, effort: spec.effort, model: spec.model };
    let result: CallAttempt<T>;
    try {
      const reply = await spec.client.call({ key: spec.key, attempt, effort: spec.effort, body });
      result = { ...base, ...judge(reply.outputText, spec), latencyMs: reply.latencyMs, usage: reply.usage };
    } catch (err) {
      // Only a failed model call counts as an invalid attempt. Other errors,
      // such as the eval spend guard, stop the run.
      if (!(err instanceof ModelCallError)) throw err;
      result = { ...base, latencyMs: err.latencyMs, usage: ZERO_USAGE, outcome: "invalid", problems: ["call_failed"], detail: err.message, output: null };
    }
    attempts.push(result);
    if (result.outcome === "valid") break;
    reasons = result.problems;
  }
  return attempts;
}

function judge<T>(text: string, spec: CallSpec<T>): Pick<CallAttempt<T>, "outcome" | "problems" | "detail" | "output"> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { outcome: "invalid", problems: ["not_json"], detail: null, output: null };
  }
  const parsed = spec.parser.safeParse(json);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((i) => i.path.join(".") || "(root)");
    return { outcome: "invalid", problems: ["schema_mismatch"], detail: [...new Set(paths)].slice(0, 5).join(", "), output: null };
  }
  const problems = spec.check(parsed.data);
  return { outcome: problems.length === 0 ? "valid" : "invalid", problems, detail: null, output: parsed.data };
}

export const totalUsage = (attempts: Array<{ usage: TokenUsage }>) => attempts.reduce((sum, a) => addUsage(sum, a.usage), ZERO_USAGE);
export const totalLatency = (attempts: Array<{ latencyMs: number }>) => attempts.reduce((sum, a) => sum + a.latencyMs, 0);

// What the model sees of one evidence item. Only the quote from the
// message is sent, never the full message text. For an answer item the
// quote is the choice the user tapped. The quote and the place are words
// from a message, so they go in labeled untrusted fields (sprint 7A review,
// finding 9).
export function evidenceForModel(e: EvidenceView) {
  const c = e.claim;
  return {
    id: e.id,
    claim_type: c.claim_type,
    source: c.source_type,
    sender_kind: c.sender_kind,
    evidence_time: c.evidence_time,
    event_time: c.event_time,
    date: c.slot.date,
    time: c.slot.time,
    location: c.slot.location === null ? null : { untrusted_text: c.slot.location },
    quote: c.quote === null ? null : { untrusted_quote: c.quote },
  };
}
