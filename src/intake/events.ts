// Event kinds for evidence intake and the projections built from them.
// A message stream holds the imported message and its extraction history.
// Each evidence item has its own stream, so a review decision states the
// version of that one item. An answer to a question also creates evidence
// items. The user's tap on the answer is their review, so an answer item is
// accepted when it is recorded. An approved reply creates evidence items the
// same way, because the approval is the user's review. A change an agent
// proposed becomes an evidence item only when the user confirms it in the
// app, so that item is also accepted when it is recorded. Undo of a review
// decision appends claim_decision_undone, which returns the item to
// pending. Undo of an answer appends evidence_withdrawn to each item the
// answer created, which leaves the case. Unknown event kinds are skipped.
import type { Effort, EvidenceClaim, Message, SourceType } from "../domain/claim.ts";
import type { AttemptProblem, ClaimProblem } from "../extract/extract.ts";
import type { ModelClaim, TokenUsage } from "../model/request.ts";
import type { StoredEvent } from "../store/event-log.ts";

export const messageStream = (id: string) => `message:${id}`;
export const evidenceStream = (id: string) => `evidence:${id}`;

export type MessageEvent =
  | {
      type: "message_imported";
      data: {
        message: Message;
        source_type: SourceType;
        // Source fields the assistant suggested, and the note the review
        // shows for them. Absent for messages imported any other way.
        source_suggested?: Array<"channel" | "from" | "received_at">;
        source_note?: string;
      };
    }
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
  | { type: "manual_entry_recorded"; data: { evidence_id: string } }
  // Undo of adding the message (0009, design 3). The message and its
  // claims leave the case. Pasting it again adds it anew.
  | { type: "message_withdrawn"; data: Record<string, never> };

export type ExtractionOutcome = "claims_pending" | "no_claims" | "manual_entry_needed";

export type EvidenceEvent =
  | { type: "claim_extracted"; data: { message_id: string; claim: EvidenceClaim; effort: Effort; attempt: number } }
  | { type: "claim_entered_manually"; data: { message_id: string; claim: EvidenceClaim } }
  | { type: "claim_accepted"; data: Record<string, never> }
  | { type: "claim_rejected_by_user"; data: Record<string, never> }
  | { type: "answer_recorded"; data: { claim: EvidenceClaim } & AnswerMeta }
  | { type: "reply_recorded"; data: { claim: EvidenceClaim } & ReplyMeta }
  // From before sprint 8: a change an agent proposed that the user
  // confirmed. Kept so old cases still project.
  | { type: "agent_report_confirmed"; data: { proposal_id: string; grant_id: string; claim: EvidenceClaim } }
  | { type: "claim_decision_undone"; data: Record<string, never> }
  | { type: "evidence_withdrawn"; data: Record<string, never> };

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
  // The source fields the assistant suggested, and the note to show beside
  // them. Empty and null for messages imported any other way.
  sourceSuggested: Array<"channel" | "from" | "received_at">;
  sourceNote: string | null;
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
  // Null for an answer item, a reply item or a confirmed agent report, which
  // come from no message.
  messageId: string | null;
  claim: EvidenceClaim;
  // "model" means model output that passed the code checks. "agent" means a
  // change an agent proposed and the user confirmed, before sprint 8.
  origin: "model" | "manual" | "answer" | "reply" | "agent";
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
        sourceSuggested: event.data.source_suggested ?? [],
        sourceNote: event.data.source_note ?? null,
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
    } else if (event.type === "message_withdrawn") {
      views.delete(id);
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
    if (event.type === "agent_report_confirmed") {
      views.set(id, {
        id,
        version: e.version,
        messageId: null,
        claim: event.data.claim,
        origin: "agent",
        status: "accepted",
        decidedAt: e.recordedAt,
        answer: null,
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
    } else if (event.type === "claim_decision_undone") {
      view.status = "pending";
      view.decidedAt = null;
    } else if (event.type === "evidence_withdrawn") {
      views.delete(id);
    }
  }
  return views;
}
