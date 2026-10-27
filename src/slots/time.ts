// When the event an evidence item describes happened, as far as code can
// tell. Rules 4 and 5 compare these times.
//
// - A stated event time with a clock time is used as is. A date alone is
//   too coarse to order events within a day, so it counts as unknown.
// - An answer is ordered just after the latest evidence the user had in
//   view, or at the time of the answer if that is later.
// - An automated sender may send stale content, so its time is unknown.
// - A user report, or a message a person at the office sent, describes the
//   state when it was sent, so its time is the evidence time.
// - Any other office message (sender kind unknown) has an unknown time.
import type { EvidenceView } from "../intake/events.ts";

export function effectiveTime(e: EvidenceView): number | null {
  const c = e.claim;
  if (c.event_time !== null && c.event_time.length > 10) return Date.parse(c.event_time);
  if (c.event_time !== null) return null;
  // Effects of one answer are ordered by their index, so a run such as a
  // cancel and then an offer applies in that order.
  if (e.answer) return Math.max(Date.parse(c.evidence_time), Date.parse(e.answer.after) + 1) + (e.answer.index ?? 0);
  if (c.sender_kind === "automated") return null;
  if (c.source_type !== "office_message") return Date.parse(c.evidence_time);
  return c.sender_kind === "person" ? Date.parse(c.evidence_time) : null;
}

// For ordering where an event time is unknown: the event time if known,
// otherwise when the evidence arrived.
export function arrivalTime(e: EvidenceView): number {
  return effectiveTime(e) ?? Date.parse(e.claim.evidence_time);
}

// True when `a` certainly happened before `b`. The event a message
// describes happens no later than the message arrives, so a claim with an
// unknown time is bounded above by its evidence time but has no lower bound.
export function certainlyBefore(a: EvidenceView, b: EvidenceView): boolean {
  const latestA = effectiveTime(a) ?? Date.parse(a.claim.evidence_time);
  const earliestB = effectiveTime(b) ?? Number.NEGATIVE_INFINITY;
  return latestA < earliestB;
}
