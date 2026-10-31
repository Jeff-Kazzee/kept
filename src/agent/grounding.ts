// Checks on the agent's final text (0007, G4, G5 and review round 1) and
// the fact chips. Code collects the facts the turn's tool results hold:
// each slot with its state, each claim, each calendar event, and statuses
// such as "a claim was accepted" or "a reply was sent". The text is read as
// the scope check reads it, with dates and times rewritten into forms the
// shared parser reads (dates.ts), and then:
// - every date, weekday and time must match the facts as a unit. A time
//   with no date must belong to a date in the same sentence, or to the
//   facts' single date. Date-like text code cannot read fails.
// - every state word (confirmed, booked, requested, tentative, canceled,
//   declined, moved, rescheduled) must agree with the state of the slots its
//   clause or sentence names, negation included. With no slot named, a positive
//   state needs a slot in that state among the facts. Questions assert
//   nothing and are not checked for states.
// - a statement that a claim or reply was accepted, rejected, approved,
//   sent or confirmed needs that status among the facts.
// - a first-person claim that the assistant did something must match an
//   action the activity log shows it took in this turn (0009, design 5).
//   It never approves, sends, confirms, cancels, books, moves or deletes,
//   because no tool does.
// - no clinical content.
import { parseMentions, weekdayOf, type Mention } from "../domain/datetime.ts";
import { hasClinicalContent, normalizeForScope } from "../domain/scope.ts";
import type { SlotState } from "../domain/claim.ts";
import { timeLabel } from "../slots/labels.ts";
import type { SlotView } from "../slots/types.ts";
import { canonicalDates, loneDays } from "./dates.ts";
import type { FactChip } from "./types.ts";

// A point in time from a tool result. A slot carries its state. After a
// Google Calendar write of this turn it also carries `event`: the status of
// the app's event for it, or null when the write left none (sprint 20, 0022).
// A calendar event's start also carries the event's `title`, as the tool
// gave it (fix round 2).
export type Fact = { date: string; time: string | null; state?: SlotState; event?: "tentative" | "confirmed" | null; title?: string };

// Statuses a tool result showed. Code-written, never model text.
export type Status = "claim:accepted" | "claim:rejected" | "reply:sent";

// `scheduleRead` is true when a tool read the whole schedule this turn, so
// a statement such as "nothing is confirmed" has the case behind it.
// `done` holds the kinds of the activity entries the agent wrote in this
// turn, such as claim_accepted.
export type Grounds = { facts: Fact[]; statuses: Set<Status>; today: string | null; scheduleRead?: boolean; done?: ReadonlySet<string> };

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

// Fix round 2, finding 3 (0022): calendar event titles. A title is text
// anyone with access to the calendar writes, so an answer may repeat one
// only as the tool gave it, for the event at that start: the sentence must
// name the event's date, and any time it names on that date that is not an
// appointment's must be the event's start. A title with a sentence break in
// it, or of more than eight words, is never repeated. In a sentence that
// says a time clashes, overlaps or conflicts with something, that thing is
// a date, a time, a plain word such as "an event", or part of a title the
// tools gave for that date. A title that may not be repeated whole may not
// be named in part either.
const MAX_TITLE_WORDS = 8;
const plain = (t: string) => normalizeForScope(t).replace(/\p{Cc}/gu, " ").toLowerCase().replace(/\s+/g, " ").trim();
const CLASH_WITH = /\b(?:clash(?:es|ed|ing)?|overlap(?:s|ped|ping)?|conflict(?:s|ed|ing)?)\b(?:\s+with)?\s*/g;
const OBJECT_END =
  /\s+(?:at|on|from|which|that|starting|in|between|during|until|to|by|and|but|so|for|when|while)\b|\s+(?=\d|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)|[,;:!?]|\.(?:\s|$)|$/;
const DETERMINER = /^(?:(?:the|your|a|an|my|one|another|this|that|its|their|any|existing|other)\s+)+/;
const GENERIC =
  /^(?:$|\d|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b|(?:events?|meetings?|appointments?|entr(?:y|ies)|items?|something|nothing|anything|it|them|calendar|google calendar)\b)/;
const TRAILING_NOUN = /\s+(?:meeting|event|appointment|call)s?$/;
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fitTitle = (t: string) => t.split(" ").length <= MAX_TITLE_WORDS && !/[.!?](?:\s|$)/.test(t);

export function titlesAgree(text: string, facts: Fact[], today: string | null = null): boolean {
  const titled = facts.filter((f) => f.title !== undefined).map((f) => ({ ...f, t: plain(canonicalDates(f.title!, today).text) }));
  const canonical = canonicalDates(text, today).text;
  const slotTimes = new Set(facts.filter((f) => f.state !== undefined).map((f) => `${f.date}T${f.time}`));
  // The sentence names the event's date, and no other time on it that is
  // not an appointment's.
  const bound = (sentence: string, f: { date: string; time: string | null }) => {
    const onDate = parseMentions(sentence).filter((m) => hasDate(m) && dateMatches(m, f));
    if (onDate.length === 0) return false;
    const otherTimes = onDate.flatMap((m) => m.times).filter((t) => !slotTimes.has(`${f.date}T${t}`));
    return otherTimes.length === 0 || otherTimes.includes(f.time ?? "");
  };
  // A title a sentence repeats whole, found in the whole text, so one with
  // a sentence break in it is found too.
  const whole = plain(canonical);
  for (const t of new Set(titled.map((f) => f.t))) {
    if (t.length < 2 || !new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(t)}(?:$|[^\\p{L}\\p{N}])`, "u").test(whole)) continue;
    if (!fitTitle(t)) return false;
    const where = sentences(canonical).filter((s) => plain(s).includes(t));
    if (where.length === 0 || !where.every((s) => titled.some((f) => f.t === t && bound(s, f)))) return false;
  }
  // What a time clashes with.
  for (const s of sentences(canonical)) {
    const p = plain(s);
    for (const m of p.matchAll(CLASH_WITH)) {
      const rest = p.slice(m.index! + m[0].length).replace(DETERMINER, "");
      const object = rest.slice(0, rest.search(OBJECT_END)).replace(TRAILING_NOUN, "").trim();
      if (GENERIC.test(object)) continue;
      if (!titled.some((f) => ` ${f.t} `.includes(` ${object} `) && fitTitle(f.t) && bound(s, f))) return false;
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
// Sprint 20 (0022): the app's Google Calendar event is tentative while its
// slot is requested or a change is proposed, and confirmed when the slot is
// (calendar_sync_slot), so "tentative" is a state word of those slots. In a
// clause that names the calendar or an event, "tentative" and "confirmed"
// are said of the app's event instead, and need this turn's `event` fact
// for that slot with that status (`eventStatus`). Fix round 2: the clause
// is about the event when its sentence names one, unless the clause names
// another slot, and "booked" or "scheduled" said of an event means confirmed.
// "On the calendar", and since fix round 2 "on" or "in" the, your, my or
// Google Calendar, is true of a slot whose last event fact this turn shows
// an event (`onCalendar`). Without an event fact, "on the calendar" still
// means confirmed, and the other forms are not read as a state, because
// "the standup on your calendar" names no appointment's state.
type StateWord = { re: RegExp; states: SlotState[]; moved?: boolean; namedOnly?: boolean; eventStatus?: "tentative" | "confirmed"; onCalendar?: boolean };
const STATE_WORDS: StateWord[] = [
  { re: /\bconfirmed\b/g, states: ["confirmed", "change_proposed"], eventStatus: "confirmed" },
  {
    re: /\b(?:booked|scheduled|all set|locked in|good to go|set for|you're on|you are on|on the (?:books|schedule))\b/g,
    states: ["confirmed", "change_proposed"],
    eventStatus: "confirmed",
  },
  { re: /\b(?:on|in) (?:the |your |my )?(?:google )?calendar\b/g, states: ["confirmed", "change_proposed"], onCalendar: true },
  { re: /\b(?:offered|available|open)\b/g, states: ["offered"], namedOnly: true },
  { re: /\b(?:requested|awaiting confirmation|waiting (?:for|on) (?:the office|confirmation))\b/g, states: ["requested"] },
  { re: /\btentative(?:ly)?\b/g, states: ["requested", "change_proposed"], eventStatus: "tentative" },
  { re: /\bpending\b/g, states: ["requested", "change_proposed"] },
  { re: /\b(?:canceled|cancelled|called off|no longer happening)\b/g, states: ["canceled"] },
  { re: /\b(?:declined|turned down)\b/g, states: ["declined"] },
  { re: /\b(?:moved|rescheduled)\b/g, states: ["canceled"], moved: true },
];

// A clause that names the calendar or an event of it.
const EVENT_NOUN = /\b(?:calendars?|events?)\b/;
// A removal right before "in Google Calendar" or "on the calendar" says the
// event is not there: "it was removed in Google Calendar".
const REMOVAL_BEFORE = /\b(?:removed|deleted|taken off|taken out|cleared)\s+$/;

// Status words code cannot map to a slot state. Said of a named slot, they
// fail closed.
const UNMAPPED_STATUS =
  /\b(?:finali[sz]ed|secured|reserved|sorted|settled|fixed|nailed down|firmed up|guaranteed|approved|accepted|held|on hold|penciled in|pencilled in)\b/;

const NEGATIONS = /\b(?:not|never|no|none|nothing|neither|nor|yet to|no longer|cannot)\b|n't\b/g;
const negations = (text: string) => (text.match(NEGATIONS) ?? []).length;

// A noun right after a state word that makes it describe claims.
const CLAIM_NOUN_AFTER = /^\s+(?:items?|claims?|facts?|evidence|reviews?)\b/;

// Words before a state word that make the clause a condition or an open
// question rather than a statement: "I can check whether Monday is
// confirmed", "once it is confirmed".
const CONDITIONAL = /\b(?:whether|if|once|unless|in case|until|when|after)\b/;

// A pronoun that refers back to the slot of the sentence before, and words
// that point to a different one.
const PRONOUN = /\b(?:it|it's|its|that one|this one|that appointment|this appointment|that time|this time|that visit|this visit|that slot|this slot)\b/;
const OTHER = /\b(?:other|another|different|new|second|first|earlier|later)\s+(?:appointment|time|slot|visit|one)\b/;

// Statuses of claims and replies.
const STATUS_WORDS: Array<{ re: RegExp; noun: RegExp; statuses: Status[] }> = [
  { re: /\baccepted\b/, noun: /\b(?:claims?|items?|evidence|facts?)\b/, statuses: ["claim:accepted"] },
  { re: /\brejected\b/, noun: /\b(?:claims?|items?|evidence|facts?|changes?)\b/, statuses: ["claim:rejected"] },
  { re: /\b(?:approved|sent)\b/, noun: /\b(?:repl(?:y|ies)|drafts?|answers?)\b/, statuses: ["reply:sent"] },
];

// "I accepted ..." or "we rejected ..." when the turn accepted or rejected
// a claim.
function ownReview(clause: string, done: ReadonlySet<string> = new Set()): boolean {
  const m = /\b(?:i|we)(?:'ve)?(?:\s+(?:have|just|also))*\s+(accepted|rejected)\b/.exec(clause);
  return m !== null && done.has(m[1] === "accepted" ? "claim_accepted" : "claim_rejected");
}

// A colon splits a clause only before a space, so "10:30" stays whole.
// SP12.1: an answer word at the start, set off by a dash, as in "No",
// a dash and "Monday is offered", is a clause of its own, so its "no" does
// not negate the rest.
const ANSWER_WORD = /^((?:no|nope|not yet|not quite|yes|yeah|yep)\b)\s*[—–-]+\s*/;
const clauses = (s: string) =>
  s
    .replace(ANSWER_WORD, "$1, ")
    .split(/[,;]|:\s|\b(?:and|but|while|whereas|so|although|though)\b/)
    .map((c) => c.trim())
    .filter(Boolean);

// The slots among the facts that the mentions name.
const names = (m: Mention, f: Fact) => hasDate(m) && dateMatches(m, f) && (m.times.length === 0 || (f.time !== null && m.times.includes(f.time)));
function slotsNamed(mentions: Mention[], facts: Fact[]): Fact[] {
  return facts.filter((f) => f.state !== undefined && mentions.some((m) => names(m, f)));
}

// Fix round 1, finding 4, and round 2, finding 5: the slots a mention
// without a time, or a weekday without a month and day, names when it names
// more than one. A state word must fit all of them or none.
function looseGroups(mentions: Mention[], facts: Fact[]): Array<Set<string>> {
  return mentions
    .filter((m) => hasDate(m) && (m.times.length === 0 || m.monthDay === null))
    .map((m) => new Set(facts.filter((f) => f.state !== undefined && names(m, f)).map((f) => `${f.date}T${f.time}`)))
    .filter((g) => g.size > 1);
}

// True when every state and status the text asserts agrees with the facts.
export function statesAgree(text: string, grounds: Grounds): boolean {
  const canonical = canonicalDates(text, grounds.today).text;
  const slots = grounds.facts.filter((f) => f.state !== undefined);
  const keyOf = (f: Fact) => `${f.date}T${f.time}`;
  // Each slot's app event as the turn's last event fact left it: undefined
  // when no fact this turn says, null when there is none.
  const events = new Map<string, Fact["event"]>();
  for (const f of grounds.facts) if (f.event !== undefined) events.set(keyOf(f), f.event);
  // Whether a word fits one slot fact, read as said of the slot's state or,
  // with `asEvent`, of its app event.
  const fitsWord = (w: StateWord, asEvent: boolean) => (f: Fact) => {
    if (asEvent) return events.get(keyOf(f)) === w.eventStatus;
    if (w.onCalendar && events.has(keyOf(f))) return events.get(keyOf(f)) !== null;
    return (
      w.states.includes(f.state!) || (w.moved === true && (f.state === "confirmed" || f.state === "requested") && slots.some((x) => x.state === "canceled"))
    );
  };
  // Each named slot once, fitting when one of its facts fits. Slots a loose
  // mention names together that fit differently make the word ambiguous.
  const verdicts = (named: Fact[], groups: Array<Set<string>>, fits: (f: Fact) => boolean) => {
    const fit = new Map<string, boolean>();
    for (const f of named) fit.set(keyOf(f), (fit.get(keyOf(f)) ?? false) || fits(f));
    const all = [...fit.values()];
    const mixed = groups.some((g) => new Set([...g].filter((k) => fit.has(k)).map((k) => fit.get(k))).size > 1);
    return { some: all.some(Boolean), every: all.every(Boolean), mixed };
  };
  let previous: Fact[] = [];
  let previousGroups: Array<Set<string>> = [];
  for (const s of sentences(canonical)) {
    const sentenceMentions = parseMentions(s);
    const sentenceSlots = slotsNamed(sentenceMentions, grounds.facts);
    const sentenceGroups = looseGroups(sentenceMentions, grounds.facts);
    // A question asserts nothing.
    if (s.endsWith("?")) {
      if (sentenceSlots.length > 0) [previous, previousGroups] = [sentenceSlots, sentenceGroups];
      continue;
    }
    const parts = clauses(s).map((c) => {
      const mentions = parseMentions(c);
      const clauseSlots = slotsNamed(mentions, grounds.facts);
      // The slot of the sentence before carries over only through a
      // pronoun, and never to "the other appointment" (finding 6).
      const carry = PRONOUN.test(c) && !OTHER.test(c);
      const [targets, groups] =
        clauseSlots.length > 0
          ? [clauseSlots, looseGroups(mentions, grounds.facts)]
          : sentenceSlots.length > 0 && !OTHER.test(c)
            ? [sentenceSlots, sentenceGroups]
            : carry
              ? [previous, previousGroups]
              : [[], []];
      return { c, mentions, clauseSlots, targets, groups };
    });
    // Fix round 2, finding 1: the event context is the sentence's. A clause
    // is about the event when it names one, or when its sentence does and
    // the clause names no slot but the ones the event clauses name.
    const eventParts = parts.filter((p) => EVENT_NOUN.test(p.c));
    const eventKeys = new Set(eventParts.flatMap((p) => p.targets.map(keyOf)));
    for (const { c, mentions, clauseSlots, targets, groups } of parts) {
      const aboutEvent = EVENT_NOUN.test(c) || (eventParts.length > 0 && clauseSlots.every((f) => eventKeys.has(keyOf(f))));
      // Review round 2, finding 4: a clause, or a sentence with no slot,
      // that names a date no slot among the facts has. A claim fact, such
      // as an agent's unconfirmed report, carries no state, so a positive
      // state word about that date fails, with no fallback to other slots.
      const datesNoSlot = (mentions.some(hasDate) && clauseSlots.length === 0) || (sentenceSlots.length === 0 && targets.length === 0 && sentenceMentions.some(hasDate));
      for (const w of STATE_WORDS) {
        for (const m of c.matchAll(w.re)) {
          const before = c.slice(0, m.index);
          if (CONDITIONAL.test(before)) continue;
          // "8 pending items" describes claims waiting for review, not a
          // slot (sprint 12, live run L2).
          if (CLAIM_NOUN_AFTER.test(c.slice(m.index! + m[0].length))) continue;
          // A calendar phrase other than "on the calendar" is read only of a
          // named slot with an event fact this turn.
          if (w.onCalendar && m[0] !== "on the calendar" && !targets.some((f) => events.has(keyOf(f)))) continue;
          const n = negations(before);
          // Finding 5: two negations read either way, so they fail closed.
          if (n > 1) return false;
          const negated = (n === 1) !== (w.onCalendar === true && REMOVAL_BEFORE.test(before));
          if (datesNoSlot && !negated) return false;
          if (w.namedOnly && clauseSlots.length === 0) continue;
          const named = w.namedOnly ? clauseSlots : targets;
          // Said of the calendar or an event: the event's status. A negated
          // word about a slot no event fact covers is read of the slot.
          const asEvent = w.eventStatus !== undefined && aboutEvent && (!negated || named.some((f) => events.has(keyOf(f))));
          const fits = fitsWord(w, asEvent);
          if (named.length > 0) {
            // A positive state needs a named slot in it. A negated one needs
            // a named slot outside it.
            const v = verdicts(named, w.namedOnly ? looseGroups(mentions, grounds.facts) : groups, fits);
            if (v.mixed || (negated ? v.every : !v.some)) return false;
          } else if (asEvent) {
            if (!negated && !slots.some(fits)) return false;
          } else if (negated ? slots.length === 0 && grounds.scheduleRead !== true : !slots.some(fits)) {
            return false;
          }
        }
      }
      // A status word code cannot map, said of a slot, fails closed. A
      // status of claims or replies is checked below instead, and so is the
      // agent's own report of a review it did in this turn ("I accepted the
      // offer for Tuesday"), which the action-claim check holds to the
      // activity log.
      const unmapped = c.match(UNMAPPED_STATUS);
      if (
        unmapped &&
        targets.length > 0 &&
        !STATUS_WORDS.some((w) => w.noun.test(c)) &&
        !CONDITIONAL.test(c.slice(0, unmapped.index)) &&
        !ownReview(c, grounds.done)
      ) {
        return false;
      }
      for (const w of STATUS_WORDS) {
        const at = c.search(w.re);
        if (at === -1 || !w.noun.test(c)) continue;
        if (CONDITIONAL.test(c.slice(0, at))) continue;
        if (negations(c.slice(0, at)) === 0 && !w.statuses.some((x) => grounds.statuses.has(x))) return false;
      }
    }
    if (sentenceSlots.length > 0) [previous, previousGroups] = [sentenceSlots, sentenceGroups];
  }
  return true;
}

// A first-person claim that the assistant did something. "We" counts, as
// the assistant speaking for the app. Each verb names the activity kinds
// that make it true. A verb with none is never true, because no tool does
// it: only the person approves (sends) a reply, and a slot is confirmed,
// canceled or moved only by the office's message or the person's report.
const SUBJECT = String.raw`\b(?:i|we)(?:'ve|'d)?`;
const HELPERS = String.raw`(?:\s+(?:have|has|had|just|already|now|also|successfully|went ahead and|gone ahead and))*`;
const ANY_ACTION = "*";
const VERBS: Array<{ past: string; base: string; kinds: string[] }> = [
  { past: "accepted", base: "accept", kinds: ["claim_accepted"] },
  { past: "rejected", base: "reject", kinds: ["claim_rejected"] },
  { past: "answered", base: "answer", kinds: ["question_answered"] },
  { past: "archived", base: "archive", kinds: ["appointment_archived"] },
  { past: "unarchived|restored", base: "unarchive|restore", kinds: ["appointment_unarchived", "undo"] },
  { past: "discarded", base: "discard", kinds: ["draft_discarded"] },
  { past: "undid|undone|reversed", base: "undo|reverse", kinds: ["undo"] },
  // A message from Gmail is an import too (0012).
  { past: "imported", base: "import", kinds: ["message_imported", "gmail_message_imported"] },
  { past: "tagged", base: "tag", kinds: ["tags_set"] },
  // Adding to a calendar, a message, a note or a tag, or starting a draft
  // (review round 3, finding 9).
  {
    past: "added|created",
    base: "add|create",
    kinds: ["calendar_event_added", "message_imported", "gmail_message_imported", "note_added", "tags_set", "draft_started"],
  },
  // "I put it on your calendar" is an add, and "I put the event back" after
  // an undo is the undo (review round 4, item 7).
  { past: "put", base: "put", kinds: ["calendar_event_added", "undo"] },
  { past: "removed", base: "remove", kinds: ["appointment_archived", "draft_discarded", "undo", "calendar_event_removed"] },
  { past: "changed|updated", base: "change|update", kinds: [ANY_ACTION] },
  { past: "approved|sent|submitted|confirmed|canceled|cancelled|declined|booked|rescheduled|moved|deleted", base: "approve|send|submit|confirm|cancel|decline|book|reschedule|move|delete", kinds: [] },
];
const VERB_RES = VERBS.map((v) => ({
  re: new RegExp(`${SUBJECT}${HELPERS}\\s+(?:(${v.past})\\b|did\\s+(?:${v.base})\\b)`, "g"),
  kinds: v.kinds,
}));

// Sprint 20 (0022): the live model often drops the subject, as in "Added
// Monday 11/16 1:00 PM to your calendar as tentative." or "Put Monday 11/16
// 1:00 PM back on your calendar." A sentence that opens with the past form of
// a verb some action makes true, after "just", "now", "successfully",
// "also" or "then" too, is the assistant's own report, and so is each verb
// joined to it by "and", "then" or a comma. Verbs no tool does do not open
// one, because "Confirmed: Thursday 11/12 10:30 AM." states a slot's state.
// Fix round 1, finding 5: the passive "was added", "were removed" or "has
// been put back" reports an action too, unless the sentence says it was
// earlier. A sentence that names another actor ("by the office"), asks, or
// suggests what the person can do reports nothing.
const LEAD = String.raw`(?:(?:just|now|successfully|also|then|already)\s+)*`;
const ACTING = VERBS.filter((v) => v.kinds.length > 0);
// Fix round 2, finding 4: "The app" or "the assistant" opening a sentence
// speaks for the assistant too. Inside a sentence, as in "the event the app
// added", it names an earlier action.
const OPENING_RE = new RegExp(`^(?:(?:the app|this app|the assistant)\\s+(?:(?:has|have)\\s+)?)?${LEAD}(${ACTING.map((v) => v.past).join("|")})\\b`);
const JOINED_VERB_RE = new RegExp(`(?:,\\s*(?:and\\s+)?|\\b(?:and|then)\\s+)${LEAD}(${VERBS.map((v) => v.past).join("|")})\\b`, "g");
const PASSIVE_RE = new RegExp(`\\b(?:was|were|is|are|gets?|got|(?:has|have|had) been)\\s+${LEAD}(${ACTING.map((v) => v.past).join("|")})\\b`, "g");
// "By" and a name or role, not a time ("by Monday", "by then").
const OTHER_ACTOR =
  /\bby (?!(?:the )?(?:time|end|then|now|today|tomorrow|tonight|noon|midnight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|activity)\b|\d)(?:dr\.?\s+|the |your |an? )?[a-z]/;
const SUGGESTION = /\b(?:if you|when you|you can|you could|you may|please|want me to|would you like|let me know|yourself)\b/;
const IN_GOOGLE = /^\s+in (?:your )?google calendar\b/;
// Fix round 2, finding 4: "already" and "before" alone do not say when.
const EARLIER = /\b(?:earlier|previously|last time|in (?:an|the) earlier)\b/;
// The clause of `s` around `at`, between commas, semicolons or "but".
function clauseAt(s: string, at: number): string {
  const start = Math.max(s.lastIndexOf(",", at - 1), s.lastIndexOf(";", at - 1), s.lastIndexOf(" but ", at - 1)) + 1;
  const ends = [",", ";", " but "].map((x) => s.indexOf(x, at)).filter((i) => i !== -1);
  return s.slice(start, ends.length > 0 ? Math.min(...ends) : s.length);
}
const kindsOf = (verb: string) => VERBS.find((v) => new RegExp(`^(?:${v.past})$`).test(verb))!.kinds;

function subjectlessReport(t: string, untrue: (kinds: string[]) => boolean): boolean {
  for (const raw of t.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim().replace(/^[-*•]\s*/, "");
    if (s === "" || s.endsWith("?")) continue;
    // Fix round 2, finding 4: another actor or a suggestion excuses only
    // the clause it is in.
    const excused = (at: number) => {
      const c = clauseAt(s, at);
      return OTHER_ACTOR.test(c) || SUGGESTION.test(c);
    };
    const verbs: string[] = [];
    const open = OPENING_RE.exec(s);
    if (open) {
      if (!excused(0)) verbs.push(open[1]!);
      const rest = s.slice(open[0].length);
      for (const m of rest.matchAll(JOINED_VERB_RE)) {
        if (otherSubjectGoverns(open[1]!, rest.slice(0, m.index))) continue;
        if (m[1] === "confirmed" && CHECKED.test(rest.slice(m.index! + m[0].length))) continue;
        if (!excused(open[0].length + m.index! + m[0].length - 1)) verbs.push(m[1]!);
      }
    }
    // "Removed in Google Calendar" is the person's own removal there, which
    // calendar_sync_slot reports (0018, H6). The app removes "from" it.
    if (!EARLIER.test(s))
      for (const m of s.matchAll(PASSIVE_RE))
        if (!(m[1] === "removed" && IN_GOOGLE.test(s.slice(m.index! + m[0].length))) && !excused(m.index! + m[0].length - 1)) verbs.push(m[1]!);
    if (verbs.some((v) => untrue(kindsOf(v)))) return true;
  }
  return false;
}

// A verb joined by "and" to the assistant's own verb in the same sentence,
// as in "I saved your message and confirmed Monday" or "... and have
// confirmed Monday" (the live meaning-flips run, Muse round 2, item 4).
// Another subject with its own verb between them excuses the second verb
// only when it governs it: "I see the office confirmed Monday and canceled
// Thursday" is the office's doing, but in "I saved the note that you sent
// and confirmed Monday" the subject sits in a relative clause and the
// confirmation is the assistant's.
const OTHER_SUBJECT = /\b(?:that|which|who|they|it|he|she|you|office|clinic|desk|doctor|they've|it's)\s+(?:has\s+|have\s+|had\s+|just\s+|already\s+)*[a-z]+(?:ed|t)\b/g;
const JOINED_RES = VERBS.map((v) => ({
  re: new RegExp(`${SUBJECT}${HELPERS}\\s+([a-z']+)\\b([^.!?;]*?)\\band\\s+(?:also\\s+|then\\s+)?(?:(?:have|has|had)\\s+(?:also\\s+)?)?(${v.past})\\b`, "g"),
  kinds: v.kinds,
}));
// Verbs after which "that" opens what was seen or said, not a relative
// clause: "I see that the office confirmed ...".
const REPORTING = /^(?:see|saw|seen|noticed|read|say|said|says|shows|showed|think|know|knew|found|noted|checked|hear|heard)$/;

// True when an other subject in `between` governs the verb after "and".
// `verb` is the assistant's first verb, before `between`.
function otherSubjectGoverns(verb: string, between: string): boolean {
  for (const m of between.matchAll(OTHER_SUBJECT)) {
    const before = between.slice(0, m.index);
    const opens = /^(?:that|which|who)\b/.test(m[0]) ? before : /\b(?:that|which|who)\s+(?:the\s+|your\s+|our\s+|their\s+)?$/.exec(before) ? before.replace(/\b(?:that|which|who)\s+(?:the\s+|your\s+|our\s+|their\s+)?$/, "") : null;
    // No relative pronoun: the subject governs what follows.
    if (opens === null) return true;
    // "that" right after a reporting verb opens what was seen, so its
    // subject governs. After a noun it opens a relative clause.
    const word = /([a-z']+)\s*$/.exec(opens)?.[1] ?? verb;
    if (REPORTING.test(word)) return true;
  }
  return false;
}

// "confirmed that ..." or "confirmed the time is ..." checks what the case
// says, so it claims no action (Muse round 2, item 4).
const CHECKED = /^\s+(?:that\b|the (?:time|date|day|place|location) (?:is|was)\b)/;

// True when the text claims the assistant did something the turn's
// actions do not show. `done` holds the kinds of this turn's entries.
export function claimsAction(text: string, done: ReadonlySet<string> = new Set()): boolean {
  const t = normalizeForScope(text).toLowerCase().replace(/[’‘]/g, "'");
  const untrue = (kinds: string[]) => !kinds.some((k) => (k === ANY_ACTION ? done.size > 0 : done.has(k)));
  const checked = (verb: string | undefined, end: number) => verb === "confirmed" && CHECKED.test(t.slice(end));
  const direct = VERB_RES.some(({ re, kinds }) => [...t.matchAll(re)].some((m) => !checked(m[1], m.index! + m[0].length) && untrue(kinds)));
  if (direct) return true;
  if (subjectlessReport(t, untrue)) return true;
  return JOINED_RES.some(({ re, kinds }) =>
    [...t.matchAll(re)].some((m) => !otherSubjectGoverns(m[1]!, m[2] ?? "") && !checked(m[3], m.index! + m[0].length) && untrue(kinds)),
  );
}

export function checkAnswer(text: string, grounds: Grounds): TextProblem[] {
  const normalized = normalizeForScope(text);
  if (normalized.trim() === "") return ["empty"];
  const problems: TextProblem[] = [];
  if (hasClinicalContent(text)) problems.push("clinical_content");
  if (!grounded(text, grounds.facts, grounds.today) || !titlesAgree(text, grounds.facts, grounds.today) || text.length > MAX_ANSWER_CHARS) problems.push("ungrounded");
  if (!statesAgree(text, grounds)) problems.push("state_mismatch");
  if (claimsAction(text, grounds.done)) problems.push("claims_action");
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
