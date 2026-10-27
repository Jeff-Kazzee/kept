// Evidence intake commands. Model output never changes accepted evidence:
// extraction only adds pending claims, and only a user accept event makes a
// claim accepted evidence. Message text is data. Nothing in a message or a
// claim triggers an action.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ClaimType, Effort, Message, sourceTypeForChannel, type EvidenceClaim } from "../domain/claim.ts";
import { checkSlotValues } from "../domain/datetime.ts";
import { quoteAppearsIn } from "../domain/quote.ts";
import { extractClaims, type ExtractionResult } from "../extract/extract.ts";
import type { ModelClient } from "../model/client.ts";
import type { EventStore, StoredEvent, StreamWrite } from "../store/event-log.ts";
import {
  evidenceStream,
  messageStream,
  projectEvidence,
  projectMessages,
  type EvidenceEvent,
  type EvidenceView,
  type ExtractionOutcome,
  type MessageEvent,
  type MessageView,
} from "./events.ts";

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export class InvalidRequestError extends Error {
  override name = "InvalidRequestError";
}

export const ManualClaimInput = z
  .object({
    claim_type: ClaimType,
    date: z.string().nullable(),
    time: z.string().nullable(),
    location: z.string().trim().min(1).max(300).nullable(),
    quote: z.string().max(2000).nullable(),
    request_item: z.string().trim().min(1).max(300).nullable(),
  })
  .strict();
export type ManualClaimInput = z.infer<typeof ManualClaimInput>;

const asEvent = (e: MessageEvent | EvidenceEvent) => ({ type: e.type, data: e.data });

export class IntakeService {
  readonly #store: EventStore;
  readonly #client: ModelClient;
  readonly #newId: () => string;
  readonly #now: () => string;

  constructor(
    store: EventStore,
    client: ModelClient,
    options: { newId?: () => string; now?: () => string } = {},
  ) {
    this.#store = store;
    this.#client = client;
    this.#newId = options.newId ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get modelLabel(): string {
    return this.#client.label;
  }

  #describeMessage = (_streamId: string, events: StoredEvent[]) => [...projectMessages(events).values()][0] ?? null;
  #describeEvidence = (_streamId: string, events: StoredEvent[]) => [...projectEvidence(events).values()][0] ?? null;

  message(id: string): MessageView {
    const view = projectMessages(this.#store.readStream(messageStream(id))).get(id);
    if (!view) throw new NotFoundError(`No message ${id}.`);
    return view;
  }

  evidenceItem(id: string): EvidenceView {
    const view = projectEvidence(this.#store.readStream(evidenceStream(id))).get(id);
    if (!view) throw new NotFoundError(`No evidence item ${id}.`);
    return view;
  }

  messages(): MessageView[] {
    return [...projectMessages(this.#store.readAll()).values()];
  }

  evidence(): EvidenceView[] {
    return [...projectEvidence(this.#store.readAll()).values()];
  }

  reviewQueue(): EvidenceView[] {
    return this.evidence().filter((e) => e.status === "pending");
  }

  acceptedEvidence(): EvidenceView[] {
    return this.evidence().filter((e) => e.status === "accepted");
  }

  // A new message stream starts at version 0. Importing an id twice is a
  // stale edit.
  importMessage(input: Message): MessageView {
    const message = Message.parse(input);
    const event: MessageEvent = {
      type: "message_imported",
      data: { message, source_type: sourceTypeForChannel(message.channel) },
    };
    this.#store.append(messageStream(message.id), 0, [asEvent(event)], this.#describeMessage);
    return this.message(message.id);
  }

  async extract(
    messageId: string,
    options: { effort: Effort; expectedVersion: number },
  ): Promise<{ message: MessageView; evidence: EvidenceView[]; result: ExtractionResult }> {
    const effort = Effort.parse(options.effort);
    const before = this.message(messageId);
    // Check before spending a model call. The append below checks again.
    this.#store.assertVersion(messageStream(messageId), options.expectedVersion, this.#describeMessage);
    if (before.status !== "imported") throw new InvalidRequestError(`Message ${messageId} was already extracted.`);

    const result = await extractClaims(before.message, this.#client, { effort });

    const messageEvents: MessageEvent[] = [];
    for (const a of result.attempts) {
      messageEvents.push({
        type: "extraction_attempted",
        data: {
          attempt: a.attempt,
          effort: a.effort,
          model: a.model,
          outcome: a.outcome,
          problem: a.problem,
          detail: a.detail,
          usage: a.usage,
          latency_ms: a.latencyMs,
          claim_count: a.claims.length,
        },
      });
    }
    for (const r of result.rejected) {
      messageEvents.push({ type: "claim_rejected", data: { attempt: r.attempt, effort, claim: r.claim, problems: r.problems } });
    }

    const finalAttempt = result.attempts.at(-1)!.attempt;
    const evidenceWrites: StreamWrite[] = result.passed.map((claim) => {
      const event: EvidenceEvent = {
        type: "claim_extracted",
        data: { message_id: messageId, claim, effort, attempt: finalAttempt },
      };
      return { streamId: evidenceStream(this.#newId()), expectedVersion: 0, events: [asEvent(event)] };
    });
    const evidenceIds = evidenceWrites.map((w) => w.streamId.slice("evidence:".length));
    const outcome: ExtractionOutcome = result.needsManualEntry
      ? "manual_entry_needed"
      : evidenceIds.length > 0
        ? "claims_pending"
        : "no_claims";
    messageEvents.push({ type: "extraction_finished", data: { effort, outcome, evidence_ids: evidenceIds } });

    this.#store.appendMany(
      [{ streamId: messageStream(messageId), expectedVersion: options.expectedVersion, events: messageEvents.map(asEvent) }, ...evidenceWrites],
      (streamId, events) => (streamId.startsWith("message:") ? this.#describeMessage(streamId, events) : null),
    );
    return { message: this.message(messageId), evidence: evidenceIds.map((id) => this.evidenceItem(id)), result };
  }

  accept(evidenceId: string, expectedVersion: number): EvidenceView {
    return this.#decide(evidenceId, expectedVersion, { type: "claim_accepted", data: {} });
  }

  reject(evidenceId: string, expectedVersion: number): EvidenceView {
    return this.#decide(evidenceId, expectedVersion, { type: "claim_rejected_by_user", data: {} });
  }

  #decide(evidenceId: string, expectedVersion: number, event: EvidenceEvent): EvidenceView {
    const current = this.evidenceItem(evidenceId);
    if (current.status !== "pending" && current.version === expectedVersion) {
      throw new InvalidRequestError(`Evidence item ${evidenceId} was already ${current.status}.`);
    }
    this.#store.append(evidenceStream(evidenceId), expectedVersion, [asEvent(event)], this.#describeEvidence);
    return this.evidenceItem(evidenceId);
  }

  // The user enters a claim by hand, for example after extraction fell to
  // manual entry. It is recorded as reported by the user and waits in the
  // review queue like every other claim.
  enterManually(messageId: string, input: ManualClaimInput): EvidenceView {
    const claimInput = ManualClaimInput.parse(input);
    const source = this.message(messageId).message;
    const quote = claimInput.quote?.trim() ? claimInput.quote : null;
    if (quote !== null && !quoteAppearsIn(quote, source.text)) {
      throw new InvalidRequestError("The quote does not appear in the message.");
    }
    const issues = checkSlotValues({ date: claimInput.date, time: claimInput.time, event_time: null, quote: quote ?? "" });
    if (issues.length > 0) throw new InvalidRequestError(`Invalid claim: ${issues.join(", ")}.`);
    if (claimInput.claim_type === "office_request" && !claimInput.request_item) {
      throw new InvalidRequestError("An office request needs the item to bring or the task to do.");
    }

    const claim: EvidenceClaim = {
      claim_type: claimInput.claim_type,
      slot: { date: claimInput.date, time: claimInput.time, location: claimInput.location },
      quote,
      source_type: "reported_by_user",
      sender_kind: "unknown",
      evidence_time: this.#now(),
      event_time: null,
      request_item: claimInput.claim_type === "office_request" ? claimInput.request_item : null,
    };
    const id = this.#newId();
    const event: EvidenceEvent = { type: "claim_entered_manually", data: { message_id: messageId, claim } };
    this.#store.append(evidenceStream(id), 0, [asEvent(event)], this.#describeEvidence);
    return this.evidenceItem(id);
  }
}
