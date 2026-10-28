// Evidence intake commands. Model output never changes accepted evidence:
// extraction only adds pending claims, and only a user accept event makes a
// claim accepted evidence. Message text is data. Nothing in a message or a
// claim triggers an action.
import { z } from "zod";
import { CLAIM_TYPES, ClaimType, Effort, Message, sourceTypeForChannel, type EvidenceClaim } from "../domain/claim.ts";
import { checkSlotFormats } from "../domain/datetime.ts";
import { zonedIso } from "../domain/zone.ts";
import { caseTimeZone } from "../settings/events.ts";
import { OutOfScopeError, hasClinicalContent } from "../domain/scope.ts";
import { quoteAppearsIn } from "../domain/quote.ts";
import { checkClaim, extractClaims, type ExtractionResult } from "../extract/extract.ts";
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

// How a message came in, beyond its channel. `suggested` and `note` mark
// source fields an agent suggested (0007, E1). `agentName` is set for the
// report of something the person told an external agent: its claims are
// then reported through that agent, not by the person (0009, D1).
export type ImportSource = { suggested: Array<"channel" | "from" | "received_at">; note: string; agentName?: string };

// An extracted claim carries its message's source: its source type, the
// note on suggested fields and the reporting agent.
function messageClaim(claim: EvidenceClaim, m: MessageView): EvidenceClaim {
  return {
    ...claim,
    source_type: m.sourceType,
    ...(m.sourceNote ? { source_note: m.sourceNote } : {}),
    ...(m.agentName ? { agent_name: m.agentName } : {}),
  };
}

export class IntakeService {
  readonly #store: EventStore;
  readonly #client: ModelClient;
  readonly #newId: (suggested: string) => string;
  readonly #now: () => string;

  constructor(
    store: EventStore,
    client: ModelClient,
    options: { newId?: (suggested: string) => string; now?: () => string } = {},
  ) {
    this.#store = store;
    this.#client = client;
    // Evidence ids are derived from the message id, such as m2-e1 for the
    // first extracted claim of m2 and m2-u1 for the first manual entry. Short
    // stable ids are easy for a model to cite and for a person to read. The
    // stream's expected version 0 refuses a duplicate id.
    this.#newId = options.newId ?? ((suggested) => suggested);
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
  // stale edit. A report the user typed is checked for clinical content
  // first (S11). A clinical report gets the fixed decline, and nothing is
  // recorded, so no model call can follow.
  // `source` marks the fields the case agent suggested (0007, E1). Its
  // note is copied onto every claim extracted from the message.
  importMessage(input: Message, source?: ImportSource): MessageView {
    return this.#store.inCase(() => this.#importMessage(input, source));
  }

  #importMessage(input: Message, source?: ImportSource): MessageView {
    const message = Message.parse(input);
    if (message.channel === "user_report" && hasClinicalContent(message.text)) throw new OutOfScopeError();
    const event: MessageEvent = {
      type: "message_imported",
      data: {
        message,
        source_type: source?.agentName ? "reported_by_user_via_agent" : sourceTypeForChannel(message.channel),
        ...(source && source.suggested.length > 0 ? { source_suggested: source.suggested, source_note: source.note } : {}),
        ...(source?.agentName ? { agent_name: source.agentName } : {}),
      },
    };
    // A message added again after an undo withdrew it starts anew on its
    // own stream. A message still in the case is a stale edit, as before.
    const stream = messageStream(message.id);
    const version = this.#store.streamVersion(stream);
    const withdrawn = version > 0 && !projectMessages(this.#store.readStream(stream)).has(message.id);
    this.#store.append(stream, withdrawn ? version : 0, [asEvent(event)], this.#describeMessage);
    return this.message(message.id);
  }

  // How many times the message was added. Evidence ids of a message added
  // again after an undo carry the round, such as m1-r2-e1, because the
  // first round's ids stay taken.
  #idPrefix(messageId: string): string {
    const rounds = this.#store.readStream(messageStream(messageId)).filter((e) => e.type === "message_imported").length;
    return rounds <= 1 ? messageId : `${messageId}-r${rounds}`;
  }

  // Undo of adding a message (0009, design 3): the message and its claims
  // leave the case, in one transaction. Refused while one of its claims is
  // accepted or rejected, because a later review depends on it.
  withdrawMessage(messageId: string): void {
    this.#store.inCase(() => this.#withdrawMessage(messageId));
  }

  #withdrawMessage(messageId: string): void {
    this.#store.transaction(() => {
      const m = this.message(messageId);
      const ids = [...m.evidenceIds, ...m.manualEvidenceIds];
      if (m.manualEvidenceIds.length > 0) throw new InvalidRequestError(`A fact was entered by hand for message ${messageId}. Reject that fact instead.`);
      const decided = ids.map((id) => this.evidenceItem(id)).filter((e) => e.status !== "pending");
      if (decided.length > 0) {
        throw new InvalidRequestError(`${decided.length === 1 ? "A fact" : `${decided.length} facts`} from message ${messageId} ${decided.length === 1 ? "was" : "were"} reviewed. Undo those reviews first.`);
      }
      const withdrawn: EvidenceEvent = { type: "evidence_withdrawn", data: {} };
      const event: MessageEvent = { type: "message_withdrawn", data: {} };
      this.#store.appendMany([
        { streamId: messageStream(messageId), expectedVersion: m.version, events: [asEvent(event)] },
        ...ids.map((id) => ({ streamId: evidenceStream(id), expectedVersion: this.#store.streamVersion(evidenceStream(id)), events: [asEvent(withdrawn)] })),
      ]);
    });
  }

  // Keeps the case generation it started from, as the other model calls do.
  extract(
    messageId: string,
    options: { effort: Effort; expectedVersion: number },
  ): Promise<{ message: MessageView; evidence: EvidenceView[]; result: ExtractionResult }> {
    return this.#store.inCase(() => this.#extract(messageId, options));
  }

  async #extract(
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
    const prefix = this.#idPrefix(messageId);
    const evidenceWrites: StreamWrite[] = result.passed.map((claim, i) => {
      const event: EvidenceEvent = {
        type: "claim_extracted",
        data: { message_id: messageId, claim: messageClaim(claim, before), effort, attempt: finalAttempt },
      };
      return { streamId: evidenceStream(this.#newId(`${prefix}-e${i + 1}`)), expectedVersion: 0, events: [asEvent(event)] };
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
    return this.#store.inCase(() => this.#accept(evidenceId, expectedVersion));
  }

  #accept(evidenceId: string, expectedVersion: number): EvidenceView {
    return this.#decide(evidenceId, expectedVersion, { type: "claim_accepted", data: {} });
  }

  reject(evidenceId: string, expectedVersion: number): EvidenceView {
    return this.#store.inCase(() => this.#reject(evidenceId, expectedVersion));
  }

  #reject(evidenceId: string, expectedVersion: number): EvidenceView {
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

  // Undo of a review decision (0009, design 3): the item waits for review
  // again. For the activity log, inside its transaction, which has checked
  // that the decision is still the item's latest event.
  undoDecision(evidenceId: string): EvidenceView {
    return this.#store.inCase(() => {
      const event: EvidenceEvent = { type: "claim_decision_undone", data: {} };
      this.#store.append(evidenceStream(evidenceId), this.#store.streamVersion(evidenceStream(evidenceId)), [asEvent(event)], this.#describeEvidence);
      return this.evidenceItem(evidenceId);
    });
  }

  // Why an agent may not accept this claim, or null when it may (0009,
  // design 1). The claim must come from a message in the case, its quote
  // must still appear verbatim in that message's text, and its date, time
  // and event time must pass the extraction checks against the quote. A
  // fact the person entered by hand with no quote has nothing to check, so
  // only the person accepts it.
  verificationProblem(evidenceId: string): string | null {
    const e = this.evidenceItem(evidenceId);
    if (e.messageId === null) return "This fact came from no message, so there is nothing to check it against.";
    const message = this.message(e.messageId).message;
    const c = e.claim;
    if (c.quote === null || c.quote.trim() === "") return "This fact has no quote from its message to check. Accept it yourself in the app.";
    if (!(CLAIM_TYPES as readonly string[]).includes(c.claim_type)) return "Only facts from a message can be checked this way.";
    const problems = checkClaim(
      {
        claim_type: c.claim_type as ClaimType,
        date: c.slot.date,
        time: c.slot.time,
        location: c.slot.location,
        quote: c.quote,
        sender_kind: c.sender_kind,
        event_time: c.event_time,
        request_item: c.request_item,
      },
      message,
    );
    if (problems.length > 0) return `This fact did not pass the extraction checks again (${problems.join(", ")}). Accept or reject it yourself in the app.`;
    return null;
  }

  // The user enters a claim by hand, for example after extraction fell to
  // manual entry. It is recorded as reported by the user and waits in the
  // review queue like every other claim.
  //
  // The write states the message's expected version and appends a
  // manual_entry_recorded event to the message stream in the same
  // transaction, so a repeated or concurrent submit is a stale edit and
  // cannot add a duplicate claim.
  enterManually(messageId: string, expectedVersion: number, input: ManualClaimInput): EvidenceView {
    return this.#store.inCase(() => this.#enterManually(messageId, expectedVersion, input));
  }

  #enterManually(messageId: string, expectedVersion: number, input: ManualClaimInput): EvidenceView {
    const claimInput = ManualClaimInput.parse(input);
    this.#store.assertVersion(messageStream(messageId), expectedVersion, this.#describeMessage);
    const before = this.message(messageId);
    const source = before.message;
    const quote = claimInput.quote?.trim() ? claimInput.quote : null;
    if (quote !== null && !quoteAppearsIn(quote, source.text)) {
      throw new InvalidRequestError("The quote does not appear in the message.");
    }
    // The user is the source of a manual entry, so only formats are checked.
    const issues = checkSlotFormats({ date: claimInput.date, time: claimInput.time, event_time: null });
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
      evidence_time: zonedIso(this.#now(), caseTimeZone(this.#store)),
      event_time: null,
      request_item: claimInput.claim_type === "office_request" ? claimInput.request_item : null,
    };
    const id = this.#newId(`${this.#idPrefix(messageId)}-u${before.manualEvidenceIds.length + 1}`);
    const evidenceEvent: EvidenceEvent = { type: "claim_entered_manually", data: { message_id: messageId, claim } };
    const messageEvent: MessageEvent = { type: "manual_entry_recorded", data: { evidence_id: id } };
    this.#store.appendMany(
      [
        { streamId: messageStream(messageId), expectedVersion, events: [asEvent(messageEvent)] },
        { streamId: evidenceStream(id), expectedVersion: 0, events: [asEvent(evidenceEvent)] },
      ],
      (streamId, events) => (streamId.startsWith("message:") ? this.#describeMessage(streamId, events) : null),
    );
    return this.evidenceItem(id);
  }
}
