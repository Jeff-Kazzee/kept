// Undo of one or more activity entries, in one place (U9, Muse round 1,
// findings 3 and 4). Entries are undone newest first, whatever order the
// caller passed them in. The activity is read again right before the first
// undo, so the version sent is the current one and an entry that is gone or
// already undone is skipped. Each later undo sends the version read after
// the one before. A refusal stops the run.
import { ApiError } from "../api.ts";
import type { AgentBackend } from "../agentApi.ts";
import type { ActivityLog } from "../contract.ts";

// The ids, newest first, by their place in the activity (newest first).
// Ids the activity does not know keep their order at the end.
export function newestFirst(ids: readonly string[], log: ActivityLog | null): string[] {
  const at = new Map((log?.entries ?? []).map((e, i) => [e.id, i]));
  return [...ids].sort((a, b) => (at.get(a) ?? Number.MAX_SAFE_INTEGER) - (at.get(b) ?? Number.MAX_SAFE_INTEGER));
}

export type UndoOutcome = { done: string[]; blocked: { id: string; error: ApiError } | null; error: unknown };

export async function runUndo(backend: Pick<AgentBackend, "activity" | "undo">, ids: readonly string[]): Promise<UndoOutcome> {
  const out: UndoOutcome = { done: [], blocked: null, error: null };
  let log: ActivityLog | null;
  try {
    log = await backend.activity();
  } catch (e) {
    out.error = e;
    return out;
  }
  const open = new Set((log?.entries ?? []).filter((e) => e.undoable && !e.undone).map((e) => e.id));
  for (const id of newestFirst(ids, log)) {
    if (!open.has(id)) continue;
    try {
      await backend.undo(id, log?.activityVersion ?? 0);
      out.done.push(id);
      log = await backend.activity();
    } catch (e) {
      if (e instanceof ApiError && e.body.error === "undo_blocked") out.blocked = { id, error: e };
      else out.error = e;
      break;
    }
  }
  return out;
}

// Runs one undo at a time. A call made while another runs is refused, so
// two clicks cannot race each other.
export function serialUndo() {
  let running = false;
  return async <T>(task: () => Promise<T>): Promise<T | null> => {
    if (running) return null;
    running = true;
    try {
      return await task();
    } finally {
      running = false;
    }
  };
}
