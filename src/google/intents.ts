// Google intents (0012, review round 3, findings 1 to 3). A write at Google
// and the activity entry that records it cannot share one transaction,
// because the write is a network call. So the case actions record an
// intent in the store first, then write at Google, then close the intent
// and write the entry in one transaction. If the store write after the
// network call fails, the intent stays open: the next calendar call
// reconciles it by reading the event at Google, and a retried undo
// finishes it. While an intent for an appointment is open, no other Google
// write or undo for that appointment starts, in this process or another,
// because they share the store.
import { randomUUID } from "node:crypto";
import type { ActivityActor } from "../activity/types.ts";
import type { StoredEvent } from "../store/event-log.ts";
import type { WritePlan } from "./calendar.ts";
import type { GoogleActivityKind } from "./tools.ts";

export const GOOGLE_INTENTS_STREAM = "google_intents";

// Another Google Calendar change for the same appointment is in progress.
export class GoogleBusyError extends Error {
  override name = "GoogleBusyError";
}

// `owner` names the process that opened the intent (OWNER).
type IntentBase = { intent_id: string; slot_key: string; actor: ActivityActor; owner: string };

export type GoogleIntent =
  // A calendar write, with the entry it will write: its kind and summary
  // come from the plan, and the outcome may still change them.
  | (IntentBase & { kind: "write"; plan: WritePlan; entry_kind: GoogleActivityKind; summary: string })
  // An undo of the activity entry `entry_id`.
  | (IntentBase & { kind: "undo"; entry_id: string });

// This process, and the intents it is running now. An intent of this
// process that is not running was left open by a failed store write, and
// can be reconciled at once. One of another process may still be running
// there, so it is reconciled only after STALE_INTENT_MS. That is a
// heuristic only (review round 4, item 5): the guarantee is that a commit
// writes its entry only while its intent is still open, so a reconcile
// that ran first leaves it nothing to write twice.
export const OWNER = `${process.pid}:${randomUUID()}`;
export const RUNNING = new Set<string>();
export const STALE_INTENT_MS = 2 * 60_000;

export function reconcilable(intent: GoogleIntent, openedAt: string, now: number = Date.now()): boolean {
  if (RUNNING.has(intent.intent_id)) return false;
  return intent.owner === OWNER || now - Date.parse(openedAt) > STALE_INTENT_MS;
}

export type GoogleIntentEvent =
  | { type: "google_intent_opened"; data: GoogleIntent }
  // `outcome` "logged" wrote an entry, "abandoned" wrote nothing. `reason`
  // says why an intent was closed without its own commit, such as a
  // disconnect or another account (review round 4, item 3).
  | { type: "google_intent_closed"; data: { intent_id: string; outcome: "logged" | "abandoned"; entry_id: string | null; reason?: IntentCloseReason } };

export type IntentCloseReason = "not_applied" | "diverged" | "disconnected" | "account_changed";

export type IntentClosure = { outcome: "logged" | "abandoned"; entry_id: string | null; reason: IntentCloseReason | null };

// How an intent was closed, or null while it is open or unknown.
export function intentClosure(events: StoredEvent[], intentId: string): IntentClosure | null {
  let closed: IntentClosure | null = null;
  for (const e of events) {
    if (e.streamId !== GOOGLE_INTENTS_STREAM || e.type !== "google_intent_closed") continue;
    const d = e.data as Extract<GoogleIntentEvent, { type: "google_intent_closed" }>["data"];
    if (d.intent_id === intentId && closed === null) closed = { outcome: d.outcome, entry_id: d.entry_id, reason: d.reason ?? null };
  }
  return closed;
}

// The account and calendar an intent was made for (`sub|calendarId`).
export function intentAccount(intent: GoogleIntent, undoAccount: string | null): string | null {
  return intent.kind === "write" ? intent.plan.account : undoAccount;
}

// The intents still open, oldest first, with when each was opened.
export function openIntents(events: StoredEvent[]): Array<GoogleIntent & { openedAt: string }> {
  const open = new Map<string, GoogleIntent & { openedAt: string }>();
  for (const e of events) {
    if (e.streamId !== GOOGLE_INTENTS_STREAM) continue;
    const event = { type: e.type, data: e.data } as GoogleIntentEvent;
    if (event.type === "google_intent_opened") open.set(event.data.intent_id, { ...event.data, openedAt: e.recordedAt });
    else if (event.type === "google_intent_closed") open.delete(event.data.intent_id);
  }
  return [...open.values()];
}
