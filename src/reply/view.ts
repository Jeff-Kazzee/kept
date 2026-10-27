// Builds the reply view from the reply log and the current case. A stored
// draft is checked again against the case each time, so a draft whose
// template or fields no longer match is shown as not valid and cannot be
// approved.
import { buildDraft, replyOptions, sameFields, type ReplyContext } from "./draft.ts";
import { openDraft, type DraftRecord, type ReplyLog } from "./events.ts";
import { TEMPLATES } from "./templates.ts";
import type { DraftView, ReplyView, SentView, SuggestionView } from "./types.ts";

export function draftValidity(draft: DraftRecord, ctx: ReplyContext): { valid: boolean; problems: string[] } {
  const rebuilt = buildDraft(draft.template, draft.slotKey, ctx);
  if (!rebuilt.ok) return { valid: false, problems: rebuilt.problems };
  const same = sameFields(rebuilt.content.fields, draft.fields) && rebuilt.content.declines.join(",") === draft.declines.join(",");
  return same ? { valid: true, problems: [] } : { valid: false, problems: ["case_changed"] };
}

// The claims approval would record for the draft, built by code from the
// template. Empty for a template that records none.
export function draftClaims(draft: DraftRecord): Array<{ type: "request" | "decline"; slotKey: string }> {
  switch (TEMPLATES[draft.template].records) {
    case "request":
      return [{ type: "request", slotKey: draft.slotKey }];
    case "decline":
      return [{ type: "decline", slotKey: draft.slotKey }];
    case "decline_alternatives":
      return draft.declines.map((slotKey) => ({ type: "decline", slotKey }));
    case null:
      return [];
  }
}

// When the text was edited away from the code render, approval records the
// template's claims only if the user ticks this statement. Null when the
// text is the code render or the template records no claim.
export function claimConfirmation(draft: DraftRecord): string | null {
  if (draft.text === draft.renderedText || draftClaims(draft).length === 0) return null;
  const declined = draft.fields.find((f) => f.name === "declined_slots")?.display;
  switch (TEMPLATES[draft.template].records) {
    case "request":
      return `This reply still requests ${draft.slotLabel}`;
    case "decline":
      return `This reply still declines ${draft.slotLabel}`;
    default:
      return `This reply still keeps ${draft.slotLabel} and declines ${declined}`;
  }
}

function draftView(d: DraftRecord, ctx: ReplyContext): DraftView {
  const def = TEMPLATES[d.template];
  return {
    id: d.id,
    template: d.template,
    title: def.title,
    asserts: def.asserts,
    slotKey: d.slotKey,
    slotLabel: d.slotLabel,
    origin: d.origin,
    questionId: d.questionId,
    suggestionId: d.suggestionId,
    fields: d.fields,
    renderedText: d.renderedText,
    text: d.text,
    edited: d.edited,
    claimConfirmation: claimConfirmation(d),
    ...draftValidity(d, ctx),
    createdAt: d.createdAt,
  };
}

export function replyView(log: ReplyLog, ctx: ReplyContext): ReplyView {
  const open = openDraft(log);
  const last = log.suggestions.at(-1);
  const suggestion: SuggestionView | null = last
    ? {
        id: last.suggestion_id,
        intent: last.intent,
        outcome: last.outcome,
        template: last.template,
        slotKey: last.slot_key,
        model: last.attempts[0]?.model ?? "",
        effort: last.attempts[0]?.effort ?? "",
        attempts: last.attempts.map((a) => ({ attempt: a.attempt, outcome: a.outcome, problems: a.problems, detail: a.detail, latency_ms: a.latency_ms })),
        outputs: last.attempts.map((a) => a.output),
        caseChanged: last.case_changed ?? [],
        recordedAt: last.recordedAt,
      }
    : null;
  const sent: SentView[] = log.drafts
    .filter((d) => d.status === "approved" && d.approval?.sent)
    .map((d) => ({
      draftId: d.id,
      template: d.template,
      title: TEMPLATES[d.template].title,
      slotKey: d.slotKey,
      slotLabel: d.slotLabel,
      text: d.approval!.text,
      edited: d.approval!.edited,
      evidenceIds: d.approval!.evidenceIds,
      claims: d.approval!.claims,
      approvedAt: d.approval!.approvedAt,
      simulated: true,
    }));
  return { version: log.version, ...replyOptions(ctx), draft: open ? draftView(open, ctx) : null, suggestion, sent };
}
