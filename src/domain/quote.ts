// Verbatim quote check. A quote passes only when it appears word for word in
// the source text. Runs of whitespace count as one space. Nothing else is
// normalized: case, punctuation and quote marks must match.

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function quoteAppearsIn(quote: string, source: string): boolean {
  const q = normalizeWhitespace(quote);
  if (q.length === 0) return false;
  return normalizeWhitespace(source).includes(q);
}
