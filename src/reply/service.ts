// Reply commands: start a draft, let the model suggest one, edit, discard
// and approve. Code builds every draft from the case. Approval records the
// claims the template asserts as user-reported evidence and a simulated
// send. Nothing leaves the app. Every write states the expected version of
// the reply stream.
import type { CaseService } from "../case/service.ts";
import type { CaseView } from "../case/types.ts";
import type { Effort, EvidenceClaim } from "../domain/claim.ts";
import { OutOfScopeError, hasClinicalContent } from "../domain/scope.ts";
import type { ModelClient } from "../model/client.ts";
import { MODEL } from "../model/request.ts";
import { attemptData } from "../case/service.ts";
import { evidenceStream, type EvidenceEvent, type ReplyMeta } from "../intake/events.ts";
import { InvalidRequestError } from "../intake/service.ts";
import { arrivalTime } from "../slots/time.ts";
import type { EventStore, StoredEvent, StreamWrite } from "../store/event-log.ts";
import { buildDraft } from "./draft.ts";
import { REPLY_STREAM, draftEvents, openDraft, projectReplies, type ApprovalClaims, type DraftRecord, type ReplyEvent } from "./events.ts";
import { TEMPLATES, TEMPLATE_IDS, type TemplateId } from "./templates.ts";
import { MAX_INTENT_CHARS, checkReply, suggestReply } from "./suggest.ts";
import { claimConfirmation, draftClaims, draftValidity } from "./view.ts";

export const MAX_REPLY_CHARS = 2000;

const asEvent = (e: ReplyEvent | EvidenceEvent) => ({ type: e.type, data: e.data });

// The template call defaults to effort low, like the other D2 calls.
export type ReplyOptions = { now?: () => string; effort?: Effort; model?: string };

export class ReplyService {
  readonly #store: EventStore;
  readonly #kase: CaseService;
  readonly #client: ModelClient;
  readonly #now: () => string;
  readonly #effort: Effort | undefined;
  readonly #model: string;

  constructor(store: EventStore, kase: CaseService, client: ModelClient, options: ReplyOptions = {}) {
    this.#store = store;
    this.#kase = kase;
    this.#client = client;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#effort = options.effort;
    this.#model = options.model ?? MODEL;
  }

  #describe = (_streamId: string, events: StoredEvent[]) => {
    const log = projectReplies(events);
    return { version: log.version, openDraft: openDraft(log)?.id ?? null };
  };

  // Writes the reply events in one transaction that first checks, inside
  // the lock, that the draft's slot is not archived. An archive that
  // commits after the command read the case still stops the write.
  #appendFor(slotKey: string | null, write: () => void): void {
    this.#store.transaction(() => {
      if (slotKey !== null && this.#kase.archivedKeys().has(slotKey)) {
        throw new InvalidRequestError(`Appointment ${slotKey} is archived. Undo the archive first.`);
      }
      write();
    });
  }

  #open(draftId: string): DraftRecord {
    const draft = openDraft(this.#kase.replyState().log);
    if (!draft || draft.id !== draftId) throw new InvalidRequestError(`Draft ${draftId} is not open.`);
    return draft;
  }

  // The user picks a template and a slot. Code blocks a template that the
  // slot's state does not allow (S9) or that needs a field the slot lacks
  // (S7).
  start(template: string, slotKey: string, expectedVersion: number): CaseView {
    return this.#store.inCase(() => this.#start(template, slotKey, expectedVersion));
  }

  #start(template: string, slotKey: string, expectedVersion: number): CaseView {
    this.#store.assertVersion(REPLY_STREAM, expectedVersion, this.#describe);
    if (!(TEMPLATE_IDS as readonly string[]).includes(template)) throw new InvalidRequestError(`No reply template ${template}.`);
    const { context, log } = this.#kase.replyState();
    const built = buildDraft(template as TemplateId, slotKey, context);
    if (!built.ok) throw new InvalidRequestError(`Code blocked this reply: ${built.problems.join(", ")}.`);
    const events = draftEvents(log, {
      template: built.content.template,
      slot_key: built.content.slot.key,
      slot_label: built.content.slot.label,
      origin: "manual",
      question_id: null,
      suggestion_id: null,
      fields: built.content.fields,
      declines: built.content.declines,
      text: built.content.text,
    });
    this.#appendFor(built.content.slot.key, () => this.#store.append(REPLY_STREAM, expectedVersion, events.map(asEvent), this.#describe));
    return this.#kase.view();
  }

  // The model picks a template and a slot from the user's note. The note is
  // checked for clinical content first (R-f): a clinical note gets the fixed
  // decline, records nothing and makes no model call. A valid pick opens a
  // draft that code builds. A no-fit answer is recorded with its reason, and
  // the user picks by hand. After two invalid outputs the suggestion is
  // recorded with its attempts and the user picks by hand.
  // Keeps the case generation it started from, so a Delete case during the
  // model call makes the write fail instead of landing in the empty case.
  suggest(intent: string | null, expectedVersion: number): Promise<CaseView> {
    return this.#store.inCase(() => this.#suggest(intent, expectedVersion));
  }

  async #suggest(intent: string | null, expectedVersion: number): Promise<CaseView> {
    const note = intent?.trim() ? intent.trim() : null;
    if (note !== null && note.length > MAX_INTENT_CHARS) throw new InvalidRequestError(`The note is longer than ${MAX_INTENT_CHARS} characters.`);
    if (note !== null && hasClinicalContent(note)) throw new OutOfScopeError();
    // Check before spending a model call. The append below checks again.
    this.#store.assertVersion(REPLY_STREAM, expectedVersion, this.#describe);
    const result = await suggestReply(note, this.#kase.replyState().context, this.#client, { effort: this.#effort, model: this.#model });
    // Evidence may have changed during the model call, and evidence writes do
    // not move the reply stream. Read the case again and run every check on
    // the model's final output against it, field values included. A pick
    // that no longer passes falls back to manual entry.
    const { context, log } = this.#kase.replyState();
    const final = result.outcome === "valid" ? result.attempts.at(-1)!.output! : null;
    const caseChanged = final ? checkReply(final, context, note) : [];
    const built = final?.template && final.slot_id && caseChanged.length === 0 ? buildDraft(final.template, final.slot_id, context) : null;
    const suggestionId = `s${log.suggestions.length + 1}`;
    const events: ReplyEvent[] = [
      {
        type: "reply_suggested",
        data: {
          suggestion_id: suggestionId,
          intent: note,
          key: result.key,
          outcome: built?.ok ? "valid" : result.outcome === "no_fit" ? "no_fit" : "manual_needed",
          template: built?.ok ? result.template : null,
          slot_key: built?.ok ? result.slotKey : null,
          no_fit_reason: result.noFitReason,
          attempts: result.attempts.map(attemptData),
          case_changed: caseChanged,
        },
      },
    ];
    if (built?.ok) {
      events.push(
        ...draftEvents(log, {
          template: built.content.template,
          slot_key: built.content.slot.key,
          slot_label: built.content.slot.label,
          origin: "model",
          question_id: null,
          suggestion_id: suggestionId,
          fields: built.content.fields,
          declines: built.content.declines,
          text: built.content.text,
        }),
      );
    }
    this.#appendFor(built?.ok ? built.content.slot.key : null, () => this.#store.append(REPLY_STREAM, expectedVersion, events.map(asEvent), this.#describe));
    return this.#kase.view();
  }

  // Edited text is never checked against the case again (R-e). The draft
  // keeps the label "Edited by you. Not checked." until it is discarded.
  // The scope check still applies (R-f): an edit that asks for clinical
  // content gets the fixed decline and nothing is recorded.
  edit(draftId: string, text: string, expectedVersion: number): CaseView {
    return this.#store.inCase(() => this.#edit(draftId, text, expectedVersion));
  }

  #edit(draftId: string, text: string, expectedVersion: number): CaseView {
    this.#store.assertVersion(REPLY_STREAM, expectedVersion, this.#describe);
    const draft = this.#open(draftId);
    if (text.trim().length === 0) throw new InvalidRequestError("The reply text is empty.");
    if (text.length > MAX_REPLY_CHARS) throw new InvalidRequestError(`The reply text is longer than ${MAX_REPLY_CHARS} characters.`);
    if (hasClinicalContent(text)) throw new OutOfScopeError();
    if (text === draft.text) throw new InvalidRequestError("The text did not change.");
    const event: ReplyEvent = { type: "reply_edited", data: { draft_id: draftId, text } };
    this.#store.append(REPLY_STREAM, expectedVersion, [asEvent(event)], this.#describe);
    return this.#kase.view();
  }

  discard(draftId: string, expectedVersion: number): CaseView {
    return this.#store.inCase(() => this.#discard(draftId, expectedVersion));
  }

  #discard(draftId: string, expectedVersion: number): CaseView {
    this.#store.assertVersion(REPLY_STREAM, expectedVersion, this.#describe);
    this.#open(draftId);
    const event: ReplyEvent = { type: "reply_discarded", data: { draft_id: draftId, reason: "by_user" } };
    this.#store.append(REPLY_STREAM, expectedVersion, [asEvent(event)], this.#describe);
    return this.#kase.view();
  }

  // Undo of a draft's start (0009, design 3): the open draft is discarded.
  // For the activity log, inside its transaction.
  undoStart(draftId: string): void {
    this.#store.inCase(() => {
      this.#open(draftId);
      const event: ReplyEvent = { type: "reply_discarded", data: { draft_id: draftId, reason: "undone" } };
      this.#store.append(REPLY_STREAM, this.#store.streamVersion(REPLY_STREAM), [asEvent(event)], this.#describe);
    });
  }

  // Undo of a discard: the draft is open again. Refused while another
  // draft is open. Approval checks the draft against the case as always.
  undoDiscard(draftId: string): void {
    this.#store.inCase(() => this.#undoDiscard(draftId));
  }

  #undoDiscard(draftId: string): void {
    const log = this.#kase.replyState().log;
    const open = openDraft(log);
    if (open) throw new InvalidRequestError(`Draft ${open.id} is open. Finish or discard it first.`);
    const draft = log.drafts.find((d) => d.id === draftId);
    if (!draft || draft.status !== "discarded") throw new InvalidRequestError(`Draft ${draftId} is not discarded.`);
    const event: ReplyEvent = { type: "reply_discard_undone", data: { draft_id: draftId } };
    this.#appendFor(draft.slotKey, () => this.#store.append(REPLY_STREAM, this.#store.streamVersion(REPLY_STREAM), [asEvent(event)], this.#describe));
  }

  // Approval needs the name of every field the user read back, at the
  // reply-stream version the readback was done at. Any edit moves the
  // version, so a readback from before an edit is a stale edit. The draft
  // must still match the case. It records the claims the template asserts
  // (R-a), the approval and the simulated send in one transaction. When the
  // text was edited away from the code render, the claims are recorded only
  // if the user confirms the statement code builds from the template
  // (R-h). The send is only the local event: no network call is made (S12).
  approve(draftId: string, confirmedFields: string[], expectedVersion: number, options: { confirmClaim?: boolean } = {}): CaseView {
    return this.#store.inCase(() => this.#approve(draftId, confirmedFields, expectedVersion, options));
  }

  #approve(draftId: string, confirmedFields: string[], expectedVersion: number, options: { confirmClaim?: boolean } = {}): CaseView {
    this.#store.assertVersion(REPLY_STREAM, expectedVersion, this.#describe);
    const { context, view } = this.#kase.replyState();
    const draft = this.#open(draftId);
    const validity = draftValidity(draft, context);
    if (!validity.valid) {
      throw new InvalidRequestError(`The case changed since draft ${draftId} was made (${validity.problems.join(", ")}). Discard it and start a new one.`);
    }
    const names = draft.fields.map((f) => f.name);
    if (new Set(confirmedFields).size !== names.length || !names.every((n) => confirmedFields.includes(n))) {
      throw new InvalidRequestError(`Read back every field before approval: ${names.join(", ")}.`);
    }
    // The edit was checked when it was saved. Check again, in case the
    // stored text came from before the check existed.
    if (draft.text !== draft.renderedText && hasClinicalContent(draft.text)) throw new OutOfScopeError();

    const claims = draftClaims(draft);
    const needsConfirmation = claimConfirmation(draft) !== null;
    const targets = needsConfirmation && options.confirmClaim !== true ? [] : claims;
    const outcome: ApprovalClaims = claims.length === 0 ? "none" : targets.length === 0 ? "not_confirmed" : "recorded";
    const now = this.#kase.zoned(this.#now());
    const accepted = context.evidence.filter((e) => e.status === "accepted");
    const latest = accepted.reduce((max, e) => Math.max(max, arrivalTime(e)), Number.NEGATIVE_INFINITY);
    const after = Number.isFinite(latest) ? new Date(latest).toISOString() : now;
    const writes: StreamWrite[] = targets.map((t, i) => {
      const slot = view.slots.find((s) => s.key === t.slotKey)!;
      const claim: EvidenceClaim = {
        claim_type: t.type,
        slot: { date: slot.date, time: slot.time, location: null },
        quote: `Approved reply: ${t.type === "request" ? "I accept" : "I decline"} ${slot.label}`,
        source_type: "reported_by_user",
        sender_kind: "person",
        evidence_time: now,
        event_time: null,
        request_item: null,
      };
      const meta: ReplyMeta = { draft_id: draftId, after, index: i };
      const event: EvidenceEvent = { type: "reply_recorded", data: { claim, ...meta } };
      return { streamId: evidenceStream(`reply-${draftId}-${i + 1}`), expectedVersion: 0, events: [asEvent(event)] };
    });
    const events: ReplyEvent[] = [
      {
        type: "reply_approved",
        data: {
          draft_id: draftId,
          confirmed_fields: names,
          text: draft.text,
          edited: draft.edited,
          evidence_ids: writes.map((w) => w.streamId.slice("evidence:".length)),
          claims: outcome,
        },
      },
      { type: "reply_send_simulated", data: { draft_id: draftId } },
    ];
    this.#appendFor(draft.slotKey, () =>
      this.#store.appendMany([{ streamId: REPLY_STREAM, expectedVersion, events: events.map(asEvent) }, ...writes], (streamId, evs) =>
        streamId === REPLY_STREAM ? this.#describe(streamId, evs) : null,
      ),
    );
    return this.#kase.view();
  }
}
