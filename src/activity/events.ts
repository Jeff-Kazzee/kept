// The activity log (0009, design 3). Every action by the in-app agent, an
// external agent over MCP or the person is one `activity_recorded` event on
// the `activity` stream, written in the same transaction as the action. An
// entry holds a code-written summary, the actor, the target and how to undo
// it. Undo writes a reversing event on the target's own stream, an
// `activity_undone` event that marks the entry, and an entry of its own.
import type { CalendarUndo } from "../google/calendar.ts";
import type { TimezoneValue } from "../settings/events.ts";
import type { StoredEvent } from "../store/event-log.ts";
import type { ActivityActor, ActivityEntry, ActivityTarget } from "./types.ts";

export const ACTIVITY_STREAM = "activity";

// How to reverse an entry. Each kind names what the action wrote, so undo
// can check that it is still in effect and that nothing later depends on
// it.
export type UndoSpec =
  // Adding a message: it and its claims leave the case.
  | { kind: "message_import"; message_id: string }
  // The person's answer about their own report: the question opens again.
  | { kind: "own_report"; message_id: string }
  // A review decision. `version` is the evidence version the decision left.
  | { kind: "claim_decision"; evidence_id: string; version: number }
  | { kind: "question_answer"; question_id: string; evidence_ids: string[]; settled_ids: string[]; draft_id: string | null }
  | { kind: "question_ask"; question_id: string }
  // A note, a tag change or an archive, at its record version.
  | { kind: "record_event"; slot_key: string; version: number; event: "note_added" | "tags_set" | "record_archived" }
  | { kind: "record_unarchive"; slot_key: string; version: number }
  | { kind: "draft_start"; draft_id: string }
  | { kind: "draft_discard"; draft_id: string }
  | { kind: "timezone"; previous: TimezoneValue | null }
  // A Google Calendar write (0012). Undo reverses it at Google first, so it
  // runs outside the store transaction (CaseActions.undoEntry).
  | { kind: "google_calendar"; undo: CalendarUndo };

export type ActivityEvent =
  | {
      type: "activity_recorded";
      data: {
        id: string;
        actor: ActivityActor;
        kind: string;
        summary: string;
        // The words the person sees, when they differ (0016, M3, M4).
        label?: string;
        target: ActivityTarget;
        // Null when the entry cannot be undone. `why_not` then says why.
        undo: UndoSpec | null;
        why_not: string | null;
        // Appointments the action touched, so an undo can see whether a
        // later action, such as an approved reply, depends on it.
        slot_keys: string[];
        // For an undo entry, the entry it reversed.
        reverses?: string;
      };
    }
  | { type: "activity_undone"; data: { id: string; by: ActivityActor; undo_id: string } };

export type ActivityRecord = Extract<ActivityEvent, { type: "activity_recorded" }>["data"] & {
  seq: number;
  recordedAt: string;
  undoneAt: string | null;
  undoneBy: ActivityActor | null;
};

export type ActivityLog = { version: number; records: ActivityRecord[] };

export function projectActivity(events: StoredEvent[]): ActivityLog {
  const log: ActivityLog = { version: 0, records: [] };
  for (const e of events) {
    if (e.streamId !== ACTIVITY_STREAM) continue;
    log.version = e.version;
    const event = { type: e.type, data: e.data } as ActivityEvent;
    if (event.type === "activity_recorded") {
      log.records.push({ ...event.data, seq: e.seq, recordedAt: e.recordedAt, undoneAt: null, undoneBy: null });
    } else if (event.type === "activity_undone") {
      const r = log.records.find((x) => x.id === event.data.id);
      if (r) {
        r.undoneAt = e.recordedAt;
        r.undoneBy = event.data.by;
      }
    }
  }
  return log;
}

// The public entry, with times in the case's zone. `zoned` writes an ISO
// time with the zone's offset.
export function activityEntry(r: ActivityRecord, zoned: (iso: string) => string): ActivityEntry {
  return {
    id: r.id,
    at: zoned(r.recordedAt),
    actor: r.actor,
    kind: r.kind,
    summary: r.summary,
    ...(r.label ? { label: r.label } : {}),
    target: r.target,
    undoable: r.undo !== null && r.undoneAt === null,
    undone: r.undoneAt !== null,
    ...(r.undoneAt !== null ? { undoneAt: zoned(r.undoneAt) } : {}),
  };
}
