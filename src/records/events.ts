// Event kinds for appointment records and the access log, and the
// projections built from them.
//
// - An appointment record is one slot, keyed by its slot key, such as
//   2026-11-16T13:00. The `record:<key>` stream holds its notes, tags,
//   archive and undo events. The slot's state still comes only from
//   accepted evidence.
// - The `access_log` stream holds one system event per MCP tool call.
// - Streams from before sprint 8 (`grant:` and `proposal:`) and their
//   events are skipped by every projection.
import type { ActivityActor } from "../activity/types.ts";
import { ASSISTANT_NAME, EXTERNAL_AGENT_NAME } from "../slots/labels.ts";
import type { StoredEvent } from "../store/event-log.ts";

export const RECORD_PREFIX = "record:";
export const ACCESS_LOG_STREAM = "access_log";
export const recordStream = (id: string) => `${RECORD_PREFIX}${id}`;

// Who made a change. Code names an agent: the assistant or an external
// agent. Records from before sprint 8 name an agent by its grant.
export type Actor = { kind: "user" } | { kind: "agent"; name: string } | { kind: "agent"; grant_id: string; grant_name: string };
export const USER: Actor = { kind: "user" };

export const actorFor = (a: ActivityActor): Actor =>
  a === "you" ? USER : { kind: "agent", name: a === "agent" ? ASSISTANT_NAME : EXTERNAL_AGENT_NAME };

// "you", "the assistant", "an external agent", or an old grant's name.
export const actorName = (a: Actor): string => (a.kind === "user" ? "you" : "name" in a ? a.name : a.grant_name);

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

// "refused" is a call the app's rules refused, such as an undo that a
// later action blocks. Entries from before sprint 8 may also hold
// "permission_denied".
export type AccessResult =
  | "ok"
  | "unknown_tool"
  | "invalid_input"
  | "not_found"
  | "stale_edit"
  | "out_of_scope"
  | "refused"
  | "rate_limited"
  | "busy"
  | "error";

// One MCP tool call. Never holds the call's input. A name that is not a
// tool is never stored. The entry has tool "(unknown)" and a short
// fingerprint of the name, so repeated probes with one name can be
// grouped. Entries from before sprint 8 name a grant instead of the actor.
export type AccessEvent = {
  type: "tool_called";
  data: {
    actor?: "mcp";
    tool: string;
    result: AccessResult;
    appointment_id: string | null;
    count?: number;
    name_fingerprint?: string;
    grant_id?: string | null;
    grant_name?: string | null;
  };
};

export const UNKNOWN_TOOL = "(unknown)";

export type AccessEntry = AccessEvent["data"] & { at: string };

export function projectAccessLog(events: StoredEvent[]): AccessEntry[] {
  return events
    .filter((e) => e.streamId === ACCESS_LOG_STREAM && e.type === "tool_called")
    .map((e) => ({ ...(e.data as AccessEvent["data"]), at: e.recordedAt }));
}
