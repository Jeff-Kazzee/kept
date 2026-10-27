// Appointment records: one domain service for the app and the MCP server.
// Both call these methods, so both use one store and one set of rules.
//
// - Notes and tags are the only direct agent writes. Every write states the
//   record's expected version. A mismatch throws StaleEditError with the
//   current record, and nothing is written.
// - Removal is archive. Undo appends an event_undone event that reverses
//   one earlier event, so history keeps both.
// - A change an agent proposes waits in the review queue beside extracted
//   claims. It changes no slot state, date, time, place or source until the
//   user confirms it in the app (rule 8). A confirmed report becomes accepted
//   evidence with source reported_by_user_via_agent and the grant's name.
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import type { EvidenceClaim } from "../domain/claim.ts";
import type { CaseService } from "../case/service.ts";
import type { ConflictView, QuestionView } from "../case/types.ts";
import { evidenceStream, type EvidenceEvent, type EvidenceView } from "../intake/events.ts";
import { InvalidRequestError, NotFoundError, type IntakeService } from "../intake/service.ts";
import { slotKey } from "../slots/labels.ts";
import type { SlotView } from "../slots/types.ts";
import type { EventStore, StoredEvent, StreamWrite } from "../store/event-log.ts";
import {
  ACCESS_LOG_STREAM,
  PROPOSAL_PREFIX,
  RECORD_PREFIX,
  USER,
  emptyRecord,
  projectAccessLog,
  projectProposals,
  projectRecord,
  projectRecords,
  proposalStream,
  recordStream,
  type AccessEvent,
  type AccessEntry,
  type Actor,
  type ProposalEvent,
  type ProposalView,
  type ProposedChange,
  type RecordEvent,
  type RecordView,
} from "./events.ts";
import { AppointmentId, ExpectedVersion, NoteText, ProposedChangeInput, Tags } from "./inputs.ts";

export type Appointment = { id: string; slot: SlotView; record: RecordView };

export type AppointmentDetail = Appointment & {
  // Accepted evidence placed on the slot, in the order the slot lists it.
  evidence: EvidenceView[];
  // Proposals that name this appointment or its date and time.
  proposals: ProposalView[];
  // Conflicts that involve this appointment.
  conflicts: ConflictView[];
};

export type OpenQuestions = {
  // Conflicts not answered yet.
  conflicts: ConflictView[];
  // The one question the app is asking now, or null.
  question: QuestionView | null;
};

export type ReviewQueue = { evidence: EvidenceView[]; proposals: ProposalView[] };

export type ProposingGrant = { id: string; name: string };

const asEvent = (e: RecordEvent | ProposalEvent | EvidenceEvent | AccessEvent) => ({ type: e.type, data: e.data });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  const where = issue.path.length > 0 ? ` (${issue.path.map(String).join(".")})` : "";
  throw new InvalidRequestError(`Invalid ${what}${where}: ${issue.message}`);
}

export type RecordsOptions = { newId?: () => string };

export class RecordsService {
  readonly #store: EventStore;
  readonly #intake: IntakeService;
  readonly #kase: CaseService;
  readonly #newId: () => string;

  constructor(store: EventStore, intake: IntakeService, kase: CaseService, options: RecordsOptions = {}) {
    this.#store = store;
    this.#intake = intake;
    this.#kase = kase;
    this.#newId = options.newId ?? (() => `p-${randomBytes(4).toString("hex")}`);
  }

  // Runs `fn` as one unit of work on the store. The MCP server uses it so the
  // grant check, the rate limit and the write see the same state.
  transaction<T>(fn: () => T): T {
    return this.#store.transaction(fn);
  }

  #describeRecord = (streamId: string, events: StoredEvent[]) => projectRecord(streamId.slice(RECORD_PREFIX.length), events);
  #describeProposal = (_streamId: string, events: StoredEvent[]) => [...projectProposals(events).values()][0] ?? null;

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
    const proposals = this.proposals().filter((p) => proposalTargets(p.change) === slot.key);
    const conflicts = view.conflicts.filter((c) => c.slotKeys.includes(slot.key));
    return { id: slot.key, slot, record: this.record(slot.key), evidence, proposals, conflicts };
  }

  openQuestions(): OpenQuestions {
    const view = this.#kase.view();
    return { conflicts: view.conflicts.filter((c) => c.status !== "answered"), question: view.question };
  }

  proposals(): ProposalView[] {
    return [...projectProposals(this.#store.readPrefix(PROPOSAL_PREFIX)).values()];
  }

  proposal(id: string): ProposalView {
    const view = projectProposals(this.#store.readStream(proposalStream(id))).get(id);
    if (!view) throw new NotFoundError(`No proposal ${id}.`);
    return view;
  }

  // One queue for the user: claims from messages and changes from agents.
  reviewQueue(): ReviewQueue {
    return { evidence: this.#intake.reviewQueue(), proposals: this.proposals().filter((p) => p.status === "pending") };
  }

  accessLog(): AccessEntry[] {
    return projectAccessLog(this.#store.readStream(ACCESS_LOG_STREAM));
  }

  addNote(id: string, text: string, expectedVersion: number, by: Actor): RecordView {
    const slot = this.#slot(id);
    const note = parse(NoteText, text, "note");
    const version = parse(ExpectedVersion, expectedVersion, "expected version");
    const event: RecordEvent = { type: "note_added", data: { note_id: `n${version + 1}`, text: note, by } };
    this.#store.append(recordStream(slot.key), version, [asEvent(event)], this.#describeRecord);
    return this.record(slot.key);
  }

  setTags(id: string, tags: string[], expectedVersion: number, by: Actor): RecordView {
    const slot = this.#slot(id);
    const parsed = parse(Tags, tags, "tags");
    const version = parse(ExpectedVersion, expectedVersion, "expected version");
    const event: RecordEvent = { type: "tags_set", data: { tags: parsed, by } };
    this.#store.append(recordStream(slot.key), version, [asEvent(event)], this.#describeRecord);
    return this.record(slot.key);
  }

  // The user archives a record in the app. An agent can only propose it.
  archive(id: string, expectedVersion: number): RecordView {
    const slot = this.#slot(id);
    this.#store.assertVersion(recordStream(slot.key), expectedVersion, this.#describeRecord);
    if (this.record(slot.key).archived) throw new InvalidRequestError(`Appointment ${slot.key} is already archived.`);
    const event: RecordEvent = { type: "record_archived", data: { by: USER, proposal_id: null } };
    this.#store.append(recordStream(slot.key), expectedVersion, [asEvent(event)], this.#describeRecord);
    return this.record(slot.key);
  }

  // The user undoes one event: a note, a tag change or an archive. Undo
  // appends a reversing event. The reversed event stays in history.
  undo(id: string, version: number, expectedVersion: number): RecordView {
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
    const event: RecordEvent = { type: "event_undone", data: { version, by: USER } };
    this.#store.append(recordStream(key), expectedVersion, [asEvent(event)], this.#describeRecord);
    return this.record(key);
  }

  // An agent proposes a change. It is stored as a pending proposal and
  // changes nothing else. A change to one record states the record version
  // the agent saw, and a stale version is refused.
  propose(input: unknown, grant: ProposingGrant): ProposalView {
    // One transaction, so the record cannot move on between the version
    // check and the proposal write.
    return this.#store.transaction(() => this.#propose(input, grant));
  }

  #propose(input: unknown, grant: ProposingGrant): ProposalView {
    const change = parse(ProposedChangeInput, input, "proposal");
    let stored: ProposedChange;
    let recordVersion: number | null = null;
    if (change.kind === "detail_edit" || change.kind === "archive") {
      const slot = this.#slot(change.appointment_id);
      this.#store.assertVersion(recordStream(slot.key), change.expected_version, this.#describeRecord);
      if (change.kind === "archive" && this.record(slot.key).archived) {
        throw new InvalidRequestError(`Appointment ${slot.key} is already archived.`);
      }
      recordVersion = change.expected_version;
      const { expected_version: _v, ...rest } = change;
      stored = rest;
    } else {
      if (change.kind === "new_appointment" && this.#slots().some((s) => s.key === slotKey(change.date, change.time))) {
        throw new InvalidRequestError(`An appointment ${slotKey(change.date, change.time)} already exists. Propose a user_report instead.`);
      }
      stored = change;
    }
    const id = this.#newId();
    const event: ProposalEvent = {
      type: "change_proposed",
      data: { grant_id: grant.id, grant_name: grant.name, change: stored, record_version: recordVersion },
    };
    this.#store.append(proposalStream(id), 0, [asEvent(event)], this.#describeProposal);
    return this.proposal(id);
  }

  // The user confirms a proposal in the app. A report becomes accepted
  // evidence. An archive or a place edit changes one record, so the user
  // states `recordVersion`, the record version they saw, and a record that
  // moved on since is a stale edit.
  confirmProposal(id: string, expectedVersion: number, options: { recordVersion?: number } = {}): ProposalView {
    return this.#store.transaction(() => this.#confirm(id, expectedVersion, options));
  }

  #confirm(id: string, expectedVersion: number, options: { recordVersion?: number }): ProposalView {
    this.#store.assertVersion(proposalStream(id), expectedVersion, this.#describeProposal);
    const proposal = this.proposal(id);
    if (proposal.status !== "pending") throw new InvalidRequestError(`Proposal ${id} was already ${proposal.status}.`);
    const change = proposal.change;
    const writes: StreamWrite[] = [];
    const evidenceIds: string[] = [];

    const recordVersion = options.recordVersion;
    if (change.kind === "archive" || change.kind === "detail_edit") {
      if (recordVersion === undefined) {
        throw new InvalidRequestError(`Confirming ${change.kind === "archive" ? "an archive" : "a place edit"} needs the record version.`);
      }
      this.#store.assertVersion(recordStream(this.#slot(change.appointment_id).key), recordVersion, this.#describeRecord);
    }
    if (change.kind === "archive") {
      const slot = this.#slot(change.appointment_id);
      if (this.record(slot.key).archived) throw new InvalidRequestError(`Appointment ${slot.key} is already archived.`);
      const event: RecordEvent = { type: "record_archived", data: { by: USER, proposal_id: id } };
      writes.push({ streamId: recordStream(slot.key), expectedVersion: recordVersion!, events: [asEvent(event)] });
    } else {
      const claim = claimFor(proposal, change, change.kind === "detail_edit" ? this.#slot(change.appointment_id) : null);
      const evidenceId = `${id}-1`;
      const event: EvidenceEvent = { type: "agent_report_confirmed", data: { proposal_id: id, grant_id: proposal.grantId, claim } };
      writes.push({ streamId: evidenceStream(evidenceId), expectedVersion: 0, events: [asEvent(event)] });
      evidenceIds.push(evidenceId);
    }

    const confirmed: ProposalEvent = { type: "proposal_confirmed", data: { evidence_ids: evidenceIds } };
    this.#store.appendMany([{ streamId: proposalStream(id), expectedVersion, events: [asEvent(confirmed)] }, ...writes], (streamId, events) =>
      streamId.startsWith(PROPOSAL_PREFIX)
        ? this.#describeProposal(streamId, events)
        : streamId.startsWith(RECORD_PREFIX)
          ? this.#describeRecord(streamId, events)
          : null,
    );
    return this.proposal(id);
  }

  rejectProposal(id: string, expectedVersion: number): ProposalView {
    this.#store.assertVersion(proposalStream(id), expectedVersion, this.#describeProposal);
    const proposal = this.proposal(id);
    if (proposal.status !== "pending") throw new InvalidRequestError(`Proposal ${id} was already ${proposal.status}.`);
    const event: ProposalEvent = { type: "proposal_rejected", data: {} };
    this.#store.append(proposalStream(id), expectedVersion, [asEvent(event)], this.#describeProposal);
    return this.proposal(id);
  }

  // A system event with no expected version. See docs/decisions/0004-mcp-core.md (M-f).
  logAccess(entry: AccessEvent["data"]): void {
    this.#store.appendSystem(ACCESS_LOG_STREAM, [asEvent({ type: "tool_called", data: entry })]);
  }
}

// The appointment a proposal is about, as a slot key, or null for an
// office request with no date.
export function proposalTargets(change: ProposedChange): string | null {
  if (change.kind === "detail_edit" || change.kind === "archive") return change.appointment_id;
  if (change.date === null) return null;
  return slotKey(change.date, change.time);
}

// The evidence a confirmed report becomes. The agent's statement is kept as
// the quote, and the agent is named by the grant.
function claimFor(proposal: ProposalView, change: Exclude<ProposedChange, { kind: "archive" }>, slot: SlotView | null): EvidenceClaim {
  const base = {
    quote: change.statement,
    source_type: "reported_by_user_via_agent" as const,
    sender_kind: "person" as const,
    evidence_time: proposal.proposedAt,
    agent_name: proposal.grantName,
  };
  switch (change.kind) {
    case "new_appointment":
      return {
        ...base,
        claim_type: change.status === "offered" ? "offer" : "confirm",
        slot: { date: change.date, time: change.time, location: change.location },
        event_time: null,
        request_item: null,
      };
    case "user_report":
      return {
        ...base,
        claim_type: change.claim_type,
        slot: { date: change.date, time: change.time, location: change.location },
        event_time: null,
        request_item: change.request_item,
      };
    case "detail_edit":
      // A place correction is recorded like the user's answer about a place.
      return {
        ...base,
        claim_type: "clarify",
        slot: { date: slot!.date, time: slot!.time, location: change.location },
        event_time: null,
        request_item: null,
      };
  }
}
