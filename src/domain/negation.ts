// A claim from a sentence that says the opposite (sprint 12, the live
// meaning-flips run). "Your Monday 11/16 1:00 PM visit is not confirmed
// yet." once gave a confirm claim whose quote was the sentence or the part
// before "is not confirmed", and accepting it held the slot. A confirm,
// cancel, offer or move claim fails when its context negates its own state
// word. Its context is each clause of the message that holds the quote,
// and a sentence or line right after that starts with "it", "this" or
// "that", which speaks of the same visit. A clause ends at a comma, a
// semicolon, a colon before a space, or a contrast word, so "Your visit is
// not canceled, it is confirmed" confirms. Inside a clause a negation
// governs a state word anywhere after it ("not at this time in any way
// confirmed", "no confirmation", "yet to be confirmed"), and "no longer"
// or "anymore" after it ("confirmed no longer"). Idioms such as "cannot
// wait" are not negations. When unsure it fails: the person can still
// enter the claim by hand (Muse round 2, items 1 and 2).
import { normalizeWhitespace } from "./quote.ts";
import type { ClaimType } from "./claim.ts";

const STATE_WORDS: Partial<Record<ClaimType, string>> = {
  confirm: String.raw`(?:confirm\w*|booked|scheduled)`,
  cancel: String.raw`(?:cancel\w*|called off)`,
  offer: String.raw`(?:offer\w*|available|open)`,
  move: String.raw`(?:mov(?:e|ed|ing)|reschedul\w*)`,
};

const NEGATION_BEFORE = /\b(?:not|never|no|none|without|cannot|unable to|yet to be|\w+n't)\b/gi;
const NEGATION_AFTER = /\b(?:no longer|anymore)\b/i;
const IDIOMS =
  /\b(?:can(?:not|'t) wait|no problem|no worries|not a problem|never mind|no doubt|without delay|no need to (?:reply|call|respond|worry|bring|do))\b/gi;
const CLAUSE_END = /[,;]|:\s|\b(?:but|however|though|although|whereas|while|instead|rather)\b/gi;
const PRONOUN_START = /^(?:it|it's|this|that)\b/i;

type Span = { text: string; start: number; end: number };

// The sentences of one line, with where they sit. A sentence ends at ., !
// or ? before a space and a capital letter, so "1:00 p.m. visit" stays one.
function sentences(line: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  for (const m of [...line.matchAll(/(?<=[.!?])\s+(?=\p{Lu})/gu), { index: line.length, 0: "" }]) {
    out.push({ text: line.slice(start, m.index!), start, end: m.index! });
    start = m.index! + m[0]!.length;
  }
  return out;
}

function clauses(sentence: Span): Span[] {
  const out: Span[] = [];
  let start = 0;
  for (const m of [...sentence.text.matchAll(CLAUSE_END), { index: sentence.text.length, 0: "" }]) {
    out.push({ text: sentence.text.slice(start, m.index!), start: sentence.start + start, end: sentence.start + m.index! });
    start = m.index! + m[0]!.length;
  }
  return out;
}

// The clauses the quote's claim is read in.
export function claimContext(quote: string, text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split(/\n+/).map(normalizeWhitespace).filter(Boolean);
  const q = normalizeWhitespace(quote);
  const out: string[] = [];
  lines.forEach((line, li) => {
    const at = line.indexOf(q);
    if (at === -1) return;
    const parts = sentences(line);
    const overlaps = (s: Span) => s.start < at + q.length && s.end > at;
    parts.forEach((s, si) => {
      if (!overlaps(s)) return;
      for (const c of clauses(s)) if (overlaps(c)) out.push(c.text);
      // The sentence right after, on this line or the first of the next,
      // when it starts with a pronoun for the same visit and the quote
      // does not reach into it.
      const next = si + 1 < parts.length ? parts[si + 1] : lines[li + 1] ? sentences(lines[li + 1]!)[0] : undefined;
      const sameLine = si + 1 < parts.length;
      if (next && PRONOUN_START.test(next.text) && !(sameLine && overlaps(next))) out.push(...clauses(next).map((c) => c.text));
    });
  });
  return out;
}

function negates(clause: string, word: string): boolean {
  const c = clause.replace(IDIOMS, " ");
  if (new RegExp(String.raw`\bun${word}\b`, "i").test(c)) return true;
  const states = [...c.matchAll(new RegExp(String.raw`\b${word}\b`, "gi"))].map((m) => m.index!);
  if (states.length === 0) return false;
  const firstNegation = [...c.matchAll(NEGATION_BEFORE)][0]?.index;
  if (firstNegation !== undefined && states.some((s) => s > firstNegation)) return true;
  return NEGATION_AFTER.test(c.slice(states[0]!));
}

export function negatedInMessage(claimType: ClaimType, quote: string | null, text: string): boolean {
  const word = STATE_WORDS[claimType];
  if (!word || quote === null) return false;
  const plain = (x: string) => x.replace(/[’‘]/g, "'");
  return claimContext(plain(quote), plain(text)).some((c) => negates(c, word));
}
