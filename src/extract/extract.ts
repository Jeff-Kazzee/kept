// Extraction: one model call per message, checked in code. An attempt is
// valid only when the output is JSON, matches the schema, and every claim
// passes the quote check and the date and time checks. An invalid attempt
// gets exactly one retry. Claims that pass from the final attempt go on to
// review. If the final attempt is still invalid, the message needs manual
// entry. Nothing here writes state. The caller records the result.
import {
  sourceTypeForChannel,
  type Effort,
  type EvidenceClaim,
  type Message,
} from "../domain/claim.ts";
import { checkSlotValues, type SlotIssue } from "../domain/datetime.ts";
import { quoteAppearsIn } from "../domain/quote.ts";
import { ModelCallError, type ModelClient } from "../model/client.ts";
import {
  MODEL,
  ModelOutput,
  ZERO_USAGE,
  addUsage,
  buildRequestBody,
  type ModelClaim,
  type TokenUsage,
} from "../model/request.ts";

export const MAX_ATTEMPTS = 2;

export type ClaimProblem = "quote_not_in_source" | "missing_request_item" | SlotIssue;
export type AttemptProblem = "call_failed" | "not_json" | "schema_mismatch" | "claim_checks_failed";

export type CheckedClaim = { claim: ModelClaim; problems: ClaimProblem[] };

export type AttemptRecord = {
  attempt: number;
  effort: Effort;
  model: string;
  latencyMs: number;
  usage: TokenUsage;
  outcome: "valid" | "invalid";
  problem: AttemptProblem | null;
  detail: string | null;
  claims: CheckedClaim[];
};

export type RejectedClaim = { attempt: number; claim: ModelClaim; problems: ClaimProblem[] };

export type ExtractionResult = {
  messageId: string;
  effort: Effort;
  attempts: AttemptRecord[];
  // Claims from the final attempt that passed every check. They still need
  // user review.
  passed: EvidenceClaim[];
  rejected: RejectedClaim[];
  needsManualEntry: boolean;
  usage: TokenUsage;
  latencyMs: number;
};

export function checkClaim(claim: ModelClaim, message: Message): ClaimProblem[] {
  const problems: ClaimProblem[] = [];
  if (!quoteAppearsIn(claim.quote, message.text)) problems.push("quote_not_in_source");
  problems.push(...checkSlotValues({ date: claim.date, time: claim.time, event_time: claim.event_time, quote: claim.quote }));
  if (claim.claim_type === "office_request" && !claim.request_item?.trim()) problems.push("missing_request_item");
  return problems;
}

export function toEvidenceClaim(claim: ModelClaim, message: Message): EvidenceClaim {
  return {
    claim_type: claim.claim_type,
    slot: { date: claim.date, time: claim.time, location: claim.location },
    quote: claim.quote,
    source_type: sourceTypeForChannel(message.channel),
    sender_kind: claim.sender_kind,
    evidence_time: message.received_at,
    event_time: claim.event_time,
    request_item: claim.claim_type === "office_request" ? claim.request_item : null,
  };
}

type AttemptOutcome = Omit<AttemptRecord, "attempt" | "effort" | "model">;

async function runAttempt(
  message: Message,
  client: ModelClient,
  effort: Effort,
  attempt: number,
  model: string,
  retryReasons: string[],
): Promise<AttemptOutcome> {
  const body = buildRequestBody(message, effort, retryReasons, model);
  let reply;
  try {
    reply = await client.call({ messageId: message.id, attempt, effort, body });
  } catch (err) {
    // Only a failed model call counts as an invalid attempt. Other errors,
    // such as the eval spend guard, stop the run.
    if (!(err instanceof ModelCallError)) throw err;
    return invalid("call_failed", err.message, ZERO_USAGE, err.latencyMs);
  }

  let json: unknown;
  try {
    json = JSON.parse(reply.outputText);
  } catch {
    return invalid("not_json", null, reply.usage, reply.latencyMs);
  }
  const parsed = ModelOutput.safeParse(json);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((i) => i.path.join(".") || "(root)");
    return invalid("schema_mismatch", [...new Set(paths)].slice(0, 5).join(", "), reply.usage, reply.latencyMs);
  }

  const claims = parsed.data.claims.map((claim) => ({ claim, problems: checkClaim(claim, message) }));
  const failed = claims.some((c) => c.problems.length > 0);
  return {
    latencyMs: reply.latencyMs,
    usage: reply.usage,
    outcome: failed ? "invalid" : "valid",
    problem: failed ? "claim_checks_failed" : null,
    detail: null,
    claims,
  };
}

function invalid(problem: AttemptProblem, detail: string | null, usage: TokenUsage, latencyMs: number): AttemptOutcome {
  return { latencyMs, usage, outcome: "invalid", problem, detail, claims: [] };
}

function retryReasonsFor(outcome: AttemptOutcome): string[] {
  if (outcome.problem === "claim_checks_failed") {
    return [...new Set(outcome.claims.flatMap((c) => c.problems))];
  }
  return outcome.problem ? [outcome.problem] : [];
}

export async function extractClaims(
  message: Message,
  client: ModelClient,
  options: { effort: Effort; model?: string },
): Promise<ExtractionResult> {
  const model = options.model ?? MODEL;
  const attempts: AttemptRecord[] = [];
  let reasons: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const outcome = await runAttempt(message, client, options.effort, attempt, model, reasons);
    attempts.push({ attempt, effort: options.effort, model, ...outcome });
    if (outcome.outcome === "valid") break;
    reasons = retryReasonsFor(outcome);
  }

  const last = attempts.at(-1)!;
  return {
    messageId: message.id,
    effort: options.effort,
    attempts,
    passed: last.claims.filter((c) => c.problems.length === 0).map((c) => toEvidenceClaim(c.claim, message)),
    rejected: attempts.flatMap((a) =>
      a.claims.filter((c) => c.problems.length > 0).map((c) => ({ attempt: a.attempt, claim: c.claim, problems: c.problems })),
    ),
    needsManualEntry: last.outcome === "invalid",
    usage: attempts.reduce((sum, a) => addUsage(sum, a.usage), ZERO_USAGE),
    latencyMs: attempts.reduce((sum, a) => sum + a.latencyMs, 0),
  };
}
