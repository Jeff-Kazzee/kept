// Case commands for slot states: load a calendar, explain a conflict, ask
// the next question and record an answer. Model output never changes a
// slot: an explanation and a proposed question are stored for display only,
// and the choices the user taps are built by code. An answer is recorded as
// user-reported evidence. A choice that starts a reply opens a draft in the
// same write and records no claim (W30). Every write states an expected
// version.
import type { EvidenceClaim, Effort } from "../domain/claim.ts";
import { IcsParseError, parseIcs, type IcsEvent } from "../domain/ics.ts";
import { explainConflict } from "../conflicts/explain.ts";
import { proposeQuestion } from "../conflicts/question.ts";
import type { CallAttempt } from "../conflicts/call.ts";
import { evidenceStream, type AnswerMeta, type EvidenceEvent, type EvidenceView } from "../intake/events.ts";
import { InvalidRequestError, NotFoundError, type IntakeService } from "../intake/service.ts";
import type { ModelClient } from "../model/client.ts";
import { MODEL } from "../model/request.ts";
import { ASSUMED_SLOT_MINUTES } from "../slots/clash.ts";
import { projectSlots, unconfirmedAgentReport } from "../slots/project.ts";
import { arrivalTime } from "../slots/time.ts";
import type { Conflict } from "../slots/types.ts";
import { StaleEditError, type EventStore, type StoredEvent, type StreamWrite } from "../store/event-log.ts";
import { ACCESS_LOG_STREAM, RECORD_PREFIX, projectRecords } from "../records/events.ts";
import { SETTINGS_STREAM, caseTimeZone } from "../settings/events.ts";
import { zonedIso } from "../domain/zone.ts";
import { ASSISTANT_NAME, slotLabel } from "../slots/labels.ts";
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

// Delete case keeps the settings stream, such as the time zone. Every other
// event in the file is case data and is erased, the activity log included.
// Streams from before sprint 8 (grants, proposals) are erased too.
export const KEPT_ON_DELETE = [SETTINGS_STREAM] as const;

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
// `externalCalendar` gives calendar events from outside the case, such as
// the person's Google Calendar (0012). They join the loaded .ics events for
// the clash checks.
export type CaseOptions = {
  now?: () => string;
  effort?: Effort;
  model?: string;
  userName?: string | null;
  externalCalendar?: () => { name: string; events: IcsEvent[] } | null;
  // Moves when the outside calendar's events change, so the page's poll
  // reloads the case (0016, H1).
  externalVersion?: () => number;
};

export class CaseService {
  readonly #store: EventStore;
  readonly #intake: IntakeService;
  readonly #client: ModelClient;
  readonly #now: () => string;
  readonly #effort: Effort | undefined;
  readonly #model: string;
  readonly #userName: string | null;
  readonly #externalCalendar: () => { name: string; events: IcsEvent[] } | null;
  readonly #externalVersion: (() => number) | null;

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
    this.#externalCalendar = options.externalCalendar ?? (() => null);
    this.#externalVersion = options.externalVersion ?? null;
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
  // entries and settings do not move it, so an agent reading the case does
  // not make the user's confirmation stale.
  caseVersion(): number {
    return this.#store.latestSeqExcept([SETTINGS_STREAM, ACCESS_LOG_STREAM]);
  }

  // The case's time zone (0009, J5), read from the settings each time.
  timeZone(): string {
    return caseTimeZone(this.#store);
  }

  // An instant written with the case zone's offset.
  zoned(iso: string): string {
    return zonedIso(iso, this.timeZone());
  }

  // What the page polls to learn that anything changed: the case generation
  // and the highest event number in the file. Every write by the app, the
  // MCP server or another tab moves one of them, settings and agent calls
  // included.
  liveVersion(): { generation: number; seq: number; calendar?: number } {
    const live = { generation: this.#store.caseGeneration(), seq: this.#store.latestSeqExcept([]) };
    return this.#externalVersion ? { ...live, calendar: this.#externalVersion() } : live;
  }

  // Delete case: erases every event of the case, its activity and access
  // logs, and clears them from the file on disk. Settings stay.
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

  // The appointments the user archived. Archive hides a slot from the
  // default list, the question queue and the reply panel. Its state and its
  // conflicts stay.
  archivedKeys(): Set<string> {
    const records = projectRecords(this.#store.readPrefix(RECORD_PREFIX));
    return new Set([...records.values()].filter((r) => r.archived).map((r) => r.id));
  }

  // For use inside a write's transaction, so an archive that commits after
  // the command read the case still stops the write.
  #assertNotArchived(keys: string[]): void {
    const archived = this.archivedKeys();
    const hit = keys.find((k) => archived.has(k));
    if (hit) throw new InvalidRequestError(`Appointment ${hit} is archived. Undo the archive first.`);
  }

  #build() {
    const evidence = this.#intake.evidence();
    const queue = projectQuestions(this.#store.readStream(QUESTIONS_STREAM));
    const calendar = latestCalendar(this.#store.readStream(CALENDAR_STREAM));
    const external = this.#externalCalendar();
    const loaded = calendar ? parseIcs(calendar.text) : null;
    // The loaded file's events and the outside calendar's, for the clash
    // checks. Null when there are neither.
    const events = loaded || external ? [...(loaded ?? []), ...(external?.events ?? [])] : null;
    const name = [calendar?.name, external?.name].filter(Boolean).join(" and ");
    const timeZone = this.timeZone();
    const projection = projectSlots({ evidence, settled: queue.settled, calendar: events, timeZone });
    const archived = this.archivedKeys();
    const archivedIn = (c: Conflict) => c.slotKeys.filter((k) => archived.has(k));

    // The open question stays current only while its conflict exists with
    // the same evidence and names no archived appointment.
    const open = queue.questions.find((q) => q.status === "open") ?? null;
    const current =
      open &&
      projection.conflicts.some(
        (c) => c.id === open.conflictId && signature(c.evidenceIds) === signature(open.conflictEvidenceIds) && archivedIn(c).length === 0,
      )
        ? open
        : null;

    const conflicts: ConflictView[] = projection.conflicts.map((c) => ({
      ...this.#conflictView(c, queue.questions, current),
      archivedSlotKeys: archivedIn(c),
    }));
    const replyContext: ReplyContext = {
      slots: projection.slots,
      evidence,
      messages: this.#intake.messages(),
      userName: this.#userName,
      officeAcceptedSeqs: this.#officeAcceptedSeqs(evidence),
      archived: [...archived].sort(),
    };
    const replies = projectReplies(this.#store.readStream(REPLY_STREAM));
    const view: CaseView = {
      slots: projection.slots,
      conflicts,
      staleEvidenceIds: projection.staleEvidenceIds,
      unconfirmedEvidenceIds: projection.unconfirmedEvidenceIds,
      question: current ? questionView(current) : null,
      waiting: conflicts.filter(isWaiting).length,
      questionsVersion: queue.version,
      calendar: events ? { name, events, timeZone, assumedSlotMinutes: ASSUMED_SLOT_MINUTES } : null,
      calendarVersion: calendar?.version ?? 0,
      reply: replyView(replies, replyContext),
      // An agent's report of an office request waits like its other reports.
      checklist: buildChecklist(evidence.filter((e) => !unconfirmedAgentReport(e))),
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

  #conflictView(c: Conflict, questions: QuestionRecord[], current: QuestionRecord | null): Omit<ConflictView, "archivedSlotKeys"> {
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
    const waiting = new Set(view.conflicts.filter(isWaiting).map((c) => c.id));
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
    this.#store.transaction(() => {
      this.#assertNotArchived(conflict.slotKeys);
      this.#store.append(QUESTIONS_STREAM, expectedVersion, events.map(asEvent), this.#describeQueue);
    });
    return this.view();
  }

  // Records the user's tap on a choice. The tap is the review: each effect
  // of the choice becomes an accepted, user-reported evidence item, written
  // in one transaction with the answer. A choice that starts a reply opens
  // its draft in the same transaction, so it also states the expected
  // version of the reply stream.
  // `agent` names the agent that answered, when one did: "the assistant" or
  // "an external agent". Its items are then added by that agent, not
  // reported by the person, and code refuses an answer whose items would
  // set a slot to confirmed or canceled (0009, design 1).
  answer(questionId: string, choiceId: string, expectedVersion: number, replyVersion?: number, agent: string | null = null): CaseView {
    return this.#store.inCase(() => this.#answer(questionId, choiceId, expectedVersion, replyVersion, agent));
  }

  #answer(questionId: string, choiceId: string, expectedVersion: number, replyVersion: number | undefined, agent: string | null): CaseView {
    this.#store.assertVersion(QUESTIONS_STREAM, expectedVersion, this.#describeQueue);
    const { evidence, current, replyContext, replies, conflicts } = this.#build();
    if (!current || current.id !== questionId) throw new InvalidRequestError(`Question ${questionId} is not open.`);
    const asked = conflicts.find((c) => c.id === current.conflictId)!;
    const choice = current.choices.find((c) => c.id === choiceId);
    if (!choice) throw new InvalidRequestError(`Question ${questionId} has no choice ${choiceId}.`);

    const now = this.zoned(this.#now());
    const latest = evidence.filter((e) => e.status === "accepted").reduce((max, e) => Math.max(max, arrivalTime(e)), Number.NEGATIVE_INFINITY);
    const after = Number.isFinite(latest) ? new Date(latest).toISOString() : now;
    // An answer that was undone keeps its ids, so a new answer to the same
    // question takes the next free ones.
    let answerBase = `answer-${questionId}`;
    for (let k = 2; this.#store.streamVersion(evidenceStream(`${answerBase}-1`)) > 0; k++) answerBase = `answer-${questionId}-r${k}`;
    const writes: StreamWrite[] = choice.effects.map((effect, i) => {
      const claim: EvidenceClaim = {
        claim_type: effect.claim_type,
        slot: { date: effect.date, time: effect.time, location: effect.location },
        quote: choice.label,
        source_type: agent === null ? "reported_by_user" : "reported_by_user_via_agent",
        sender_kind: "person",
        evidence_time: now,
        event_time: null,
        request_item: null,
        ...(agent === null ? {} : { agent_name: agent }),
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
      return { streamId: evidenceStream(`${answerBase}-${i + 1}`), expectedVersion: 0, events: [asEvent(event)] };
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
    this.#store.transaction(() => {
      this.#assertNotArchived(asked.slotKeys);
      this.#store.appendMany(
        [{ streamId: QUESTIONS_STREAM, expectedVersion, events: [asEvent(answered)] }, ...writes],
        (streamId, events) => (streamId === QUESTIONS_STREAM ? this.#describeQueue(streamId, events) : null),
      );
      // The slot-state rule, on the case as the answer leaves it: a slot's
      // state comes only from an office message or the person's own report.
      // An agent's answer whose items would set a state is refused, and
      // nothing is kept. Answers that say which date or place a claim
      // means, start a reply or leave things open set no state.
      if (agent !== null) {
        const made = new Set(writes.map((w) => w.streamId.slice("evidence:".length)));
        const after = this.view();
        const who = agent === ASSISTANT_NAME ? "The assistant" : "An agent";
        const refuse = (label: string, state: string) =>
          new AgentAnswerRefused(`Only an office message or your own report can set ${label} to ${state}. ${who} cannot answer with that choice. Answer it yourself in the app.`);
        const held = after.slots.find((s) => made.has(s.stateEvidenceId));
        if (held) throw refuse(held.label, STATE_WORDS[held.state]!);
        // The projection keeps an agent's items aside (review round 2,
        // finding 7), so an answer that records any claim is refused by
        // what its first item says.
        const claims = writes
          .filter((w) => w.streamId.startsWith("evidence:"))
          .flatMap((w) => w.events)
          .map((e) => (e.data as { claim: EvidenceClaim }).claim);
        const c = claims.find((x) => x.slot.date !== null);
        if (c) {
          if (c.claim_type === "clarify") {
            throw new AgentAnswerRefused(`Only you can say which date, time or place a fact means. ${who} cannot answer with that choice. Answer it yourself in the app.`);
          }
          throw refuse(slotLabel(c.slot.date!, c.slot.time), ANSWER_STATE_WORDS[c.claim_type] ?? "a new state");
        }
      }
    });
    return this.view();
  }

  // Undo of an answer (0009, design 3): the question is open again, the
  // evidence it created leaves the case and the evidence it settled counts
  // again. A draft the answer opened is discarded when still open. For the
  // activity log, inside its transaction.
  undoAnswer(questionId: string, evidenceIds: string[], settledIds: string[]): void {
    this.#store.inCase(() => this.#undoAnswer(questionId, evidenceIds, settledIds));
  }

  #undoAnswer(questionId: string, evidenceIds: string[], settledIds: string[]): void {
    const version = this.#store.streamVersion(QUESTIONS_STREAM);
    const event: CaseEvent = { type: "question_answer_undone", data: { question_id: questionId, settled_evidence_ids: settledIds } };
    this.#store.appendMany([
      { streamId: QUESTIONS_STREAM, expectedVersion: version, events: [asEvent(event)] },
      ...evidenceIds.map((id) => ({
        streamId: evidenceStream(id),
        expectedVersion: this.#store.streamVersion(evidenceStream(id)),
        events: [asEvent({ type: "evidence_withdrawn", data: {} } as EvidenceEvent)],
      })),
    ]);
  }

  // Undo of an ask: the question is withdrawn and its conflict waits again.
  withdrawQuestion(questionId: string): void {
    const event: CaseEvent = { type: "question_withdrawn", data: { question_id: questionId, reason: "undone" } };
    this.#store.inCase(() => this.#store.append(QUESTIONS_STREAM, this.#store.streamVersion(QUESTIONS_STREAM), [asEvent(event)]));
  }

  // The question queue as stored, for undo checks.
  questions(): QuestionRecord[] {
    return projectQuestions(this.#store.readStream(QUESTIONS_STREAM)).questions;
  }
}

const STATE_WORDS: Record<string, string> = {
  offered: "offered",
  requested: "requested",
  confirmed: "confirmed",
  change_proposed: "confirmed",
  canceled: "canceled",
  declined: "declined",
};

const ANSWER_STATE_WORDS: Record<string, string> = {
  offer: "offered",
  request: "requested",
  confirm: "confirmed",
  reminder: "confirmed",
  cancel: "canceled",
  decline: "declined",
  move: "moved",
};

// An agent's answer would set a slot state that only an office message or
// the person's own report may set.
export class AgentAnswerRefused extends InvalidRequestError {
  override name = "AgentAnswerRefused";
}

// A conflict the app may ask about now. One that names an archived
// appointment waits until the archive is undone.
const isWaiting = (c: ConflictView) => c.askable && c.status === "open" && c.archivedSlotKeys.length === 0;

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
