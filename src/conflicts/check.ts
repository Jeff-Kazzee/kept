// Code checks for model text about a conflict: citations and dates. A
// citation must name evidence of the conflict being explained, not only
// evidence that exists somewhere in the case. Every date and time in the
// text must appear in the cited evidence, so the model cannot add one.
import { parseMentions, weekdayOf } from "../domain/datetime.ts";
import type { EvidenceView } from "../intake/events.ts";

export type OutputProblem =
  | "call_failed"
  | "not_json"
  | "schema_mismatch"
  | "no_citation"
  | "unknown_evidence_id"
  | "evidence_not_in_conflict"
  | "invented_date_or_time"
  | "clinical_content"
  | "too_long"
  | "not_a_question"
  | "conflict_not_open";

export function checkCitations(cited: string[], caseIds: ReadonlySet<string>, conflictIds: ReadonlySet<string>): OutputProblem[] {
  const problems = new Set<OutputProblem>();
  if (cited.length === 0) problems.add("no_citation");
  for (const id of cited) {
    if (!caseIds.has(id)) problems.add("unknown_evidence_id");
    else if (!conflictIds.has(id)) problems.add("evidence_not_in_conflict");
  }
  return [...problems];
}

type Allowed = { monthDays: Set<string>; weekdays: Set<number>; times: Set<string> };

function allowedFrom(evidence: EvidenceView[]): Allowed {
  const allowed: Allowed = { monthDays: new Set(), weekdays: new Set(), times: new Set() };
  const addDate = (date: string) => {
    allowed.monthDays.add(date.slice(5, 10));
    allowed.weekdays.add(weekdayOf(date.slice(0, 10)));
  };
  for (const e of evidence) {
    const c = e.claim;
    if (c.slot.date) addDate(c.slot.date);
    if (c.slot.time) allowed.times.add(c.slot.time);
    for (const t of [c.event_time, c.evidence_time]) {
      if (!t) continue;
      addDate(t.slice(0, 10));
      if (t.length >= 16) allowed.times.add(t.slice(11, 16));
    }
    for (const m of parseMentions(c.quote ?? "")) {
      if (m.monthDay) allowed.monthDays.add(m.monthDay);
      if (m.weekday !== null) allowed.weekdays.add(m.weekday);
      for (const t of [...m.times, ...m.ambiguousTimes]) allowed.times.add(t);
    }
  }
  return allowed;
}

// True when every date, weekday and time in `text` appears in the cited
// evidence: in a slot value, an event or evidence time, or the quote. A bare
// "10:30" passes when either reading appears.
export function datesAndTimesSupported(text: string, cited: EvidenceView[]): boolean {
  const allowed = allowedFrom(cited);
  for (const m of parseMentions(text)) {
    if (m.monthDay !== null && !allowed.monthDays.has(m.monthDay)) return false;
    if (m.weekday !== null && !allowed.weekdays.has(m.weekday)) return false;
    if (m.times.some((t) => !allowed.times.has(t))) return false;
    for (let i = 0; i < m.ambiguousTimes.length; i += 2) {
      if (!allowed.times.has(m.ambiguousTimes[i]!) && !allowed.times.has(m.ambiguousTimes[i + 1]!)) return false;
    }
  }
  return true;
}

// FNV-1a, for short stable keys. Not for security.
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
