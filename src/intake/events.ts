// Event kinds for evidence intake and the projections built from them.
// A message stream holds the imported message and its extraction history.
// Each evidence item has its own stream, so a review decision states the
// version of that one item. Unknown event kinds are skipped, which leaves
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
    };

export type ExtractionOutcome = "claims_pending" | "no_claims" | "manual_entry_needed";

export type EvidenceEvent =
  | { type: "claim_extracted"; data: { message_id: string; claim: EvidenceClaim; effort: Effort; attempt: number } }
  | { type: "claim_entered_manually"; data: { message_id: string; claim: EvidenceClaim } }
  | { type: "claim_accepted"; data: Record<string, never> }
  | { type: "claim_rejected_by_user"; data: Record<string, never> };

export type MessageView = {
  id: string;
  version: number;
  message: Message;
  sourceType: SourceType;
  status: "imported" | ExtractionOutcome;
  attempts: Array<Extract<MessageEvent, { type: "extraction_attempted" }>["data"]>;
  rejections: Array<Extract<MessageEvent, { type: "claim_rejected" }>["data"]>;
  evidenceIds: string[];
};

export type ReviewStatus = "pending" | "accepted" | "rejected";

export type EvidenceView = {
  id: string;
  version: number;
  messageId: string;
  claim: EvidenceClaim;
  // "model" means model output that passed the code checks.
  origin: "model" | "manual";
  status: ReviewStatus;
  decidedAt: string | null;
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
