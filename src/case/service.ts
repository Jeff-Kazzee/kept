// Case commands for slot states: load a calendar, explain a conflict, ask
// the next question and record an answer. Model output never changes a
// slot: an explanation and a proposed question are stored for display only,
// and the choices the user taps are built by code. An answer is recorded as
// user-reported evidence. A choice that starts a reply opens a draft in the
// same write and records no claim (W30). Every write states an expected
// version.
import type { EvidenceClaim, Effort } from "../domain/claim.ts";
import { IcsParseError, parseIcs } from "../domain/ics.ts";
import { explainConflict } from "../conflicts/explain.ts";
import { proposeQuestion } from "../conflicts/question.ts";
import type { CallAttempt } from "../conflicts/call.ts";
import { evidenceStream, type AnswerMeta, type EvidenceEvent, type EvidenceView } from "../intake/events.ts";
import { InvalidRequestError, NotFoundError, type IntakeService } from "../intake/service.ts";
import type { ModelClient } from "../model/client.ts";
import { MODEL } from "../model/request.ts";
import { ASSUMED_SLOT_MINUTES, CASE_TIME_ZONE } from "../slots/clash.ts";
import { projectSlots } from "../slots/project.ts";
import { arrivalTime } from "../slots/time.ts";
import type { Conflict } from "../slots/types.ts";
import { StaleEditError, type EventStore, type StoredEvent, type StreamWrite } from "../store/event-log.ts";
import { GRANT_PREFIX } from "../grants/grants.ts";
import { ACCESS_LOG_STREAM } from "../records/events.ts";
import { buildDraft, type ReplyContext } from "../reply/draft.ts";
import { REPLY_STREAM, draftEvents, projectReplies, type ReplyLog } from "../reply/events.ts";
import { replyView } from "../reply/view.ts";
import { buildChecklist } from "./checklist.ts";
import { DELETE_CONFIRMATION } from "./constants.ts";
import { caseHistory, type HistoryEntry } from "./history.ts";
import {
  CALENDAR_STREAM,
  QUESTIONS_STREAM,
  conflictStream,
  latestCalendar,
  projectExplanations,
  projectQuestions,
  type AttemptData,
  type CaseEvent,
  type QuestionRecord,
} from "./events.ts";
import type { AttemptSummary, CaseView, ConflictView, QuestionView } from "./types.ts";

export const MAX_CALENDAR_CHARS = 60_000;

// Delete case keeps grants, which are app settings. Every other event in the
// file is case data and is erased.
export const KEPT_ON_DELETE = [GRANT_PREFIX] as const;

export { DELETE_CONFIRMATION };

const asEvent = (e: CaseEvent | EvidenceEvent) => ({ type: e.type, data: e.data });
const signature = (ids: string[]) => [...ids].sort().join(",");

export function attemptData<T>(a: CallAttempt<T>): AttemptData {
  return {
    attempt: a.attempt,
    outcome: a.outcome,
    problems: a.problems,
    detail: a.detail,
    latency_ms: a.latencyMs,
    effort: a.effort,
    model: a.model,
    usage: a.usage,
    output: a.output,
  };
}

const summary = (a: AttemptData): AttemptSummary => ({
  attempt: a.attempt,
  outcome: a.outcome,
  problems: a.problems,
  detail: a.detail,
  latency_ms: a.latency_ms,
});

// `userName` comes from the case profile and signs replies.
export type CaseOptions = { now?: () => string; effort?: Effort; model?: string; userName?: string | null };

export class CaseService {
  readonly #store: EventStore;
  readonly #intake: IntakeService;
  readonly #client: ModelClient;
  readonly #now: () => string;
  readonly #effort: Effort | undefined;
  readonly #model: string;
  readonly #userName: string | null;

  // `client` serves the explanation and question calls. Extraction keeps
  // its own client inside `intake`.
  constructor(store: EventStore, intake: IntakeService, client: ModelClient, options: CaseOptions = {}) {
    this.#store = store;
    this.#intake = intake;
    this.#client = client;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#effort = options.effort;
    this.#model = options.model ?? MODEL;
    this.#userName = options.userName ?? null;
  }

  #describeQueue = (_streamId: string, events: StoredEvent[]) => {
    const queue = projectQuestions(events);
    return { version: queue.version, open: queue.questions.filter((q) => q.status === "open").map((q) => q.id) };
  };
  #describeVersion = (_streamId: string, events: StoredEvent[]) => ({ version: events.at(-1)?.version ?? 0 });

  loadCalendar(name: string, text: string, expectedVersion: number): CaseView {
    return this.#store.inCase(() => this.#loadCalendar(name, text, expectedVersion));
  }

  #loadCalendar(name: string, text: string, expectedVersion: number): CaseView {
    if (text.length > MAX_CALENDAR_CHARS) throw new InvalidRequestError("The calendar file is too large.");
    try {
      parseIcs(text);
    } catch (err) {
      if (err instanceof IcsParseError) throw new InvalidRequestError(`The calendar file could not be read: ${err.message}`);
      throw err;
    }
    const event: CaseEvent = { type: "calendar_loaded", data: { name, text } };
    this.#store.append(CALENDAR_STREAM, expectedVersion, [asEvent(event)], this.#describeVersion);
    return this.view();
  }

  view(): CaseView {
    return this.#build().view;
  }

  // Every event of the case in order, with labels built by code.
  history(): HistoryEntry[] {
    return caseHistory(this.#store.readAll());
  }

  // The version Delete case states: the latest event of the case. Access log
  // entries do not move it, so an agent reading the case does not make the
  // user's confirmation stale.
  caseVersion(): number {
    return this.#store.latestSeqExcept([GRANT_PREFIX, ACCESS_LOG_STREAM]);
  }

  // Delete case: erases every event of the case, its access log and its
  // rate-limit counters, and clears them from the file on disk. Grants stay.
  // App only, after the user types the confirmation. No MCP tool calls it.
  // The version check runs in the same transaction as the delete.
  deleteCase(expectedVersion: number, confirmation: string): { erased: number } {
    return this.#store.inCase(() => this.#deleteCase(expectedVersion, confirmation));
  }

  #deleteCase(expectedVersion: number, confirmation: string): { erased: number } {
    if (confirmation !== DELETE_CONFIRMATION) throw new InvalidRequestError(`Type ${DELETE_CONFIRMATION} to confirm.`);
    const erased = this.#store.eraseCase(KEPT_ON_DELETE, () => {
      const current = this.caseVersion();
      if (current !== expectedVersion) throw new StaleEditError("case", expectedVersion, current, { version: current });
    });
    return { erased };
  }

  #build() {
    const evidence = this.#intake.evidence();
    const queue = projectQuestions(this.#store.readStream(QUESTIONS_STREAM));
    const calendar = latestCalendar(this.#store.readStream(CALENDAR_STREAM));
    const events = calendar ? parseIcs(calendar.text) : null;
    const projection = projectSlots({ evidence, settled: queue.settled, calendar: events });

    // The open question stays current only while its conflict exists with
    // the same evidence.
    const open = queue.questions.find((q) => q.status === "open") ?? null;
    const current =
      open &&
      projection.conflicts.some((c) => c.id === open.conflictId && signature(c.evidenceIds) === signature(open.conflictEvidenceIds))
        ? open
        : null;

    const conflicts: ConflictView[] = projection.conflicts.map((c) => this.#conflictView(c, queue.questions, current));
    const replyContext: ReplyContext = {
      slots: projection.slots,
      evidence,
      messages: this.#intake.messages(),
      userName: this.#userName,
      officeAcceptedSeqs: this.#officeAcceptedSeqs(evidence),
    };
    const replies = projectReplies(this.#store.readStream(REPLY_STREAM));
    const view: CaseView = {
      slots: projection.slots,
      conflicts,
      staleEvidenceIds: projection.staleEvidenceIds,
      question: current ? questionView(current) : null,
      waiting: conflicts.filter((c) => c.askable && c.status === "open").length,
      questionsVersion: queue.version,
      calendar: calendar && events ? { name: calendar.name, events, timeZone: CASE_TIME_ZONE, assumedSlotMinutes: ASSUMED_SLOT_MINUTES } : null,
      calendarVersion: calendar?.version ?? 0,
      reply: replyView(replies, replyContext),
      checklist: buildChecklist(evidence),
    };
    return { view, evidence, conflicts: projection.conflicts, queue, open, current, replyContext, replies };
  }

  // When the user accepted each claim from an office message, as event seq
  // numbers. A draft made before one of them is out of date because the
  // office replied.
  #officeAcceptedSeqs(evidence: EvidenceView[]): number[] {
    const office = new Set(evidence.filter((e) => e.claim.source_type === "office_message").map((e) => e.id));
    return this.#store
      .readPrefix("evidence:")
      .filter((e) => e.type === "claim_accepted" && office.has(e.streamId.slice("evidence:".length)))
      .map((e) => e.seq);
  }

  // The case as the reply commands need it.
  replyState(): { view: CaseView; context: ReplyContext; log: ReplyLog } {
    const built = this.#build();
    return { view: built.view, context: built.replyContext, log: built.replies };
  }

  #conflictView(c: Conflict, questions: QuestionRecord[], current: QuestionRecord | null): ConflictView {
    const sig = signature(c.evidenceIds);
    const answered = questions.filter((q) => q.conflictId === c.id && q.status === "answered" && signature(q.conflictEvidenceIds) === sig).at(-1);
    const stream = projectExplanations(this.#store.readStream(conflictStream(c.id)));
    const explanation = stream.explanations.filter((x) => signature(x.conflictEvidenceIds) === sig).at(-1);
    return {
      ...c,
      status: current?.conflictId === c.id ? "asked" : answered ? "answered" : "open",
      answer: answered?.answer
        ? { questionId: answered.id, choiceId: answered.answer.choiceId, label: answered.answer.label, answeredAt: answered.answer.answeredAt }
        : null,
      explanation: explanation
        ? {
            outcome: explanation.outcome,
            text: explanation.text,
            citedEvidenceIds: explanation.citedEvidenceIds,
            model: explanation.attempts[0]?.model ?? this.#model,
            effort: explanation.attempts[0]?.effort ?? "low",
            attempts: explanation.attempts.map(summary),
            recordedAt: explanation.recordedAt,
          }
        : null,
      version: stream.version,
    };
  }

  // The case generation. See EventStore.inCase.
  generation(): number {
    return this.#store.caseGeneration();
  }

  // Runs `fn` as one command on the case at `generation`, or at the current
  // generation. The API runs every request this way.
  inCase<T>(fn: () => T, generation?: number): T {
    return this.#store.inCase(fn, generation);
  }

  // True when a Delete case still has to clear the file on disk.
  erasePending(): boolean {
    return this.#store.erasePending();
  }

  // Asks the model to explain one conflict and stores the result, valid or
  // not, as events on the conflict's stream. The command keeps the case
  // generation it started from, so a Delete case during the model call makes
  // the write fail with CaseDeletedError instead of landing in the empty case.
  explain(conflictId: string, expectedVersion: number): Promise<ConflictView> {
    return this.#store.inCase(() => this.#explain(conflictId, expectedVersion));
  }

  async #explain(conflictId: string, expectedVersion: number): Promise<ConflictView> {
    const { view, evidence, conflicts } = this.#build();
    const conflict = conflicts.find((c) => c.id === conflictId);
    if (!conflict) throw new NotFoundError(`No open conflict ${conflictId}.`);
    // Check before spending a model call. The append below checks again.
    this.#store.assertVersion(conflictStream(conflictId), expectedVersion, this.#describeVersion);
    if (view.conflicts.find((c) => c.id === conflictId)!.explanation) {
      throw new InvalidRequestError(`Conflict ${conflictId} already has an explanation for its current evidence.`);
    }
    const result = await explainConflict(conflict, evidence, this.#client, { effort: this.#effort, model: this.#model });
    const events: CaseEvent[] = [
      ...result.attempts.map((a): CaseEvent => ({ type: "explanation_attempted", data: { ...attemptData(a), key: result.key } })),
      {
        type: "explanation_finished",
        data: {
          conflict_evidence_ids: conflict.evidenceIds,
          outcome: result.outcome,
          text: result.text,
          cited_evidence_ids: result.evidenceIds,
        },
      },
    ];
    this.#store.append(conflictStream(conflictId), expectedVersion, events.map(asEvent), this.#describeVersion);
    const after = this.view().conflicts.find((c) => c.id === conflictId);
    if (!after) throw new NotFoundError(`Conflict ${conflictId} is no longer open.`);
    return after;
  }

  // Opens the next question. Only one question is open at a time. A
  // question whose conflict has changed or gone is withdrawn first. Keeps
  // the case generation it started from, as explain does.
  askNext(expectedVersion: number): Promise<CaseView> {
    return this.#store.inCase(() => this.#askNext(expectedVersion));
  }

  async #askNext(expectedVersion: number): Promise<CaseView> {
    this.#store.assertVersion(QUESTIONS_STREAM, expectedVersion, this.#describeQueue);
    const { view, evidence, conflicts, queue, open, current } = this.#build();
    if (current) throw new InvalidRequestError(`Question ${current.id} is still open. Answer it first.`);
    const waiting = new Set(view.conflicts.filter((c) => c.askable && c.status === "open").map((c) => c.id));
    const candidates = conflicts.filter((c) => waiting.has(c.id));
    if (candidates.length === 0) throw new InvalidRequestError("No conflict waits for a question.");

    const result = await proposeQuestion(candidates, evidence, this.#client, { effort: this.#effort, model: this.#model });
    const conflict = candidates.find((c) => c.id === result.conflictId)!;
    const events: CaseEvent[] = [];
    if (open) events.push({ type: "question_withdrawn", data: { question_id: open.id, reason: "conflict_changed" } });
    events.push({
      type: "question_asked",
      data: {
        question_id: `q${queue.questions.length + 1}`,
        conflict_id: conflict.id,
        conflict_kind: conflict.kind,
        conflict_evidence_ids: conflict.evidenceIds,
        text: result.text,
        origin: result.origin,
        cited_evidence_ids: result.evidenceIds,
        choices: conflict.choices,
        key: result.key,
        attempts: result.attempts.map(attemptData),
      },
    });
    this.#store.append(QUESTIONS_STREAM, expectedVersion, events.map(asEvent), this.#describeQueue);
    return this.view();
  }

  // Records the user's tap on a choice. The tap is the review: each effect
  // of the choice becomes an accepted, user-reported evidence item, written
  // in one transaction with the answer. A choice that starts a reply opens
  // its draft in the same transaction, so it also states the expected
  // version of the reply stream.
  answer(questionId: string, choiceId: string, expectedVersion: number, replyVersion?: number): CaseView {
    return this.#store.inCase(() => this.#answer(questionId, choiceId, expectedVersion, replyVersion));
  }

  #answer(questionId: string, choiceId: string, expectedVersion: number, replyVersion?: number): CaseView {
    this.#store.assertVersion(QUESTIONS_STREAM, expectedVersion, this.#describeQueue);
    const { evidence, current, replyContext, replies } = this.#build();
    if (!current || current.id !== questionId) throw new InvalidRequestError(`Question ${questionId} is not open.`);
    const choice = current.choices.find((c) => c.id === choiceId);
    if (!choice) throw new InvalidRequestError(`Question ${questionId} has no choice ${choiceId}.`);

    const now = this.#now();
    const latest = evidence.filter((e) => e.status === "accepted").reduce((max, e) => Math.max(max, arrivalTime(e)), Number.NEGATIVE_INFINITY);
    const after = Number.isFinite(latest) ? new Date(latest).toISOString() : now;
    const writes: StreamWrite[] = choice.effects.map((effect, i) => {
      const claim: EvidenceClaim = {
        claim_type: effect.claim_type,
        slot: { date: effect.date, time: effect.time, location: effect.location },
        quote: choice.label,
        source_type: "reported_by_user",
        sender_kind: "person",
        evidence_time: now,
        event_time: null,
        request_item: null,
      };
      const meta: AnswerMeta = {
        question_id: questionId,
        conflict_id: current.conflictId,
        choice_id: choice.id,
        clarifies: effect.clarifies,
        after,
        index: i,
      };
      const event: EvidenceEvent = { type: "answer_recorded", data: { claim, ...meta } };
      return { streamId: evidenceStream(`answer-${questionId}-${i + 1}`), expectedVersion: 0, events: [asEvent(event)] };
    });
    const answered: CaseEvent = {
      type: "question_answered",
      data: {
        question_id: questionId,
        choice_id: choice.id,
        label: choice.label,
        evidence_ids: writes.map((w) => w.streamId.slice("evidence:".length)),
        settled_evidence_ids: choice.settles,
      },
    };
    if (choice.draft) {
      if (replyVersion === undefined) throw new InvalidRequestError("This choice starts a reply. State the expected version of the reply stream.");
      // The choice exists only for a slot the template allows, so a draft
      // that code cannot build means the case changed under the question.
      const built = buildDraft(choice.draft.template, choice.draft.slotKey, replyContext);
      if (!built.ok) throw new InvalidRequestError(`The reply for this choice cannot be built: ${built.problems.join(", ")}.`);
      const events = draftEvents(replies, {
        template: built.content.template,
        slot_key: built.content.slot.key,
        slot_label: built.content.slot.label,
        origin: "choice",
        question_id: questionId,
        suggestion_id: null,
        fields: built.content.fields,
        declines: built.content.declines,
        text: built.content.text,
      });
      writes.push({ streamId: REPLY_STREAM, expectedVersion: replyVersion, events: events.map((e) => ({ type: e.type, data: e.data })) });
    }
    this.#store.appendMany(
      [{ streamId: QUESTIONS_STREAM, expectedVersion, events: [asEvent(answered)] }, ...writes],
      (streamId, events) => (streamId === QUESTIONS_STREAM ? this.#describeQueue(streamId, events) : null),
    );
    return this.view();
  }
}

function questionView(q: QuestionRecord): QuestionView {
  return {
    id: q.id,
    conflictId: q.conflictId,
    conflictKind: q.conflictKind,
    text: q.text,
    origin: q.origin,
    citedEvidenceIds: q.citedEvidenceIds,
    choices: q.choices.map(({ id, label }) => ({ id, label })),
    askedAt: q.askedAt,
    attempts: q.attempts.map(summary),
  };
}
