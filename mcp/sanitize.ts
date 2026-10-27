// Output sanitizing. Every string a tool returns passes through here, so no
// control character or hidden direction mark reaches the agent. Text from
// imported messages and from agents is returned only inside labeled fields
// (untrusted_quote, untrusted_text), never as a bare string.
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

export function cleanText(s: string): string {
  return s.replace(HIDDEN, "");
}

export function sanitize<T>(value: T): T {
  if (typeof value === "string") return cleanText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitize(v)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)])) as T;
  }
  return value;
}

export const untrustedQuote = (quote: string, evidenceId: string) => ({ untrusted_quote: quote, evidence_id: evidenceId });
export const untrustedText = (text: string) => ({ untrusted_text: text });
