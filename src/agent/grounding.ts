// Checks on the agent's final text (0007, G4, G5 and review round 1) and
// the fact chips. Code collects the facts the turn's tool results hold:
// each slot with its state, each claim, each calendar event, and statuses
// such as "a claim was accepted" or "a reply was sent". The text is read as
// the scope check reads it, with dates and times rewritten into forms the
// shared parser reads (dates.ts), and then:
// - every date, weekday and time must match the facts as a unit. A time
//   with no date must belong to a date in the same sentence, or to the
//   facts' single date. Date-like text code cannot read fails.
// - every state word (confirmed, booked, requested, canceled, declined,
//   moved, rescheduled) must agree with the state of the slots its clause
//   or sentence names, negation included. With no slot named, a positive
//   state needs a slot in that state among the facts. Questions assert
//   nothing and are not checked for states.
// - a statement that a claim, reply or proposal was accepted, rejected,
//   approved, sent or confirmed needs that status among the facts.
// - no first-person claim that the assistant changed anything, because no
//   tool can.
// - no clinical content.
import { parseMentions, weekdayOf, type Mention } from "../domain/datetime.ts";
import { hasClinicalContent, normalizeForScope } from "../domain/scope.ts";
import type { SlotState } from "../domain/claim.ts";
import { timeLabel } from "../slots/labels.ts";
import type { SlotView } from "../slots/types.ts";
import { canonicalDates, loneDays } from "./dates.ts";
import type { FactChip } from "./types.ts";

// A point in time from a tool result. A slot carries its state.
export type Fact = { date: string; time: string | null; state?: SlotState };

// Statuses a tool result showed. Code-written, never model text.
export type Status = "claim:accepted" | "claim:rejected" | "reply:sent" | "proposal:confirmed" | "proposal:rejected";

// `scheduleRead` is true when a tool read the whole schedule this turn, so
// a statement such as "nothing is confirmed" has the case behind it.
export type Grounds = { facts: Fact[]; statuses: Set<Status>; today: string | null; scheduleRead?: boolean };

export type TextProblem = "ungrounded" | "state_mismatch" | "clinical_content" | "claims_action" | "empty";

export const MAX_ANSWER_CHARS = 1200;

function dateMatches(m: Mention, f: { date: string }): boolean {
  if (m.monthDay !== null && m.monthDay !== f.date.slice(5, 10)) return false;
  if (m.year !== null && m.year !== Number(f.date.slice(0, 4))) return false;
  if (m.weekday !== null && m.weekday !== weekdayOf(f.date)) return false;
  return true;
}

const hasDate = (m: Mention) => m.monthDay !== null || m.weekday !== null;

// Each time a mention states fits a fact among `onDate`. A time needs a
// fact with that time: unknown times are never treated as known. A bare
// "10:30" passes when either reading fits.
function timesFit(m: Mention, onDate: Fact[]): boolean {
  if (!m.times.every((t) => onDate.some((f) => f.time === t))) return false;
  for (let i = 0; i < m.ambiguousTimes.length; i += 2) {
    if (!onDate.some((f) => f.time === m.ambiguousTimes[i] || f.time === m.ambiguousTimes[i + 1])) return false;
  }
  return true;
}

// The sentences of canonical text. Times are already "1:00 pm", so a period
// ends a sentence.
const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

// A day written alone ("the 16th") becomes the facts' one date with that
// day, or stays unreadable.
function resolveLoneDays(text: string, facts: Fact[]): { text: string; ok: boolean } {
  let ok = true;
  let out = text;
  for (const d of loneDays(text).reverse()) {
    const dates = [...new Set(facts.filter((f) => Number(f.date.slice(8, 10)) === d.day).map((f) => f.date))];
    if (dates.length !== 1) {
      ok = false;
      continue;
    }
    const date = dates[0]!;
    out = `${out.slice(0, d.index)}${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}${out.slice(d.index + d.match.length)}`;
  }
  return { text: out, ok };
}

// True when each date, weekday and time in `text` matches the facts.
export function grounded(text: string, facts: Fact[], today: string | null = null): boolean {
  const canonical = canonicalDates(text, today);
  if (canonical.unreadable.length > 0) return false;
  const lone = resolveLoneDays(canonical.text, facts);
  if (!lone.ok) return false;
  const dates = [...new Set(facts.map((f) => f.date))];
  for (const s of sentences(lone.text)) {
    const mentions = parseMentions(s);
    const dated = mentions.filter(hasDate);
    for (const m of mentions) {
      if (hasDate(m)) {
        const onDate = facts.filter((f) => dateMatches(m, f));
        if (onDate.length === 0 || !timesFit(m, onDate)) return false;
        continue;
      }
      // A time with no date of its own.
      const onDate =
        dated.length > 0 ? facts.filter((f) => dated.some((d) => dateMatches(d, f))) : dates.length === 1 ? facts.filter((f) => f.date === dates[0]) : [];
      if (onDate.length === 0 || !timesFit(m, onDate)) return false;
    }
  }
  return true;
}

// State words and the slot states that make them true, in synonym groups
// (review round 2, finding 4). A moved or rescheduled slot is canceled. A
// change that is only proposed has not moved anything. "Moved to Monday"
// names the new slot, which fits when it is held and another slot was
// canceled. "Offered", "available" and "open" are checked only against a
// slot their own clause names, because "the question is open" names none.
const STATE_WORDS: Array<{ re: RegExp; states: SlotState[]; moved?: boolean; namedOnly?: boolean }> = [
  {
    re: /\b(?:confirmed|booked|scheduled|all set|locked in|good to go|set for|you're on|you are on|on the (?:books|calendar|schedule))\b/g,
    states: ["confirmed", "change_proposed"],
  },
  { re: /\b(?:offered|available|open)\b/g, states: ["offered"], namedOnly: true },
  { re: /\b(?:requested|awaiting confirmation|waiting (?:for|on) (?:the office|confirmation))\b/g, states: ["requested"] },
  { re: /\bpending\b/g, states: ["requested", "change_proposed"] },
  { re: /\b(?:canceled|cancelled|called off|no longer happening)\b/g, states: ["canceled"] },
  { re: /\b(?:declined|turned down)\b/g, states: ["declined"] },
  { re: /\b(?:moved|rescheduled)\b/g, states: ["canceled"], moved: true },
];

// Status words code cannot map to a slot state. Said of a named slot, they
// fail closed.
const UNMAPPED_STATUS =
  /\b(?:finali[sz]ed|secured|reserved|sorted|settled|fixed|nailed down|firmed up|guaranteed|approved|accepted|held|on hold|tentative|penciled in|pencilled in)\b/;

const NEGATIONS = /\b(?:not|never|no|none|nothing|neither|nor|yet to|no longer|cannot)\b|n't\b/g;
const negations = (text: string) => (text.match(NEGATIONS) ?? []).length;

// Words before a state word that make the clause a condition or an open
// question rather than a statement: "I can check whether Monday is
// confirmed", "once it is confirmed".
const CONDITIONAL = /\b(?:whether|if|once|unless|in case|until|when|after)\b/;

// A pronoun that refers back to the slot of the sentence before, and words
// that point to a different one.
const PRONOUN = /\b(?:it|it's|its|that one|this one|that appointment|this appointment|that time|this time|that visit|this visit|that slot|this slot)\b/;
const OTHER = /\b(?:other|another|different|new|second|first|earlier|later)\s+(?:appointment|time|slot|visit|one)\b/;

// Statuses of claims, replies and proposals.
const STATUS_WORDS: Array<{ re: RegExp; noun: RegExp; statuses: Status[] }> = [
  { re: /\baccepted\b/, noun: /\b(?:claims?|items?|evidence|facts?)\b/, statuses: ["claim:accepted"] },
  { re: /\brejected\b/, noun: /\b(?:claims?|items?|evidence|facts?|proposals?|changes?)\b/, statuses: ["claim:rejected", "proposal:rejected"] },
  { re: /\b(?:approved|sent)\b/, noun: /\b(?:repl(?:y|ies)|drafts?|answers?)\b/, statuses: ["reply:sent"] },
  { re: /\b(?:confirmed|accepted|approved)\b/, noun: /\b(?:proposals?|proposed changes?)\b/, statuses: ["proposal:confirmed"] },
];

// A colon splits a clause only before a space, so "10:30" stays whole.
const clauses = (s: string) => s.split(/[,;]|:\s|\b(?:and|but|while|whereas|so|although|though)\b/).map((c) => c.trim()).filter(Boolean);

// The slots among the facts that the mentions name.
function slotsNamed(mentions: Mention[], facts: Fact[]): Fact[] {
  return facts.filter(
    (f) => f.state !== undefined && mentions.some((m) => hasDate(m) && dateMatches(m, f) && (m.times.length === 0 || (f.time !== null && m.times.includes(f.time)))),
  );
}

// True when every state and status the text asserts agrees with the facts.
export function statesAgree(text: string, grounds: Grounds): boolean {
  const canonical = canonicalDates(text, grounds.today).text;
  const slots = grounds.facts.filter((f) => f.state !== undefined);
  const fitsWord = (w: (typeof STATE_WORDS)[number]) => (f: Fact) =>
    w.states.includes(f.state!) || (w.moved === true && (f.state === "confirmed" || f.state === "requested") && slots.some((x) => x.state === "canceled"));
  let previous: Fact[] = [];
  for (const s of sentences(canonical)) {
    const sentenceSlots = slotsNamed(parseMentions(s), grounds.facts);
    // A question asserts nothing.
    if (s.endsWith("?")) {
      if (sentenceSlots.length > 0) previous = sentenceSlots;
      continue;
    }
    for (const c of clauses(s)) {
      const clauseSlots = slotsNamed(parseMentions(c), grounds.facts);
      // The slot of the sentence before carries over only through a
      // pronoun, and never to "the other appointment" (finding 6).
      const carried = PRONOUN.test(c) && !OTHER.test(c) ? previous : [];
      const targets = clauseSlots.length > 0 ? clauseSlots : sentenceSlots.length > 0 && !OTHER.test(c) ? sentenceSlots : carried;
      for (const w of STATE_WORDS) {
        const fits = fitsWord(w);
        for (const m of c.matchAll(w.re)) {
          const before = c.slice(0, m.index);
          if (CONDITIONAL.test(before)) continue;
          const n = negations(before);
          // Finding 5: two negations read either way, so they fail closed.
          if (n > 1) return false;
          const negated = n === 1;
          if (w.namedOnly && clauseSlots.length === 0) continue;
          const named = w.namedOnly ? clauseSlots : targets;
          if (named.length > 0) {
            // A positive state needs a named slot in it. A negated one needs
            // a named slot outside it.
            if (negated ? named.every(fits) : !named.some(fits)) return false;
          } else if (negated ? slots.length === 0 && grounds.scheduleRead !== true : !slots.some(fits)) {
            return false;
          }
        }
      }
      // A status word code cannot map, said of a slot, fails closed. A
      // status of claims or replies is checked below instead.
      const unmapped = c.match(UNMAPPED_STATUS);
      if (unmapped && targets.length > 0 && !STATUS_WORDS.some((w) => w.noun.test(c)) && !CONDITIONAL.test(c.slice(0, unmapped.index))) return false;
      for (const w of STATUS_WORDS) {
        const at = c.search(w.re);
        if (at === -1 || !w.noun.test(c)) continue;
        if (CONDITIONAL.test(c.slice(0, at))) continue;
        if (negations(c.slice(0, at)) === 0 && !w.statuses.some((x) => grounds.statuses.has(x))) return false;
      }
    }
    if (sentenceSlots.length > 0) previous = sentenceSlots;
  }
  return true;
}

// The agent has no tool that changes the schedule, so a first-person claim
// that it did is false whatever the case holds. "We" counts, as the
// assistant speaking for the app.
const SUBJECT = String.raw`\b(?:i|we)(?:'ve|'d)?`;
const HELPERS = String.raw`(?:\s+(?:have|has|had|just|already|now|also|successfully|went ahead and|gone ahead and))*`;
const PAST = "accepted|approved|confirmed|canceled|cancelled|sent|rejected|declined|booked|rescheduled|moved|archived|deleted|answered|submitted|changed|updated|removed";
const BASE = "accept|approve|confirm|cancel|send|reject|decline|book|reschedule|move|archive|delete|answer|submit|change|update|remove";
const ACTION_CLAIM = new RegExp(`${SUBJECT}${HELPERS}\\s+(?:${PAST})\\b|${SUBJECT}${HELPERS}\\s+did\\s+(?:${BASE})\\b`);

export function claimsAction(text: string): boolean {
  return ACTION_CLAIM.test(normalizeForScope(text).toLowerCase().replace(/[’‘]/g, "'"));
}

export function checkAnswer(text: string, grounds: Grounds): TextProblem[] {
  const normalized = normalizeForScope(text);
  if (normalized.trim() === "") return ["empty"];
  const problems: TextProblem[] = [];
  if (hasClinicalContent(text)) problems.push("clinical_content");
  if (!grounded(text, grounds.facts, grounds.today) || text.length > MAX_ANSWER_CHARS) problems.push("ungrounded");
  if (!statesAgree(text, grounds)) problems.push("state_mismatch");
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
export function chipsFor(slots: SlotView[], text: string | null, today: string | null = null): FactChip[] {
  const unique = [...new Map(slots.map((s) => [s.key, s])).values()];
  if (text !== null) {
    const mentions = parseMentions(canonicalDates(text, today).text);
    const named = unique.filter((s) => mentions.some((m) => hasDate(m) && dateMatches(m, s) && (m.times.length === 0 || m.times.includes(s.time ?? ""))));
    if (named.length > 0) return named.slice(0, MAX_CHIPS).map(chipFor);
  }
  return unique.slice(0, MAX_CHIPS).map(chipFor);
}
