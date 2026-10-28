// Checks on the agent's final text (0007, G4 and G5) and the fact chips.
// Code collects a fact for each slot, claim and calendar event that a tool
// returned during the turn. Every date, weekday and time the text states
// must match one of them as a unit, the same way explanation text is
// checked against its cited evidence. The text also must not be clinical
// and must not say the agent changed anything, because no tool can.
import { parseMentions, weekdayOf, type Mention } from "../domain/datetime.ts";
import { hasClinicalContent } from "../domain/scope.ts";
import { timeLabel } from "../slots/labels.ts";
import type { SlotView } from "../slots/types.ts";
import type { FactChip } from "./types.ts";

// A point in time from a tool result: a date, with a time when one is known.
export type Fact = { date: string; time: string | null };

export type TextProblem = "ungrounded" | "clinical_content" | "claims_action" | "empty";

export const MAX_ANSWER_CHARS = 1200;

function dateMatches(m: Mention, f: Fact): boolean {
  if (m.monthDay !== null && m.monthDay !== f.date.slice(5, 10)) return false;
  if (m.year !== null && m.year !== Number(f.date.slice(0, 4))) return false;
  if (m.weekday !== null && m.weekday !== weekdayOf(f.date)) return false;
  return true;
}

// A mention matches when its date parts fit a fact and each time it states
// fits a fact on that same date. "Friday 11/13 9:15 AM, after the 9:00 AM
// meeting" needs Friday 11/13 at 9:15 AM and at 9:00 AM. A time needs a
// fact with that time: unknown times are never treated as known. A bare
// "10:30" passes when either reading fits.
function mentionMatches(m: Mention, facts: Fact[]): boolean {
  const onDate = facts.filter((f) => dateMatches(m, f));
  if (onDate.length === 0) return false;
  if (!m.times.every((t) => onDate.some((f) => f.time === t))) return false;
  for (let i = 0; i < m.ambiguousTimes.length; i += 2) {
    if (!onDate.some((f) => f.time === m.ambiguousTimes[i] || f.time === m.ambiguousTimes[i + 1])) return false;
  }
  return true;
}

// True when each date, weekday and time mention in `text` matches the facts.
export function grounded(text: string, facts: Fact[]): boolean {
  return parseMentions(text).every((m) => mentionMatches(m, facts));
}

// The agent has no tool that changes the schedule, so a first-person claim
// that it did is false whatever the case holds.
const ACTION_CLAIM =
  /\bI(?:'ve|’ve| have| just)?\s+(?:already\s+)?(?:accepted|approved|confirmed|canceled|cancelled|sent|rejected|declined|booked|rescheduled|moved|archived|deleted|answered|submitted)\b/i;

export function claimsAction(text: string): boolean {
  return ACTION_CLAIM.test(text.normalize("NFKC"));
}

export function checkAnswer(text: string, facts: Fact[]): TextProblem[] {
  const problems: TextProblem[] = [];
  if (text.trim() === "") return ["empty"];
  if (hasClinicalContent(text)) problems.push("clinical_content");
  if (!grounded(text, facts) || text.length > MAX_ANSWER_CHARS) problems.push("ungrounded");
  if (claimsAction(text)) problems.push("claims_action");
  return problems;
}

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "Mon 11/16 1:00 PM", or "Mon 11/16" with no time.
export function chipLabel(date: string, time: string | null): string {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  const day = `${SHORT_WEEKDAYS[weekdayOf(date)]} ${m}/${d}`;
  return time === null ? day : `${day} ${timeLabel(time)}`;
}

export function chipFor(slot: SlotView): FactChip {
  return { slotKey: slot.key, label: chipLabel(slot.date, slot.time), stateLabel: slot.stateLabel, evidenceIds: [...slot.evidenceIds] };
}

export const MAX_CHIPS = 8;

// The chips for a turn: the slots from the turn's tool results that the
// final text mentions. When the text mentions none of them, or code
// replaced the text, every slot the tools returned, up to MAX_CHIPS.
export function chipsFor(slots: SlotView[], text: string | null): FactChip[] {
  const unique = [...new Map(slots.map((s) => [s.key, s])).values()];
  if (text !== null) {
    const mentions = parseMentions(text);
    const named = unique.filter((s) =>
      mentions.some((m) => (m.monthDay !== null || m.weekday !== null) && dateMatches(m, s) && (m.times.length === 0 || m.times.includes(s.time ?? ""))),
    );
    if (named.length > 0) return named.slice(0, MAX_CHIPS).map(chipFor);
  }
  return unique.slice(0, MAX_CHIPS).map(chipFor);
}
