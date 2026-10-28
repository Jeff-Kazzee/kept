// The checklist: what the office asked the user to bring or do. Built by
// code from accepted office_request evidence only, so a request the user
// rejected in review never shows. Each item keeps the verbatim quote and the
// source label of every piece of evidence behind it. Items are not model
// output and carry no model label. They have no done state in this sprint.
// Runs in the browser and in Node, so it must not import Node modules.
import type { EvidenceClaim } from "../domain/claim.ts";
import { normalizeForScope } from "../domain/scope.ts";
import { sourceLabel } from "../slots/labels.ts";

// The part of an evidence view the checklist reads.
type Evidence = { id: string; status: "pending" | "accepted" | "rejected"; claim: EvidenceClaim };

export type ChecklistSource = {
  evidenceId: string;
  // Null for a manual entry made without a quote.
  quote: string | null;
  // "office message", "reported by you" or "reported by you through <grant name>".
  sourceLabel: string;
};

export type ChecklistItem = {
  // The request in the words of its first source.
  text: string;
  sources: ChecklistSource[];
};

// Two requests are one item when they say the same thing in the same words.
// Case, spacing, compatibility forms and punctuation at either end (marks,
// quotes, brackets) do not count as different words.
export function requestKey(text: string): string {
  return normalizeForScope(text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
}

export function buildChecklist(evidence: Evidence[]): ChecklistItem[] {
  const items = new Map<string, ChecklistItem>();
  for (const e of evidence) {
    const c = e.claim;
    if (e.status !== "accepted" || c.claim_type !== "office_request" || !c.request_item) continue;
    const key = requestKey(c.request_item);
    if (key === "") continue;
    const source: ChecklistSource = { evidenceId: e.id, quote: c.quote, sourceLabel: sourceLabel(c.source_type, c.agent_name ?? null) };
    const item = items.get(key);
    if (item) item.sources.push(source);
    else items.set(key, { text: c.request_item.trim(), sources: [source] });
  }
  return [...items.values()];
}
