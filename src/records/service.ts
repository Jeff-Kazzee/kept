// Appointment records: one domain service for the app, the in-app agent
// and the MCP server, so all of them use one store and one set of rules.
//
// - Every write states the record's expected version. A mismatch throws
//   StaleEditError with the current record, and nothing is written.
// - Removal is archive. Undo appends an event_undone event that reverses
//   one earlier event, so history keeps both. Unarchive is the undo of the
//   archive event.
// - The slot's state still comes only from accepted evidence.
import type { z } from "zod";
import { OutOfScopeError, RECORD_SCOPE_DECLINE, hasClinicalContent } from "../domain/scope.ts";
import type { CaseService } from "../case/service.ts";
import type { ConflictView, QuestionView } from "../case/types.ts";
import type { EvidenceView } from "../intake/events.ts";
import { InvalidRequestError, NotFoundError, type IntakeService } from "../intake/service.ts";
import type { SlotView } from "../slots/types.ts";
import type { EventStore, StoredEvent } from "../store/event-log.ts";
import {
  ACCESS_LOG_STREAM,
  RECORD_PREFIX,
  USER,
  emptyRecord,
  projectAccessLog,
  projectRecord,
  projectRecords,
  recordStream,
  type AccessEvent,
  type AccessEntry,
  type Actor,
  type RecordEvent,
  type RecordView,
} from "./events.ts";
import { AppointmentId, ExpectedVersion, NoteText, Tags } from "./inputs.ts";

export type Appointment = { id: string; slot: SlotView; record: RecordView };

export type AppointmentDetail = Appointment & {
  // Accepted evidence placed on the slot, in the order the slot lists it.
  evidence: EvidenceView[];
  // Conflicts that involve this appointment.
  conflicts: ConflictView[];
};

export type OpenQuestions = {
  // Conflicts not answered yet.
  conflicts: ConflictView[];
  // The one question the app is asking now, or null.
  question: QuestionView | null;
};

const asEvent = (e: RecordEvent | AccessEvent) => ({ type: e.type, data: e.data });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  const where = issue.path.length > 0 ? ` (${issue.path.map(String).join(".")})` : "";
  throw new InvalidRequestError(`Invalid ${what}${where}: ${issue.message}`);
}

// O-e: every free-text value a user or an agent writes into a record goes
// through the clinical-content check, on normalized text.
function assertAdministrative(texts: Array<string | null | undefined>): void {
  if (texts.some((t) => typeof t === "string" && hasClinicalContent(t))) throw new OutOfScopeError(RECORD_SCOPE_DECLINE);
}

export class RecordsService {
  readonly #store: EventStore;
  readonly #intake: IntakeService;
  readonly #kase: CaseService;

  constructor(store: EventStore, intake: IntakeService, kase: CaseService) {
    this.#store = store;
    this.#intake = intake;
    this.#kase = kase;
  }

  // Runs `fn` as one short unit of work on the store. The MCP server uses
  // it for the access log.
  transaction<T>(fn: () => T): T {
    return this.#store.transaction(fn);
  }

  // The case generation, and a command scope on it. See EventStore.inCase.
  // The MCP server runs every tool call this way.
  caseGeneration(): number {
    return this.#store.caseGeneration();
  }

  inCase<T>(fn: () => T, generation?: number): T {
    return this.#store.inCase(fn, generation);
  }

  #describeRecord = (streamId: string, events: StoredEvent[]) => projectRecord(streamId.slice(RECORD_PREFIX.length), events);

  // Every read builds the view from the store. Nothing is cached, so a
  // write by the app shows in the MCP server's next call and the reverse.
  record(id: string): RecordView {
    return projectRecord(id, this.#store.readStream(recordStream(id)));
  }

  #slots(): SlotView[] {
    return this.#kase.view().slots;
  }

  #slot(id: string): SlotView {
    const key = parse(AppointmentId, id, "appointment id");
    const slot = this.#slots().find((s) => s.key === key);
    if (!slot) throw new NotFoundError(`No appointment ${key}.`);
    return slot;
  }

  // Archived records leave the default list. They stay in history and come
  // back with undo.
  appointments(options: { includeArchived?: boolean } = {}): Appointment[] {
    const records = projectRecords(this.#store.readPrefix(RECORD_PREFIX));
    return this.#slots()
      .map((slot) => ({ id: slot.key, slot, record: records.get(slot.key) ?? emptyRecord(slot.key) }))
      .filter((a) => options.includeArchived || !a.record.archived);
  }

  appointment(id: string): AppointmentDetail {
    const slot = this.#slot(id);
    const view = this.#kase.view();
    const evidence = slot.evidenceIds.map((e) => this.#intake.evidenceItem(e));
    const conflicts = view.conflicts.filter((c) => c.slotKeys.includes(slot.key));
    return { id: slot.key, slot, record: this.record(slot.key), evidence, conflicts };
  }

  // A conflict that names an archived appointment is not asked in the app,
  // so it is not an open question here either. The question is already
  // null while its conflict names one.
  openQuestions(): OpenQuestions {
    const view = this.#kase.view();
    return { conflicts: view.conflicts.filter((c) => c.status !== "answered" && c.archivedSlotKeys.length === 0), question: view.question };
  }

  accessLog(): AccessEntry[] {
    return projectAccessLog(this.#store.readStream(ACCESS_LOG_STREAM));
  }

  // The slot check reads the case before the write. inCase makes the write
  // fail if a Delete case committed in between.
  addNote(id: string, text: string, expectedVersion: number, by: Actor): RecordView {
    return this.#store.inCase(() => this.#addNote(id, text, expectedVersion, by));
  }

  #addNote(id: string, text: string, expectedVersion: number, by: Actor): RecordView {
    const slot = this.#slot(id);
    const note = parse(NoteText, text, "note");
    assertAdministrative([note]);
    const version = parse(ExpectedVersion, expectedVersion, "expected version");
    const event: RecordEvent = { type: "note_added", data: { note_id: `n${version + 1}`, text: note, by } };
    this.#store.append(recordStream(slot.key), version, [asEvent(event)], this.#describeRecord);
    return this.record(slot.key);
  }

  setTags(id: string, tags: string[], expectedVersion: number, by: Actor): RecordView {
    return this.#store.inCase(() => this.#setTags(id, tags, expectedVersion, by));
  }

  #setTags(id: string, tags: string[], expectedVersion: number, by: Actor): RecordView {
    const slot = this.#slot(id);
    const parsed = parse(Tags, tags, "tags");
    assertAdministrative(parsed);
    const version = parse(ExpectedVersion, expectedVersion, "expected version");
    const event: RecordEvent = { type: "tags_set", data: { tags: parsed, by } };
    this.#store.append(recordStream(slot.key), version, [asEvent(event)], this.#describeRecord);
    return this.record(slot.key);
  }

  // Archives a record. The person, the in-app agent and an external agent
  // all may. Undo or unarchive brings it back.
  archive(id: string, expectedVersion: number, by: Actor = USER): RecordView {
    return this.#store.inCase(() => this.#archive(id, expectedVersion, by));
  }

  #archive(id: string, expectedVersion: number, by: Actor): RecordView {
    const slot = this.#slot(id);
    const version = parse(ExpectedVersion, expectedVersion, "expected version");
    return this.#store.transaction(() => {
      this.#store.assertVersion(recordStream(slot.key), version, this.#describeRecord);
      if (this.record(slot.key).archived) throw new InvalidRequestError(`Appointment ${slot.key} is already archived.`);
      const event: RecordEvent = { type: "record_archived", data: { by, proposal_id: null } };
      this.#store.append(recordStream(slot.key), version, [asEvent(event)], this.#describeRecord);
      return this.record(slot.key);
    });
  }

  // Brings an archived record back: the undo of its archive event that is
  // still in effect.
  unarchive(id: string, expectedVersion: number, by: Actor = USER): RecordView {
    return this.#store.inCase(() =>
      this.#store.transaction(() => {
        const key = parse(AppointmentId, id, "appointment id");
        this.#store.assertVersion(recordStream(key), parse(ExpectedVersion, expectedVersion, "expected version"), this.#describeRecord);
        const archive = this.record(key).history.filter((h) => h.type === "record_archived" && !h.undone).at(-1);
        if (!this.record(key).archived || !archive) throw new InvalidRequestError(`Appointment ${key} is not archived.`);
        return this.#undo(key, archive.version, expectedVersion, by);
      }),
    );
  }

  // Undoes one event: a note, a tag change or an archive. Undo appends a
  // reversing event. The reversed event stays in history.
  undo(id: string, version: number, expectedVersion: number, by: Actor = USER): RecordView {
    return this.#store.inCase(() => this.#store.transaction(() => this.#undo(id, version, expectedVersion, by)));
  }

  #undo(id: string, version: number, expectedVersion: number, by: Actor): RecordView {
    const key = parse(AppointmentId, id, "appointment id");
    this.#store.assertVersion(recordStream(key), expectedVersion, this.#describeRecord);
    const target = this.record(key).history.find((h) => h.version === version);
    if (!target) throw new NotFoundError(`Appointment ${key} has no event at version ${version}.`);
    if (target.type === "event_undone") throw new InvalidRequestError("An undo cannot be undone. Make the change again instead.");
    if (target.undone) throw new InvalidRequestError(`The event at version ${version} was already undone.`);
    // Tags are one value. Undoing a tag change brings back the tags before
    // it, which is only true for the latest tag change still in effect.
    if (target.type === "tags_set") {
      const latest = this.record(key).history.filter((h) => h.type === "tags_set" && !h.undone).at(-1);
      if (latest?.version !== version) {
        throw new InvalidRequestError(`Only the latest tag change can be undone. That is the one at version ${latest?.version}.`);
      }
    }
    const event: RecordEvent = { type: "event_undone", data: { version, by } };
    this.#store.append(recordStream(key), expectedVersion, [asEvent(event)], this.#describeRecord);
    return this.record(key);
  }

  // A system event with no expected version. See docs/decisions/0004-mcp-core.md (M-f).
  logAccess(entry: AccessEvent["data"]): void {
    return this.#store.inCase(() => this.#logAccess(entry));
  }

  #logAccess(entry: AccessEvent["data"]): void {
    this.#store.appendSystem(ACCESS_LOG_STREAM, [asEvent({ type: "tool_called", data: entry })]);
  }
}
