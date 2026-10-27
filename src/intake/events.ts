// Event kinds for evidence intake and the projections built from them.
// A message stream holds the imported message and its extraction history.
// Each evidence item has its own stream, so a review decision states the
// version of that one item. An answer to a question also creates evidence
// items. The user's tap on the answer is their review, so an answer item is
// accepted when it is recorded. An approved reply creates evidence items the
// same way, because the approval is the user's review. Unknown event kinds are skipped, which leaves
// room for later kinds such as notes, tags, archive and undo.
import type { Effort, EvidenceClaim, Message, SourceType } from "../domain/claim.ts";
import type { AttemptProblem, ClaimProblem } from "../extract/extract.ts";
import type { ModelClaim, TokenUsage } from "../model/request.ts";
import type { StoredEvent } from "../store/event-log.ts";

export const messageStream = (id: string) => `message:${id}`;
export const evidenceStream = (id: string) => `evidence:${id}`;

export type MessageEvent =
  | { type: "message_imported"; data: { message: Message; source_type: SourceType } }
  | {
      type: "extraction_attempted";
      data: {
        attempt: number;
        effort: Effort;
        model: string;
        outcome: "valid" | "invalid";
        problem: AttemptProblem | null;
        detail: string | null;
        usage: TokenUsage;
        latency_ms: number;
        claim_count: number;
      };
    }
  | { type: "claim_rejected"; data: { attempt: number; effort: Effort; claim: ModelClaim; problems: ClaimProblem[] } }
  | {
      type: "extraction_finished";
      data: { effort: Effort; outcome: ExtractionOutcome; evidence_ids: string[] };
    }
  | { type: "manual_entry_recorded"; data: { evidence_id: string } };

export type ExtractionOutcome = "claims_pending" | "no_claims" | "manual_entry_needed";

export type EvidenceEvent =
  | { type: "claim_extracted"; data: { message_id: string; claim: EvidenceClaim; effort: Effort; attempt: number } }
  | { type: "claim_entered_manually"; data: { message_id: string; claim: EvidenceClaim } }
  | { type: "claim_accepted"; data: Record<string, never> }
  | { type: "claim_rejected_by_user"; data: Record<string, never> }
  | { type: "answer_recorded"; data: { claim: EvidenceClaim } & AnswerMeta }
  | { type: "reply_recorded"; data: { claim: EvidenceClaim } & ReplyMeta };

// Where an answer item came from. `clarifies` names the evidence item whose
// date or time the answer resolves. `after` is the latest evidence time in
// the case when the user answered. The answer is ordered after it, because
// the user answered with all of that evidence in view.
export type AnswerMeta = {
  question_id: string;
  conflict_id: string;
  choice_id: string;
  clarifies: string | null;
  after: string;
  // Position among the effects of one answer, from 0.
  index?: number;
};

// Where a reply item came from. `after` works as for an answer: the item is
// ordered after the latest evidence the user had in view when approving.
export type ReplyMeta = {
  draft_id: string;
  after: string;
  index: number;
};

export type MessageView = {
  id: string;
  version: number;
  message: Message;
  sourceType: SourceType;
  status: "imported" | ExtractionOutcome;
  attempts: Array<Extract<MessageEvent, { type: "extraction_attempted" }>["data"]>;
  rejections: Array<Extract<MessageEvent, { type: "claim_rejected" }>["data"]>;
  evidenceIds: string[];
  manualEvidenceIds: string[];
};

export type ReviewStatus = "pending" | "accepted" | "rejected";

export type EvidenceView = {
  id: string;
  version: number;
  // Null for an answer item, which comes from no message.
  messageId: string | null;
  claim: EvidenceClaim;
  // "model" means model output that passed the code checks.
  origin: "model" | "manual" | "answer" | "reply";
  status: ReviewStatus;
  decidedAt: string | null;
  answer: AnswerMeta | null;
  // Set for an item an approved reply recorded.
  reply?: ReplyMeta | null;
};

function streamKey(streamId: string, prefix: string): string | null {
  return streamId.startsWith(prefix) ? streamId.slice(prefix.length) : null;
}

export function projectMessages(events: StoredEvent[]): Map<string, MessageView> {
  const views = new Map<string, MessageView>();
  for (const e of events) {
    const id = streamKey(e.streamId, "message:");
    if (id === null) continue;
    const event = { type: e.type, data: e.data } as MessageEvent;
    if (event.type === "message_imported") {
      views.set(id, {
        id,
        version: e.version,
        message: event.data.message,
        sourceType: event.data.source_type,
        status: "imported",
        attempts: [],
        rejections: [],
        evidenceIds: [],
        manualEvidenceIds: [],
      });
      continue;
    }
    const view = views.get(id);
    if (!view) continue;
    view.version = e.version;
    if (event.type === "extraction_attempted") view.attempts.push(event.data);
    else if (event.type === "claim_rejected") view.rejections.push(event.data);
    else if (event.type === "extraction_finished") {
      view.status = event.data.outcome;
      view.evidenceIds.push(...event.data.evidence_ids);
    } else if (event.type === "manual_entry_recorded") {
      view.manualEvidenceIds.push(event.data.evidence_id);
    }
  }
  return views;
}

export function projectEvidence(events: StoredEvent[]): Map<string, EvidenceView> {
  const views = new Map<string, EvidenceView>();
  for (const e of events) {
    const id = streamKey(e.streamId, "evidence:");
    if (id === null) continue;
    const event = { type: e.type, data: e.data } as EvidenceEvent;
    if (event.type === "claim_extracted" || event.type === "claim_entered_manually") {
      views.set(id, {
        id,
        version: e.version,
        messageId: event.data.message_id,
        claim: event.data.claim,
        origin: event.type === "claim_extracted" ? "model" : "manual",
        status: "pending",
        decidedAt: null,
        answer: null,
      });
      continue;
    }
    if (event.type === "answer_recorded") {
      const { claim, ...answer } = event.data;
      views.set(id, {
        id,
        version: e.version,
        messageId: null,
        claim,
        origin: "answer",
        status: "accepted",
        decidedAt: e.recordedAt,
        answer,
      });
      continue;
    }
    if (event.type === "reply_recorded") {
      const { claim, ...reply } = event.data;
      views.set(id, {
        id,
        version: e.version,
        messageId: null,
        claim,
        origin: "reply",
        status: "accepted",
        decidedAt: e.recordedAt,
        answer: null,
        reply,
      });
      continue;
    }
    const view = views.get(id);
    if (!view) continue;
    view.version = e.version;
    if (event.type === "claim_accepted") {
      view.status = "accepted";
      view.decidedAt = e.recordedAt;
    } else if (event.type === "claim_rejected_by_user") {
      view.status = "rejected";
      view.decidedAt = e.recordedAt;
    }
  }
  return views;
}
