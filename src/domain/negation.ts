// A claim from a sentence that says the opposite (sprint 12, the live
// meaning-flips run). "Your Monday 11/16 1:00 PM visit is not confirmed
// yet." once gave a confirm claim whose quote was the sentence or the part
// before "is not confirmed", and accepting it held the slot. Code reads the
// whole sentence of the message that holds the quote, so a quote that
// leaves the negation out is caught too. A confirm, cancel, offer or move
// claim fails when that sentence negates its own state word. It errs toward
// failing: the person can still enter the claim by hand.
import { normalizeWhitespace } from "./quote.ts";
import type { ClaimType } from "./claim.ts";

const STATE_WORDS: Partial<Record<ClaimType, string>> = {
  confirm: String.raw`(?:confirm\w*|booked|scheduled)`,
  cancel: String.raw`(?:cancel\w*|called off)`,
  offer: String.raw`(?:offer\w*|available|open)`,
  move: String.raw`(?:mov(?:e|ed|ing)|reschedul\w*)`,
};

const NEGATION = String.raw`(?:not|never|no longer|cannot|unable to|\w+n't)`;

const negatedRes = Object.fromEntries(
  Object.entries(STATE_WORDS).map(([type, word]) => [
    type,
    // A negation, then at most three words, then the state word. Or the
    // state word with a negating prefix, such as "unconfirmed".
    new RegExp(String.raw`\b${NEGATION}\b(?:[\s,]+[\w']+){0,3}?[\s,]+${word}\b|\bun${word}\b`, "i"),
  ]),
) as Partial<Record<ClaimType, RegExp>>;

// The sentences of `text` that the quote overlaps, after whitespace is
// normalized. A line break ends a sentence too.
export function sentencesHolding(quote: string, text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split(/\n+/).map(normalizeWhitespace).filter(Boolean);
  const q = normalizeWhitespace(quote);
  const out: string[] = [];
  for (const line of lines) {
    const at = line.indexOf(q);
    if (at === -1) continue;
    // A sentence ends at ., ! or ? before a space and a capital letter, so
    // "1:00 p.m. visit" stays one sentence.
    let start = 0;
    for (const m of [...line.matchAll(/(?<=[.!?])\s+(?=\p{Lu})/gu), { index: line.length, 0: "" }]) {
      const end = m.index!;
      if (start < at + q.length && end > at) out.push(line.slice(start, end));
      start = end + m[0]!.length;
    }
  }
  return out;
}

export function negatedInMessage(claimType: ClaimType, quote: string | null, text: string): boolean {
  const re = negatedRes[claimType];
  if (!re || quote === null) return false;
  const plain = (x: string) => x.replace(/[’‘]/g, "'");
  return sentencesHolding(plain(quote), plain(text)).some((s) => re.test(s));
}
