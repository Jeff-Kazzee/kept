// Verbatim quote check. A quote passes only when it appears word for word in
// the source text and starts and ends on word boundaries, so a fragment such
// as "uesda" from "Tuesday" fails. Runs of whitespace count as one space.
// Nothing else is normalized: case, punctuation and quote marks must match.

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const WORD = /[\p{L}\p{N}]/u;

export function quoteAppearsIn(quote: string, source: string): boolean {
  const q = normalizeWhitespace(quote);
  if (q.length === 0) return false;
  const text = normalizeWhitespace(source);
  const needsStart = WORD.test(q[0]!);
  const needsEnd = WORD.test(q.at(-1)!);
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) {
    const before = i > 0 ? text[i - 1]! : "";
    const after = text[i + q.length] ?? "";
    if (needsStart && before && WORD.test(before)) continue;
    if (needsEnd && after && WORD.test(after)) continue;
    return true;
  }
  return false;
}

// Lowercase words, with punctuation treated as a break.
export function words(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// True when `phrase` appears in `source` as a whole run of words, ignoring
// case and punctuation. "Elm Street office" is in "at our Elm Street office."
export function phraseAppearsIn(phrase: string, source: string): boolean {
  const p = words(phrase);
  if (p.length === 0) return false;
  return ` ${words(source).join(" ")} `.includes(` ${p.join(" ")} `);
}

const FILLER = new Set(["a", "an", "the", "your", "my", "please", "to", "of", "and", "you", "for"]);

// True when every word of `item`, other than filler words, appears in
// `source`. "Bring new insurance card" is supported by "Please bring your
// new insurance card". "bring a passport" is not.
export function wordsAppearIn(item: string, source: string): boolean {
  const content = words(item).filter((w) => !FILLER.has(w));
  if (content.length === 0) return false;
  const available = new Set(words(source));
  return content.every((w) => available.has(w));
}
