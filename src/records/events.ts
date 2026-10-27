// Event kinds for appointment records, agent proposals and the access log,
// and the projections built from them.
//
// - An appointment record is one slot, keyed by its slot key, such as
//   2026-11-16T13:00. The `record:<key>` stream holds its notes, tags,
//   archive and undo events. The slot's state still comes only from
//   accepted evidence.
// - Each `proposal:<id>` stream holds one change an agent proposed and the
//   user's decision on it. A proposal changes nothing until the user
//   confirms it in the app.
// - The `access_log` stream holds one system event per MCP tool call.
import type { ClaimType } from "../domain/claim.ts";
import type { RateWindow, StoredEvent } from "../store/event-log.ts";

export const RECORD_PREFIX = "record:";
export const PROPOSAL_PREFIX = "proposal:";
export const ACCESS_LOG_STREAM = "access_log";
export const recordStream = (id: string) => `${RECORD_PREFIX}${id}`;
export const proposalStream = (id: string) => `${PROPOSAL_PREFIX}${id}`;

// Who made a change. An agent is named by the grant it used, never by the
// name the client reports.
export type Actor = { kind: "user" } | { kind: "agent"; grant_id: string; grant_name: string };
export const USER: Actor = { kind: "user" };

export type RecordEvent =
  | { type: "note_added"; data: { note_id: string; text: string; by: Actor } }
  | { type: "tags_set"; data: { tags: string[]; by: Actor } }
  | { type: "record_archived"; data: { by: Actor; proposal_id: string | null } }
  // Undo appends this event. It reverses the event at `version`.
  | { type: "event_undone"; data: { version: number; by: Actor } };

export type Note = { id: string; text: string; by: Actor; at: string };

export type HistoryEntry = {
  version: number;
  type: RecordEvent["type"];
  by: Actor;
  at: string;
  // True when a later event_undone reversed this event.
  undone: boolean;
  // For event_undone, the version it reversed.
  reverses: number | null;
};

export type RecordView = {
  id: string;
  version: number;
  archived: boolean;
  notes: Note[];
  tags: string[];
  history: HistoryEntry[];
};

export function emptyRecord(id: string): RecordView {
  return { id, version: 0, archived: false, notes: [], tags: [], history: [] };
}

// Folds one record stream. An undone event is skipped, so undoing tags_set
// brings back the tags before it, and undoing an archive restores the
// record.
export function projectRecord(id: string, events: StoredEvent[]): RecordView {
  const record = emptyRecord(id);
  const typed = events.map((e) => ({ e, event: { type: e.type, data: e.data } as RecordEvent }));
  const undone = new Set<number>();
  for (const { event } of typed) if (event.type === "event_undone") undone.add(event.data.version);
  for (const { e, event } of typed) {
    record.version = e.version;
    record.history.push({
      version: e.version,
      type: event.type,
      by: event.data.by,
      at: e.recordedAt,
      undone: undone.has(e.version),
      reverses: event.type === "event_undone" ? event.data.version : null,
    });
    if (undone.has(e.version)) continue;
    if (event.type === "note_added") record.notes.push({ id: event.data.note_id, text: event.data.text, by: event.data.by, at: e.recordedAt });
    else if (event.type === "tags_set") record.tags = event.data.tags;
    else if (event.type === "record_archived") record.archived = true;
  }
  return record;
}

export function projectRecords(events: StoredEvent[]): Map<string, RecordView> {
  const byStream = new Map<string, StoredEvent[]>();
  for (const e of events) {
    if (!e.streamId.startsWith(RECORD_PREFIX)) continue;
    const list = byStream.get(e.streamId) ?? [];
    list.push(e);
    byStream.set(e.streamId, list);
  }
  const records = new Map<string, RecordView>();
  for (const [streamId, list] of byStream) {
    const id = streamId.slice(RECORD_PREFIX.length);
    records.set(id, projectRecord(id, list));
  }
  return records;
}

// A change an agent proposes. Validated by src/records/inputs.ts before it
// is stored. `statement` is the agent's own words, kept as untrusted text.
export type ProposedChange =
  | {
      kind: "new_appointment";
      date: string;
      time: string;
      location: string | null;
      status: "offered" | "confirmed";
      statement: string;
    }
  | {
      kind: "user_report";
      claim_type: ClaimType;
      date: string | null;
      time: string | null;
      location: string | null;
      request_item: string | null;
      statement: string;
    }
  | { kind: "detail_edit"; appointment_id: string; location: string; statement: string }
  | { kind: "archive"; appointment_id: string; statement: string };

export type ProposalEvent =
  | {
      type: "change_proposed";
      data: {
        grant_id: string;
        grant_name: string;
        change: ProposedChange;
        // The record version the agent saw, for changes to one record.
        record_version: number | null;
      };
    }
  | { type: "proposal_confirmed"; data: { evidence_ids: string[] } }
  | { type: "proposal_rejected"; data: Record<string, never> };

export type ProposalView = {
  id: string;
  version: number;
  grantId: string;
  grantName: string;
  change: ProposedChange;
  recordVersion: number | null;
  status: "pending" | "confirmed" | "rejected";
  proposedAt: string;
  decidedAt: string | null;
  evidenceIds: string[];
};

export function projectProposals(events: StoredEvent[]): Map<string, ProposalView> {
  const views = new Map<string, ProposalView>();
  for (const e of events) {
    if (!e.streamId.startsWith(PROPOSAL_PREFIX)) continue;
    const id = e.streamId.slice(PROPOSAL_PREFIX.length);
    const event = { type: e.type, data: e.data } as ProposalEvent;
    if (event.type === "change_proposed") {
      views.set(id, {
        id,
        version: e.version,
        grantId: event.data.grant_id,
        grantName: event.data.grant_name,
        change: event.data.change,
        recordVersion: event.data.record_version,
        status: "pending",
        proposedAt: e.recordedAt,
        decidedAt: null,
        evidenceIds: [],
      });
      continue;
    }
    const view = views.get(id);
    if (!view) continue;
    view.version = e.version;
    if (event.type === "proposal_confirmed") {
      view.status = "confirmed";
      view.decidedAt = e.recordedAt;
      view.evidenceIds = event.data.evidence_ids;
    } else if (event.type === "proposal_rejected") {
      view.status = "rejected";
      view.decidedAt = e.recordedAt;
    }
  }
  return views;
}

export type AccessResult =
  | "ok"
  | "permission_denied"
  | "unknown_tool"
  | "invalid_input"
  | "not_found"
  | "stale_edit"
  | "out_of_scope"
  | "rate_limited"
  | "busy"
  | "error";

// One MCP tool call. Never holds the token, its hash or the call's input.
// The first call a rate limit denies in a window is logged on its own. The
// later denials of that window are logged as one summary entry with tool
// "*" and `count`, when the window closes: on the next call to any server
// on the file after the window, at server start, or when the grant is
// revoked. A name that is not a tool is never stored. The entry has tool
// "(unknown)" and a short fingerprint of the name, so repeated probes with
// one name can be grouped.
export type AccessEvent = {
  type: "tool_called";
  data: {
    grant_id: string | null;
    grant_name: string | null;
    tool: string;
    result: AccessResult;
    appointment_id: string | null;
    count?: number;
    name_fingerprint?: string;
  };
};

export const UNKNOWN_TOOL = "(unknown)";

// The denials after the first in each closed window, as one entry per
// window. The first denial was logged when it happened.
export function rateSummaryEvents(windows: RateWindow[], grantOf: (key: string) => { grant_id: string | null; grant_name: string | null }): AccessEvent[] {
  return windows
    .filter((w) => w.denied > 1)
    .map((w) => ({ type: "tool_called", data: { ...grantOf(w.key), tool: "*", result: "rate_limited", appointment_id: null, count: w.denied - 1 } }));
}

export type AccessEntry = AccessEvent["data"] & { at: string };

export function projectAccessLog(events: StoredEvent[]): AccessEntry[] {
  return events
    .filter((e) => e.streamId === ACCESS_LOG_STREAM && e.type === "tool_called")
    .map((e) => ({ ...(e.data as AccessEvent["data"]), at: e.recordedAt }));
}
