// Code checks for model text about a conflict: citations and dates. A
// citation must name evidence of the conflict being explained, not only
// evidence that exists somewhere in the case. Every date and time in the
// text must appear in the cited evidence, so the model cannot add one.
import { parseMentions, weekdayOf, type Mention } from "../domain/datetime.ts";
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

// One point in time that a cited evidence item states: from its slot, its
// event time, its evidence time, or one mention in its quote. A quote
// mention without a year means the arrival year, or the next year when
// that month and day had already passed on arrival, as in extraction.
type Fact = { monthDay: string | null; years: Set<number>; weekdays: Set<number>; times: Set<string> };

function dateFact(date: string, time: string | null): Fact {
  return {
    monthDay: date.slice(5, 10),
    years: new Set([Number(date.slice(0, 4))]),
    weekdays: new Set([weekdayOf(date.slice(0, 10))]),
    times: new Set(time ? [time] : []),
  };
}

function factsFrom(evidence: EvidenceView[]): Fact[] {
  const facts: Fact[] = [];
  for (const e of evidence) {
    const c = e.claim;
    if (c.slot.date) facts.push(dateFact(c.slot.date, c.slot.time));
    for (const t of [c.event_time, c.evidence_time]) {
      if (t) facts.push(dateFact(t.slice(0, 10), t.length >= 16 ? t.slice(11, 16) : null));
    }
    const arrival = Number(c.evidence_time.slice(0, 4));
    const arrivalDay = c.evidence_time.slice(5, 10);
    for (const m of parseMentions(c.quote ?? "")) {
      const times = new Set([...m.times, ...m.ambiguousTimes]);
      if (m.monthDay === null) {
        facts.push({ monthDay: null, years: new Set(), weekdays: new Set(m.weekday === null ? [] : [m.weekday]), times });
        continue;
      }
      // One fact per year the mention may mean, so a year and a weekday are
      // never taken from two different dates.
      const years = m.year !== null ? [m.year] : m.monthDay < arrivalDay ? [arrival, arrival + 1] : [arrival];
      for (const y of years) {
        facts.push({ monthDay: m.monthDay, years: new Set([y]), weekdays: new Set([m.weekday ?? weekdayOf(`${y}-${m.monthDay}`)]), times });
      }
    }
  }
  return facts;
}

function mentionMatches(m: Mention, f: Fact): boolean {
  if (m.monthDay !== null && m.monthDay !== f.monthDay) return false;
  if (m.year !== null && !f.years.has(m.year)) return false;
  if (m.weekday !== null && !f.weekdays.has(m.weekday)) return false;
  if (m.times.some((t) => !f.times.has(t))) return false;
  for (let i = 0; i < m.ambiguousTimes.length; i += 2) {
    if (!f.times.has(m.ambiguousTimes[i]!) && !f.times.has(m.ambiguousTimes[i + 1]!)) return false;
  }
  return true;
}

// True when each date mention in `text` matches one point in time that
// one cited evidence item states. A mention is checked as one unit: its
// year, month and day, weekday and times must all fit the same point. So
// "November 12 at 1:00 PM" fails when the evidence states November 12 at
// 10:30 AM and November 16 at 1:00 PM. A bare "10:30" passes when either
// reading fits.
export function datesAndTimesSupported(text: string, cited: EvidenceView[]): boolean {
  const facts = factsFrom(cited);
  return parseMentions(text).every((m) => facts.some((f) => mentionMatches(m, f)));
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
