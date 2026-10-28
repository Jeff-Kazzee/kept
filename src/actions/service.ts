// Case actions (0009, J1 and design 1 and 3). One place where every action
// on the case is defined, for the person in the app, the in-app agent and
// an external agent over MCP. Each action runs the existing domain command
// with its checks and expected versions, and writes its activity entry in
// the same transaction. Undo reverses one entry with a reversing event,
// after checking inside the same transaction that the entry is still in
// effect and that no later action depends on it.
//
// What only the person may do stays out of the agent paths: approving a
// reply (the simulated send), editing a draft's text, entering a fact by
// hand and Delete case. Delete case is not an action here at all: it
// erases the activity log with the rest of the case.
import { ACTIVITY_STREAM, activityEntry, projectActivity, type ActivityEvent, type ActivityRecord, type UndoSpec } from "../activity/events.ts";
import type { ActivityActor, ActivityEntry, ActivityTarget, ActivityView } from "../activity/types.ts";
import type { CaseService } from "../case/service.ts";
import type { CaseView, ConflictView } from "../case/types.ts";
import type { Effort, EvidenceClaim, Message } from "../domain/claim.ts";
import { zonedIso } from "../domain/zone.ts";
import type { EvidenceView, MessageView } from "../intake/events.ts";
import { InvalidRequestError, NotFoundError, type ImportSource, type IntakeService, type ManualClaimInput } from "../intake/service.ts";
import { actorFor, type RecordView } from "../records/events.ts";
import type { RecordsService } from "../records/service.ts";
import type { ReplyService } from "../reply/service.ts";
import { TEMPLATES, type TemplateId } from "../reply/templates.ts";
import { restoreTimezone, setTimezone } from "../settings/settings.ts";
import { ASSISTANT_NAME, EXTERNAL_AGENT_NAME, slotKey, slotLabel } from "../slots/labels.ts";
import { StaleEditError, type EventStore, type StoredEvent } from "../store/event-log.ts";
import { randomUUID } from "node:crypto";
import type { CalendarUndo, SyncOutcome, WritePlan } from "../google/calendar.ts";
import { GoogleError, type GoogleErrorCode } from "../google/http.ts";
import {
  GOOGLE_INTENTS_STREAM,
  GoogleBusyError,
  OWNER,
  RUNNING,
  intentAccount,
  intentClosure,
  openIntents,
  reconcilable,
  type GoogleIntent,
  type IntentCloseReason,
} from "../google/intents.ts";
import { undoGoogleActivity, type GoogleActivityKind, type GoogleServices } from "../google/tools.ts";

// `google` is the built-in Google connection (0012), when the app has one.
export type ActionServices = { intake: IntakeService; kase: CaseService; reply: ReplyService; records: RecordsService; google?: GoogleServices };

// Who acts, and where to report each activity entry once it commits. The
// chat stream sends them as `action` events.
export type By = { actor: ActivityActor; onEntry?: (entry: ActivityEntry) => void };

export const YOU: By = { actor: "you" };

// A refused undo, with a plain sentence that says why. The API answers 409
// `undo_blocked`.
export class UndoBlockedError extends Error {
  override name = "UndoBlockedError";
}

// A Google answer that may or may not have come after a write.
const ambiguous = (code: GoogleErrorCode | string) => code === "google_unavailable" || code === "google_invalid_response";

// An action only the person may take, attempted by an agent.
export class PersonOnlyError extends InvalidRequestError {
  override name = "PersonOnlyError";
}

type EntryData = {
  kind: string;
  summary: string;
  target: ActivityTarget;
  undo: UndoSpec | null;
  whyNot?: string;
  slotKeys?: string[];
  reverses?: string;
};

const CLAIM_WORDS: Record<EvidenceClaim["claim_type"], string> = {
  offer: "offer",
  confirm: "confirmation",
  cancel: "cancellation",
  move: "move",
  reminder: "reminder",
  office_request: "office request",
  request: "request",
  decline: "decline",
  clarify: "detail",
};

// "the offer for Thursday 11/12 10:30 AM". Only code's words: a request
// item or a place is message text, so it is left out.
function claimWords(c: EvidenceClaim): string {
  const words = CLAIM_WORDS[c.claim_type] ?? "fact";
  const article = c.claim_type === "office_request" ? "an" : "the";
  return c.slot.date === null ? `${article} ${words}` : `${article} ${words} for ${slotLabel(c.slot.date, c.slot.time)}`;
}

const keyLabel = (key: string) => {
  const [date, time] = key.split("T");
  return slotLabel(date!, time ?? null);
};

const listLabels = (keys: string[]) => {
  const labels = [...new Set(keys)].map(keyLabel);
  return labels.length <= 1 ? (labels[0] ?? "the case") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
};

const describeActivity = (_streamId: string, events: StoredEvent[]) => ({ activityVersion: projectActivity(events).version });

const NOT_UNDOABLE = {
  extract: "Undo adding the message instead. That also removes its facts.",
  manual: "A fact entered by hand cannot be undone. Reject it instead.",
  calendar: "Loading a calendar cannot be undone. Load the calendar again to replace it.",
  explain: "An explanation changes nothing in your schedule, so there is nothing to undo.",
  suggest: "A template suggestion changes nothing in your schedule, so there is nothing to undo.",
  edit: "An edit to a draft cannot be undone. Edit the text again, or discard the draft.",
  approve: "The reply was approved and its send simulated. A sent reply cannot be unsent.",
  undo: "An undo cannot be undone. Make the change again instead.",
  recordUndo: "This undo cannot be undone. Make the change again instead.",
} as const;

// An undo that would throw away the person's own edit of a draft.
const editedDraft = (id: string) => `You edited draft ${id} after it was started, so undo would throw your edit away. Discard the draft yourself if you no longer want it.`;

export class CaseActions {
  readonly #store: EventStore;
  readonly #intake: IntakeService;
  readonly #kase: CaseService;
  readonly #reply: ReplyService;
  readonly #records: RecordsService;
  readonly #google: GoogleServices | null;

  constructor(store: EventStore, services: ActionServices) {
    this.#store = store;
    this.#intake = services.intake;
    this.#kase = services.kase;
    this.#reply = services.reply;
    this.#records = services.records;
    this.#google = services.google ?? null;
  }

  // The activity log, newest first, with times in the case's zone.
  activity(): ActivityView {
    const log = projectActivity(this.#store.readStream(ACTIVITY_STREAM));
    const zone = this.#kase.timeZone();
    return { activityVersion: log.version, entries: log.records.map((r) => activityEntry(r, (iso) => zonedIso(iso, zone))).reverse() };
  }

  activityVersion(): number {
    return this.#store.streamVersion(ACTIVITY_STREAM);
  }

  // Appends one entry. Called inside the action's transaction. The entry
  // id is the stream version it takes, such as a7.
  #log(by: By, d: EntryData): ActivityEntry {
    const version = this.#store.streamVersion(ACTIVITY_STREAM) + 1;
    const data: Extract<ActivityEvent, { type: "activity_recorded" }>["data"] = {
      id: `a${version}`,
      actor: by.actor,
      kind: d.kind,
      summary: d.summary,
      target: d.target,
      undo: d.undo,
      why_not: d.undo === null ? (d.whyNot ?? null) : null,
      slot_keys: [...new Set(d.slotKeys ?? [])],
      ...(d.reverses ? { reverses: d.reverses } : {}),
    };
    const [stored] = this.#store.appendSystem(ACTIVITY_STREAM, [{ type: "activity_recorded", data }]);
    const record: ActivityRecord = { ...data, seq: stored!.seq, recordedAt: stored!.recordedAt, undoneAt: null, undoneBy: null };
    return activityEntry(record, (iso) => this.#kase.zoned(iso));
  }

  // A synchronous action: the command and its entry in one transaction.
  // The entry is reported once the transaction commits.
  #act<T>(by: By, run: () => T, entry: (result: T) => EntryData): T {
    let logged: ActivityEntry | null = null;
    const result = this.#store.inCase(() =>
      this.#store.transaction(() => {
        const r = run();
        logged = this.#log(by, entry(r));
        return r;
      }),
    );
    if (logged) by.onEntry?.(logged);
    return result;
  }

  // An action that waits for a model before it writes. The entry is
  // written by a hook inside the command's own write transaction, once.
  async #actAsync<T>(by: By, run: () => Promise<T>, entry: () => EntryData | null): Promise<T> {
    let logged: ActivityEntry | null = null;
    const result = await this.#store.withWriteHook(() => {
      if (logged) return;
      const d = entry();
      if (d) logged = this.#log(by, d);
    }, run);
    if (logged) by.onEntry?.(logged);
    return result;
  }

  #agentName(by: By): string | null {
    return by.actor === "you" ? null : by.actor === "agent" ? ASSISTANT_NAME : EXTERNAL_AGENT_NAME;
  }

  #personOnly(by: By, what: string): void {
    if (by.actor !== "you") throw new PersonOnlyError(`Only you can ${what}, in the app.`);
  }

  // The appointments an evidence item is placed on, and its own slot.
  #slotsOf(e: EvidenceView, view: CaseView): string[] {
    const keys = view.slots.filter((s) => s.evidenceIds.includes(e.id)).map((s) => s.key);
    if (e.claim.slot.date) keys.push(slotKey(e.claim.slot.date, e.claim.slot.time));
    return keys;
  }

  // Messages and extraction.

  importMessage(by: By, message: Message, source?: ImportSource): MessageView {
    const gmail = source?.importedFrom === "gmail";
    return this.#act(
      by,
      () => this.#intake.importMessage(message, source),
      (m) => ({
        // A message read from Gmail has the kind sprint 9's activity list
        // shows for it (0012, G19). Its undo is the same.
        kind: gmail ? "gmail_message_imported" : "message_imported",
        summary: gmail ? `Added message ${m.id} from Gmail (email).` : `Added message ${m.id} (${m.message.channel.replaceAll("_", " ")}).`,
        target: { type: "message", id: m.id },
        undo: { kind: "message_import", message_id: m.id },
      }),
    );
  }

  // Google Calendar writes (0012, review round 3, findings 1 to 3). The
  // write at Google is a network call, so it cannot share a transaction
  // with its entry. An intent is recorded first, in the store, then the
  // write runs, then one transaction writes the entry and closes the
  // intent. An intent left open, because that last transaction failed or
  // Google's answer was lost, is reconciled by reconcileGoogle.

  #openIntents(): Array<GoogleIntent & { openedAt: string }> {
    return openIntents(this.#store.readStream(GOOGLE_INTENTS_STREAM));
  }

  // Inside a transaction. Refuses while another intent for the same
  // appointment is open.
  #openIntent(intent: GoogleIntent): void {
    const busy = this.#openIntents().find((i) => i.slot_key === intent.slot_key);
    if (busy) throw new GoogleBusyError(`A Google Calendar change for ${keyLabel(intent.slot_key)} is still in progress. Try again in a moment.`);
    this.#store.appendSystem(GOOGLE_INTENTS_STREAM, [{ type: "google_intent_opened", data: intent }]);
  }

  #closeIntent(intentId: string, outcome: "logged" | "abandoned", entryId: string | null, reason?: IntentCloseReason): void {
    this.#store.appendSystem(GOOGLE_INTENTS_STREAM, [{ type: "google_intent_closed", data: { intent_id: intentId, outcome, entry_id: entryId, ...(reason ? { reason } : {}) } }]);
  }

  #isOpen(intentId: string): boolean {
    return this.#openIntents().some((i) => i.intent_id === intentId);
  }

  // The entry an activity id names, as the public entry.
  #entryById(id: string | null): ActivityEntry | null {
    if (id === null) return null;
    return this.activity().entries.find((e) => e.id === id) ?? null;
  }

  // Closes every open Google intent with no entry, as when the person
  // disconnects Google or connects another account or calendar (review
  // round 4, item 3). Their writes, if any reached Google, belong to the
  // old connection.
  closeGoogleIntents(reason: "disconnected" | "account_changed"): number {
    let closed = 0;
    this.#store.inCase(() =>
      this.#store.transaction(() => {
        for (const i of this.#openIntents()) {
          this.#closeIntent(i.intent_id, "abandoned", null, reason);
          closed += 1;
        }
      }),
    );
    return closed;
  }

  #googleEntry(by: By, d: { kind: GoogleActivityKind; summary: string; slotKey: string; undo: CalendarUndo | null; whyNot?: string }): ActivityEntry {
    return this.#log(by, {
      kind: d.kind,
      summary: d.summary,
      target: { type: "slot", id: d.slotKey },
      undo: d.undo ? { kind: "google_calendar", undo: d.undo } : null,
      whyNot: d.whyNot ?? "This Google Calendar change has no undo.",
      slotKeys: [d.slotKey],
    });
  }

  // One calendar write: the intent, the write at Google through `execute`,
  // then the entry and the closed intent in one transaction. `entryFor`
  // gives the kind and summary of what happened, or null when nothing was
  // written. `expected` is what the plan expects, kept with the intent.
  async googleWrite(
    by: By,
    plan: WritePlan,
    expected: { kind: GoogleActivityKind; summary: string },
    execute: () => Promise<SyncOutcome>,
    entryFor: (outcome: SyncOutcome) => { kind: GoogleActivityKind; summary: string } | null,
  ): Promise<{ outcome: SyncOutcome; entry: ActivityEntry | null }> {
    const intentId = `gi-${randomUUID()}`;
    this.#store.inCase(() =>
      this.#store.transaction(() =>
        this.#openIntent({ intent_id: intentId, kind: "write", slot_key: plan.slotKey, actor: by.actor, owner: OWNER, plan, entry_kind: expected.kind, summary: expected.summary }),
      ),
    );
    RUNNING.add(intentId);
    try {
      let outcome: SyncOutcome;
      try {
        outcome = await execute();
      } catch (err) {
        // A refusal is certain to have written nothing. A lost answer may
        // have written, so its intent stays open for reconcileGoogle.
        if (!(err instanceof GoogleError) || !ambiguous(err.code)) this.#store.inCase(() => this.#store.transaction(() => this.#closeIntent(intentId, "abandoned", null)));
        throw err;
      }
      let entry: ActivityEntry | null = null;
      let mine = false;
      this.#store.inCase(() =>
        this.#store.transaction(() => {
          // Review round 4, item 2: the entry is written only while the
          // intent is still open. A reconcile in another process that closed
          // it first wrote the entry already, or closed it for a disconnect
          // or another account. Either way nothing is written here.
          if (!this.#isOpen(intentId)) {
            entry = this.#entryById(intentClosure(this.#store.readStream(GOOGLE_INTENTS_STREAM), intentId)?.entry_id ?? null);
            return;
          }
          const d = entryFor(outcome);
          entry = d ? this.#googleEntry(by, { ...d, slotKey: plan.slotKey, undo: outcome.undo }) : null;
          mine = entry !== null;
          this.#closeIntent(intentId, entry ? "logged" : "abandoned", entry ? (entry as ActivityEntry).id : null);
        }),
      );
      if (entry && mine) by.onEntry?.(entry);
      return { outcome, entry };
    } finally {
      RUNNING.delete(intentId);
    }
  }

  // Finishes the intents a failed store write left open, by reading Google
  // (review round 3, findings 1 and 2). A write that reached Google gets
  // its entry and undo, one that did not is dropped, and one that changed
  // at Google since gets an entry with no undo. An undo that reached Google
  // gets its undo entry. An intent Google cannot be asked about now stays
  // open. Returns the entries written.
  async reconcileGoogle(by: By): Promise<ActivityEntry[]> {
    const google = this.#google;
    if (!google) return [];
    const written: ActivityEntry[] = [];
    const current = google.calendar.accountKey();
    for (const intent of this.#openIntents()) {
      if (RUNNING.has(intent.intent_id)) continue;
      // Review round 4, item 3: an intent of another account or calendar,
      // or one left when Google is no longer connected, is closed with no
      // entry. Its write is not this connection's to record.
      const record = intent.kind === "undo" ? projectActivity(this.#store.readStream(ACTIVITY_STREAM)).records.find((r) => r.id === intent.entry_id) : undefined;
      const account = intentAccount(intent, record?.undo?.kind === "google_calendar" ? record.undo.undo.account : null);
      if (account !== current) {
        this.#store.inCase(() =>
          this.#store.transaction(() => {
            if (this.#isOpen(intent.intent_id)) this.#closeIntent(intent.intent_id, "abandoned", null, current === null ? "disconnected" : "account_changed");
          }),
        );
        continue;
      }
      // An intent another process may still be running is left alone.
      if (!reconcilable(intent, intent.openedAt)) continue;
      const actor: By = { actor: intent.actor, onEntry: by.onEntry };
      try {
        if (intent.kind === "write") {
          const seen = await google.calendar.inspect(intent.plan);
          this.#store.inCase(() =>
            this.#store.transaction(() => {
              if (!this.#openIntents().some((i) => i.intent_id === intent.intent_id)) return;
              if (seen.state === "not_applied") return this.#closeIntent(intent.intent_id, "abandoned", null, "not_applied");
              const entry = this.#googleEntry(actor, {
                kind: intent.entry_kind,
                summary: intent.summary,
                slotKey: intent.slot_key,
                undo: seen.state === "applied" ? seen.undo : null,
                whyNot: "This Google Calendar change was changed again in Google Calendar since, so it has no undo.",
              });
              this.#closeIntent(intent.intent_id, "logged", entry.id);
              written.push(entry);
            }),
          );
        } else {
          const spec = record?.undo?.kind === "google_calendar" ? record.undo.undo : null;
          const state = spec ? await google.calendar.undoState(spec) : "diverged";
          this.#store.inCase(() =>
            this.#store.transaction(() => {
              if (!this.#openIntents().some((i) => i.intent_id === intent.intent_id)) return;
              const now = projectActivity(this.#store.readStream(ACTIVITY_STREAM)).records.find((r) => r.id === intent.entry_id);
              if (state !== "reversed" || !now || now.undoneAt !== null) return this.#closeIntent(intent.intent_id, "abandoned", null, state === "not_reversed" ? "not_applied" : "diverged");
              const entry = this.#undoneEntry(actor, now, "The Google Calendar change was reversed.");
              this.#closeIntent(intent.intent_id, "logged", entry.id);
              written.push(entry);
            }),
          );
        }
      } catch (err) {
        if (!(err instanceof GoogleError)) throw err;
      }
    }
    for (const e of written) by.onEntry?.(e);
    return written;
  }

  // Inside a transaction: the undo entry for `record` and its mark.
  #undoneEntry(by: By, record: ActivityRecord, note: string): ActivityEntry {
    const entry = this.#log(by, {
      kind: "undo",
      summary: `Undid: ${record.summary} ${note}`,
      target: record.target,
      undo: null,
      whyNot: NOT_UNDOABLE.undo,
      slotKeys: record.slot_keys,
      reverses: record.id,
    });
    this.#store.appendSystem(ACTIVITY_STREAM, [{ type: "activity_undone", data: { id: record.id, by: by.actor, undo_id: entry.id } }]);
    return entry;
  }

  extract(by: By, messageId: string, options: { effort: Effort; expectedVersion: number }): ReturnType<IntakeService["extract"]> {
    return this.#actAsync(
      by,
      () => this.#intake.extract(messageId, options),
      () => {
        const m = this.#intake.message(messageId);
        const n = m.evidenceIds.length;
        const found = m.status === "manual_entry_needed" ? "The facts need entering by hand." : n === 0 ? "No appointment facts were found." : `${n === 1 ? "1 fact was" : `${n} facts were`} found.`;
        return { kind: "message_read", summary: `Read message ${messageId}. ${found}`, target: { type: "message", id: messageId }, undo: null, whyNot: NOT_UNDOABLE.extract };
      },
    );
  }

  enterManually(by: By, messageId: string, expectedVersion: number, input: ManualClaimInput): EvidenceView {
    this.#personOnly(by, "enter a fact by hand");
    return this.#act(
      by,
      () => this.#intake.enterManually(messageId, expectedVersion, input),
      (e) => ({
        kind: "claim_entered",
        summary: `Entered ${claimWords(e.claim)} by hand for message ${messageId}.`,
        target: { type: "claim", id: e.id },
        undo: null,
        whyNot: NOT_UNDOABLE.manual,
      }),
    );
  }

  // The person's answer to "Record this as your own report?" (D1'). The
  // person only: the tap is their confirmation.
  recordOwnReport(by: By, messageId: string, answer: "yes" | "no", expectedVersion: number): MessageView {
    this.#personOnly(by, "say whether a message is your own report");
    return this.#act(by, () => this.#intake.decideOwnReport(messageId, answer, expectedVersion), (m) => ({
      kind: "own_report_recorded",
      summary: answer === "yes" ? `Recorded message ${m.id} as your own report.` : `Kept message ${m.id} as a message, not your own report.`,
      target: { type: "message", id: m.id },
      undo: { kind: "own_report", message_id: m.id },
    }));
  }

  // Review decisions. An agent accepts only a fact whose quote and values
  // pass the extraction checks again, in the same transaction (design 1).
  acceptClaim(by: By, evidenceId: string, expectedVersion: number): EvidenceView {
    return this.#decide(by, evidenceId, expectedVersion, "accept");
  }

  rejectClaim(by: By, evidenceId: string, expectedVersion: number): EvidenceView {
    return this.#decide(by, evidenceId, expectedVersion, "reject");
  }

  #decide(by: By, evidenceId: string, expectedVersion: number, decision: "accept" | "reject"): EvidenceView {
    return this.#act(
      by,
      () => {
        if (by.actor !== "you") {
          // D1': the claims of a message that may be the person's own report
          // wait until the person says whether it is.
          const from = this.#intake.evidenceItem(evidenceId).messageId;
          if (from !== null && this.#intake.message(from).ownReport === "offered") {
            throw new InvalidRequestError(`Message ${from} waits for you to say whether it is your own report. Answer that on its card first.`);
          }
        }
        if (decision === "accept" && by.actor !== "you") {
          const problem = this.#intake.verificationProblem(evidenceId);
          if (problem) throw new InvalidRequestError(problem);
        }
        return decision === "accept" ? this.#intake.accept(evidenceId, expectedVersion) : this.#intake.reject(evidenceId, expectedVersion);
      },
      (e) => ({
        kind: decision === "accept" ? "claim_accepted" : "claim_rejected",
        summary: `${decision === "accept" ? "Accepted" : "Rejected"} ${claimWords(e.claim)}${e.messageId ? ` from message ${e.messageId}` : ""}.`,
        target: { type: "claim", id: e.id },
        undo: { kind: "claim_decision", evidence_id: e.id, version: e.version },
        slotKeys: this.#slotsOf(e, this.#kase.view()),
      }),
    );
  }

  // The calendar.

  loadCalendar(by: By, name: string, text: string, expectedVersion: number): CaseView {
    return this.#act(by, () => this.#kase.loadCalendar(name, text, expectedVersion), () => ({
      kind: "calendar_loaded",
      summary: "Loaded the calendar.",
      target: null,
      undo: null,
      whyNot: NOT_UNDOABLE.calendar,
    }));
  }

  // Conflicts and questions.

  explain(by: By, conflictId: string, expectedVersion: number): Promise<ConflictView> {
    let slots: string[] = [];
    return this.#actAsync(
      by,
      async () => {
        slots = this.#kase.view().conflicts.find((c) => c.id === conflictId)?.slotKeys ?? [];
        return this.#kase.explain(conflictId, expectedVersion);
      },
      () => ({
        kind: "conflict_explained",
        summary: `Explained the disagreement about ${listLabels(slots)}.`,
        target: null,
        undo: null,
        whyNot: NOT_UNDOABLE.explain,
        slotKeys: slots,
      }),
    );
  }

  askNext(by: By, expectedVersion: number): Promise<CaseView> {
    return this.#actAsync(
      by,
      () => this.#kase.askNext(expectedVersion),
      () => {
        const q = this.#kase.questions().filter((x) => x.status === "open").at(-1);
        if (!q) return null;
        const slots = this.#kase.view().conflicts.find((c) => c.id === q.conflictId)?.slotKeys ?? [];
        return {
          kind: "question_asked",
          summary: `Asked question ${q.id} about ${listLabels(slots)}.`,
          target: { type: "question", id: q.id },
          undo: { kind: "question_ask", question_id: q.id },
          slotKeys: slots,
        };
      },
    );
  }

  // An agent's answer is added by that agent, and code refuses a choice
  // whose items would set a slot's state (CaseService.answer).
  answerQuestion(by: By, questionId: string, choiceId: string, expectedVersion: number, replyVersion?: number): CaseView {
    const before = this.#kase.view();
    const conflict = before.question?.id === questionId ? before.conflicts.find((c) => c.id === before.question!.conflictId) : undefined;
    return this.#act(
      by,
      () => this.#kase.answer(questionId, choiceId, expectedVersion, replyVersion, this.#agentName(by)),
      (view) => {
        const q = this.#kase.questions().find((x) => x.id === questionId)!;
        const choice = q.choices.find((c) => c.id === choiceId);
        const draft = choice?.draft ? (view.reply.draft?.id ?? null) : null;
        const slots = [...(conflict?.slotKeys ?? []), ...(choice?.draft ? [choice.draft.slotKey] : [])];
        return {
          kind: "question_answered",
          summary: `Answered question ${questionId} about ${listLabels(conflict?.slotKeys ?? [])}${draft ? `, which started reply draft ${draft}` : ""}.`,
          target: { type: "question", id: questionId },
          undo: {
            kind: "question_answer",
            question_id: questionId,
            evidence_ids: q.answer?.evidenceIds ?? [],
            settled_ids: choice?.settles ?? [],
            draft_id: draft,
          },
          slotKeys: slots,
        };
      },
    );
  }

  // Appointment records.

  archive(by: By, slot: string, expectedVersion: number): RecordView {
    return this.#act(by, () => this.#records.archive(slot, expectedVersion, actorFor(by.actor)), (r) => ({
      kind: "appointment_archived",
      summary: `Archived ${keyLabel(r.id)}.`,
      target: { type: "slot", id: r.id },
      undo: { kind: "record_event", slot_key: r.id, version: r.version, event: "record_archived" },
      slotKeys: [r.id],
    }));
  }

  unarchive(by: By, slot: string, expectedVersion: number): RecordView {
    return this.#act(by, () => this.#records.unarchive(slot, expectedVersion, actorFor(by.actor)), (r) => ({
      kind: "appointment_unarchived",
      summary: `Brought ${keyLabel(r.id)} back from the archive.`,
      target: { type: "slot", id: r.id },
      undo: { kind: "record_unarchive", slot_key: r.id, version: r.version },
      slotKeys: [r.id],
    }));
  }

  addNote(by: By, slot: string, text: string, expectedVersion: number): RecordView {
    return this.#act(by, () => this.#records.addNote(slot, text, expectedVersion, actorFor(by.actor)), (r) => ({
      kind: "note_added",
      summary: `Added a note to ${keyLabel(r.id)}.`,
      target: { type: "note", id: `${r.id}#${r.notes.at(-1)!.id}` },
      undo: { kind: "record_event", slot_key: r.id, version: r.version, event: "note_added" },
      slotKeys: [r.id],
    }));
  }

  setTags(by: By, slot: string, tags: string[], expectedVersion: number): RecordView {
    return this.#act(by, () => this.#records.setTags(slot, tags, expectedVersion, actorFor(by.actor)), (r) => ({
      kind: "tags_set",
      summary: r.tags.length === 0 ? `Cleared the tags on ${keyLabel(r.id)}.` : `Set ${r.tags.length === 1 ? "1 tag" : `${r.tags.length} tags`} on ${keyLabel(r.id)}.`,
      target: { type: "slot", id: r.id },
      undo: { kind: "record_event", slot_key: r.id, version: r.version, event: "tags_set" },
      slotKeys: [r.id],
    }));
  }

  // The record undo route the app had before the activity log.
  undoRecordEvent(by: By, slot: string, version: number, expectedVersion: number): RecordView {
    return this.#act(by, () => this.#records.undo(slot, version, expectedVersion, actorFor(by.actor)), (r) => ({
      kind: "record_change_undone",
      summary: `Undid a change to ${keyLabel(r.id)}.`,
      target: { type: "slot", id: r.id },
      undo: null,
      whyNot: NOT_UNDOABLE.recordUndo,
      slotKeys: [r.id],
    }));
  }

  // Replies. An agent may start and discard drafts. Only the person edits
  // the text or approves it, because approval is the (simulated) send.

  startReply(by: By, template: string, slot: string, expectedVersion: number): CaseView {
    return this.#act(by, () => this.#reply.start(template, slot, expectedVersion), (view) => {
      const d = view.reply.draft!;
      return {
        kind: "draft_started",
        summary: `Started reply draft ${d.id} (${TEMPLATES[d.template as TemplateId].title}) for ${d.slotLabel}. Nothing is sent until you approve it.`,
        target: { type: "draft", id: d.id },
        undo: { kind: "draft_start", draft_id: d.id },
        slotKeys: [d.slotKey],
      };
    });
  }

  suggestReply(by: By, intent: string | null, expectedVersion: number): Promise<CaseView> {
    this.#personOnly(by, "ask the model to pick a template");
    return this.#actAsync(
      by,
      () => this.#reply.suggest(intent, expectedVersion),
      () => {
        const d = this.#kase.view().reply.draft;
        return d && d.origin === "model"
          ? {
              kind: "draft_started",
              summary: `Started reply draft ${d.id} (${TEMPLATES[d.template as TemplateId].title}) for ${d.slotLabel} from the model's pick. Nothing is sent until you approve it.`,
              target: { type: "draft", id: d.id },
              undo: { kind: "draft_start", draft_id: d.id },
              slotKeys: [d.slotKey],
            }
          : { kind: "reply_suggested", summary: "Asked the model to pick a reply template. You pick it by hand.", target: null, undo: null, whyNot: NOT_UNDOABLE.suggest };
      },
    );
  }

  editDraft(by: By, draftId: string, text: string, expectedVersion: number): CaseView {
    this.#personOnly(by, "edit a reply's text");
    return this.#act(by, () => this.#reply.edit(draftId, text, expectedVersion), () => ({
      kind: "draft_edited",
      summary: `Edited the text of reply draft ${draftId}.`,
      target: { type: "draft", id: draftId },
      undo: null,
      whyNot: NOT_UNDOABLE.edit,
    }));
  }

  discardDraft(by: By, draftId: string, expectedVersion: number): CaseView {
    const slot = this.#kase.view().reply.draft?.slotKey;
    return this.#act(by, () => this.#reply.discard(draftId, expectedVersion), () => ({
      kind: "draft_discarded",
      summary: `Discarded reply draft ${draftId}${slot ? ` for ${keyLabel(slot)}` : ""}.`,
      target: { type: "draft", id: draftId },
      undo: { kind: "draft_discard", draft_id: draftId },
      slotKeys: slot ? [slot] : [],
    }));
  }

  // The simulated send. The person only.
  approveDraft(by: By, draftId: string, confirmedFields: string[], expectedVersion: number, options: { confirmClaim?: boolean } = {}): CaseView {
    this.#personOnly(by, "approve a reply");
    const slot = this.#kase.view().reply.draft?.slotKey;
    return this.#act(by, () => this.#reply.approve(draftId, confirmedFields, expectedVersion, options), () => ({
      kind: "reply_approved",
      summary: `Approved reply draft ${draftId}${slot ? ` for ${keyLabel(slot)}` : ""}. The send was simulated. Nothing left the app.`,
      target: { type: "draft", id: draftId },
      undo: null,
      whyNot: NOT_UNDOABLE.approve,
      slotKeys: slot ? [slot] : [],
    }));
  }

  // The time zone (J5). The page's first-load zone is source "browser", an
  // agent's is "agent", and the person's in the app is "you".
  setTimezone(by: By, timezone: string, expectedVersion: number, options: { browser?: boolean } = {}): { previous: string | null; timezone: string } {
    const source = options.browser ? "browser" : by.actor === "you" ? "you" : "agent";
    const { previous, value } = this.#act(
      by,
      () => setTimezone(this.#store, timezone, source, expectedVersion),
      (r) => ({
        kind: "timezone_set",
        summary: `Set the time zone to ${r.value.timezone}${r.previous ? ` (it was ${r.previous.timezone})` : ""}.`,
        target: null,
        undo: { kind: "timezone", previous: r.previous },
      }),
    );
    return { previous: previous?.timezone ?? null, timezone: value.timezone };
  }

  // Undo of any entry. A Google Calendar entry is reversed at Google first,
  // outside the store transaction, and then marked undone with its own
  // entry. Every other entry goes to `undo`.
  async undoEntry(by: By, entryId: string, expectedVersion: number): Promise<ActivityEntry> {
    const record = projectActivity(this.#store.readStream(ACTIVITY_STREAM)).records.find((r) => r.id === entryId);
    if (record?.undo?.kind !== "google_calendar") return this.undo(by, entryId, expectedVersion);
    const spec = record.undo;
    const slotKey = spec.undo.slotKey;
    // A retried undo finishes its own open intent (review round 3,
    // finding 1).
    if (!this.#google) throw new UndoBlockedError("Google is not set up in this app, so the calendar change cannot be undone here.");
    // Review round 4, item 4: intents left open are finished first, so a
    // stale one does not keep the appointment busy. That may finish this
    // very undo, left open by an earlier try: its entry is then the answer.
    const reconciled = await this.reconcileGoogle(by);
    const reversal = projectActivity(this.#store.readStream(ACTIVITY_STREAM)).records.find((r) => r.reverses === entryId);
    if (reversal && reconciled.some((e) => e.id === reversal.id)) return reconciled.find((e) => e.id === reversal.id)!;
    const open = this.#openIntents().find((i) => i.kind === "undo" && i.entry_id === entryId) ?? null;
    if (open && !reconcilable(open, open.openedAt)) throw new GoogleBusyError(`A Google Calendar change for ${keyLabel(slotKey)} is still in progress. Try again in a moment.`);
    const retry = open;
    const intentId = retry?.intent_id ?? `gi-${randomUUID()}`;
    this.#store.inCase(() =>
      this.#store.transaction(() => {
        this.#store.assertVersion(ACTIVITY_STREAM, expectedVersion, describeActivity);
        const now = projectActivity(this.#store.readStream(ACTIVITY_STREAM)).records.find((r) => r.id === entryId)!;
        if (now.undoneAt !== null) throw new UndoBlockedError("This was already undone.");
        const blocker = this.#laterGoogle(now);
        if (blocker) throw new UndoBlockedError(blocker);
        if (!retry) this.#openIntent({ intent_id: intentId, kind: "undo", slot_key: slotKey, actor: by.actor, owner: OWNER, entry_id: entryId });
      }),
    );
    RUNNING.add(intentId);
    try {
      return await this.#finishUndo(by, entryId, intentId, spec.undo);
    } finally {
      RUNNING.delete(intentId);
    }
  }

  // The undo at Google, then its entry and the closed intent in one
  // transaction.
  async #finishUndo(by: By, entryId: string, intentId: string, undo: CalendarUndo): Promise<ActivityEntry> {
    const done = await undoGoogleActivity({ google: this.#google! }, undo);
    if (!done.ok) {
      // A refusal reversed nothing. A lost answer may have, so its intent
      // stays open for the retry or reconcileGoogle.
      if (!ambiguous(done.code)) this.#store.inCase(() => this.#store.transaction(() => this.#closeIntent(intentId, "abandoned", null)));
      throw new UndoBlockedError(done.message);
    }
    let undone: ActivityEntry | null = null;
    let mine = false;
    this.#store.inCase(() =>
      this.#store.transaction(() => {
        // Review round 4, items 2 and 5: the entry is written only while the
        // intent is still open. A reconcile that finished this undo first
        // wrote its entry, which is the answer, with no error. An intent
        // closed for a disconnect or another account writes nothing.
        if (!this.#isOpen(intentId)) {
          const closure = intentClosure(this.#store.readStream(GOOGLE_INTENTS_STREAM), intentId);
          undone = closure?.outcome === "logged" ? this.#entryById(closure.entry_id) : null;
          if (!undone) throw new UndoBlockedError("The Google connection changed while the undo ran, so the app did not record it. Check the event in Google Calendar.");
          return;
        }
        const now = projectActivity(this.#store.readStream(ACTIVITY_STREAM)).records.find((r) => r.id === entryId)!;
        // Review round 3, finding 3: the checks again, inside the commit.
        // Already undone, or a later Google entry for the appointment, aborts.
        // The open intent kept every other Google write and undo for this
        // appointment out while the call ran, so neither can happen. A moved
        // activity version alone does not abort: Google has already reversed
        // the change, the entries that moved it are about other things, and
        // the undo is recorded as what happened.
        const blocker = this.#laterGoogle(now);
        if (now.undoneAt !== null || blocker) {
          this.#closeIntent(intentId, "abandoned", null);
          throw new UndoBlockedError(now.undoneAt !== null ? "This was already undone." : blocker!);
        }
        undone = this.#undoneEntry(by, now, done.message);
        mine = true;
        this.#closeIntent(intentId, "logged", (undone as ActivityEntry).id);
      }),
    );
    if (mine) by.onEntry?.(undone!);
    return undone!;
  }

  // A later Google entry for the same appointment still in effect, as a
  // sentence, or null.
  #laterGoogle(record: ActivityRecord): string | null {
    const later = projectActivity(this.#store.readStream(ACTIVITY_STREAM)).records.filter(
      (r) => r.seq > record.seq && r.undoneAt === null && r.reverses === undefined && r.undo?.kind === "google_calendar" && r.slot_keys.some((k) => record.slot_keys.includes(k)),
    );
    return later.length > 0 ? `A later Google Calendar change for ${listLabels(record.slot_keys)} (${later.at(-1)!.id}) depends on this. Undo that first.` : null;
  }

  // Undo (design 3). `expectedVersion` is the activity version the caller
  // saw. Refused with UndoBlockedError and a plain sentence when the entry
  // cannot be undone, was undone already, or a later action depends on it.
  undo(by: By, entryId: string, expectedVersion: number): ActivityEntry {
    let undone: ActivityEntry | null = null;
    this.#store.inCase(() =>
      this.#store.transaction(() => {
        this.#store.assertVersion(ACTIVITY_STREAM, expectedVersion, describeActivity);
        const log = projectActivity(this.#store.readStream(ACTIVITY_STREAM));
        const record = log.records.find((r) => r.id === entryId);
        if (!record) throw new NotFoundError(`No activity entry ${entryId}.`);
        if (record.reverses !== undefined) throw new UndoBlockedError(NOT_UNDOABLE.undo);
        if (record.undoneAt !== null) throw new UndoBlockedError("This was already undone.");
        if (record.undo === null) throw new UndoBlockedError(record.why_not ?? "This cannot be undone.");
        const later = log.records.filter((r) => r.seq > record.seq && r.undoneAt === null && r.reverses === undefined);
        const blocker = this.#blocker(record, record.undo, later);
        if (blocker) throw new UndoBlockedError(blocker);
        try {
          this.#reverse(by, record.undo);
        } catch (err) {
          if (err instanceof InvalidRequestError || err instanceof NotFoundError || err instanceof StaleEditError) {
            throw new UndoBlockedError(err instanceof StaleEditError ? "This changed since. Read the case again." : err.message);
          }
          throw err;
        }
        const entry = this.#log(by, {
          kind: "undo",
          summary: `Undid: ${record.summary}`,
          target: record.target,
          undo: null,
          whyNot: NOT_UNDOABLE.undo,
          slotKeys: record.slot_keys,
          reverses: record.id,
        });
        this.#store.appendSystem(ACTIVITY_STREAM, [{ type: "activity_undone", data: { id: record.id, by: by.actor, undo_id: entry.id } }]);
        undone = entry;
      }),
    );
    by.onEntry?.(undone!);
    return undone!;
  }

  // Why a later action stops the undo, or null.
  #blocker(record: ActivityRecord, spec: UndoSpec, later: ActivityRecord[]): string | null {
    const shared = (r: ActivityRecord) => r.slot_keys.some((k) => record.slot_keys.includes(k));
    const approved = later.find((r) => r.kind === "reply_approved" && shared(r));
    if (approved && (spec.kind === "claim_decision" || spec.kind === "question_answer" || spec.kind === "draft_start")) {
      return `A reply for ${listLabels(approved.slot_keys)} was approved after this and depends on it. A sent reply cannot be unsent, so this cannot be undone.`;
    }
    switch (spec.kind) {
      case "own_report": {
        const m = this.#intake.messages().find((x) => x.id === spec.message_id);
        if (!m) return `Message ${spec.message_id} is no longer in the case.`;
        if (m.evidenceIds.some((id) => this.#intake.evidenceItem(id).status !== "pending")) return `A fact from message ${m.id} was reviewed after this. Undo that review first.`;
        return null;
      }
      case "message_import": {
        const m = this.#intake.messages().find((x) => x.id === spec.message_id);
        if (!m) return `Message ${spec.message_id} is no longer in the case.`;
        const standing = m.manualEvidenceIds.filter((id) => this.#intake.evidenceItem(id).status !== "rejected");
        if (standing.length > 0) {
          const typed = later.find((r) => r.kind === "claim_entered" && standing.includes(r.target?.id ?? ""));
          return `A fact was entered by hand for message ${m.id}${typed ? ` (${typed.id})` : ""} after this, and depends on it. Reject that fact instead.`;
        }
        const ids = new Set([...m.evidenceIds, ...m.manualEvidenceIds]);
        const settledBy = this.#kase
          .questions()
          .find((q) => q.status === "answered" && q.choices.find((c) => c.id === q.answer!.choiceId)?.settles.some((id) => ids.has(id)));
        if (settledBy) return `The answer to question ${settledBy.id} settled a fact from message ${m.id} after this. Undo that answer first.`;
        return null;
      }
      case "claim_decision": {
        const current = this.#intake.evidence().find((e) => e.id === spec.evidence_id);
        if (!current || current.version !== spec.version) return "This fact was reviewed again since. Undo the later review instead.";
        const answered = later.find((r) => r.kind === "question_answered" && shared(r));
        if (answered) return `Question ${answered.target?.id} was answered after this, about the same appointments. Undo that answer first.`;
        return null;
      }
      case "question_answer": {
        const asked = later.find((r) => r.kind === "question_asked");
        if (asked) return `Question ${asked.target?.id} was asked after this answer. Undo that first.`;
        const q = this.#kase.questions().find((x) => x.id === spec.question_id);
        if (!q || q.status !== "answered") return "This question is no longer answered.";
        const open = this.#kase.questions().find((x) => x.status === "open");
        if (open) return `Question ${open.id} is open now. Answer or undo it first.`;
        if (spec.draft_id) {
          const d = this.#kase.replyState().log.drafts.find((x) => x.id === spec.draft_id);
          if (d && d.status === "open" && d.edited) return editedDraft(d.id);
        }
        return null;
      }
      case "question_ask": {
        const q = this.#kase.questions().find((x) => x.id === spec.question_id);
        if (!q) return "This question is gone.";
        if (q.status === "answered") return `Question ${q.id} was answered. Undo the answer first.`;
        if (q.status === "withdrawn") return `Question ${q.id} was already withdrawn.`;
        return null;
      }
      case "draft_start": {
        const d = this.#kase.replyState().log.drafts.find((x) => x.id === spec.draft_id);
        if (!d) return "This draft is gone.";
        if (d.status === "approved") return NOT_UNDOABLE.approve;
        if (d.status === "discarded") return `Draft ${d.id} was already discarded.`;
        if (d.edited) return editedDraft(d.id);
        return null;
      }
      case "draft_discard": {
        const open = this.#kase.view().reply.draft;
        if (open) return `Draft ${open.id} is open now. Finish or discard it first.`;
        return null;
      }
      case "timezone": {
        const changed = later.find((r) => r.kind === "timezone_set");
        if (changed) return "The time zone was changed again after this. Undo that change first.";
        return null;
      }
      case "record_event":
      case "record_unarchive":
        return null;
      case "google_calendar":
        return "A Google Calendar change is undone through undoEntry.";
    }
  }

  // Writes the reversing event. Inside the undo's transaction.
  #reverse(by: By, spec: UndoSpec): void {
    switch (spec.kind) {
      case "own_report":
        this.#intake.undoOwnReport(spec.message_id);
        return;
      case "message_import":
        this.#intake.withdrawMessage(spec.message_id);
        return;
      case "claim_decision":
        this.#intake.undoDecision(spec.evidence_id);
        return;
      case "question_answer": {
        this.#kase.undoAnswer(spec.question_id, spec.evidence_ids, spec.settled_ids);
        const open = this.#kase.view().reply.draft;
        if (spec.draft_id && open?.id === spec.draft_id) this.#reply.undoStart(spec.draft_id);
        return;
      }
      case "question_ask":
        this.#kase.withdrawQuestion(spec.question_id);
        return;
      case "record_event":
        this.#records.undo(spec.slot_key, spec.version, this.#records.record(spec.slot_key).version, actorFor(by.actor));
        return;
      case "record_unarchive":
        this.#records.archive(spec.slot_key, this.#records.record(spec.slot_key).version, actorFor(by.actor));
        return;
      case "draft_start":
        this.#reply.undoStart(spec.draft_id);
        return;
      case "draft_discard":
        this.#reply.undoDiscard(spec.draft_id);
        return;
      case "timezone":
        restoreTimezone(this.#store, spec.previous);
        return;
      case "google_calendar":
        throw new UndoBlockedError("A Google Calendar change is undone through undoEntry.");
    }
  }
}
