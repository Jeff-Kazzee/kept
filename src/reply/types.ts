// Shapes of the reply view sent to the UI. Shared by the server and the UI,
// so this file must not import Node modules.
import type { AttemptSummary } from "../case/types.ts";
import type { FieldName, TemplateId } from "./templates.ts";

// Where a field value came from. `slot` is the projected slot, `evidence`
// one accepted evidence item, `case` the case profile.
export type FieldSource = { kind: "slot" | "evidence" | "case"; evidenceId: string | null; text: string };

export type FieldView = {
  name: FieldName;
  label: string;
  // The value code checks: an ISO date, a 24-hour time, a place, a name or
  // a list of slot keys. Null when the case has no value.
  value: string | null;
  // The words the reply text uses for the value.
  display: string | null;
  sources: FieldSource[];
};

export type ReplyOption = { template: TemplateId; title: string; slotKey: string; slotLabel: string };

// A template the slot's state allows that is not offered because the slot
// lacks a field the template needs (S7).
export type WithheldOption = ReplyOption & { missing: FieldName[] };

export type DraftOrigin = "choice" | "model" | "manual";

export type DraftView = {
  id: string;
  template: TemplateId;
  title: string;
  asserts: string;
  slotKey: string;
  slotLabel: string;
  // choice: the user tapped a choice in a question. model: the model picked
  // the template and slot and code checked it. manual: the user picked them.
  origin: DraftOrigin;
  questionId: string | null;
  suggestionId: string | null;
  fields: FieldView[];
  renderedText: string;
  // The text approval sends. Equal to renderedText unless the user edited it.
  text: string;
  // True once the user edited the text. It stays true until the draft is
  // discarded, even if the text is changed back.
  edited: boolean;
  // Set when the text differs from the code render and the template records
  // a claim. Approval records the claim only if the user confirms this
  // statement. Null otherwise.
  claimConfirmation: string | null;
  // False when the case changed so that the template or a field no longer
  // matches. Approval is refused until a new draft is made.
  valid: boolean;
  problems: string[];
  // Plain words for why a draft that is not valid no longer fits. Null for
  // a valid draft.
  invalidNotice: string | null;
  createdAt: string;
};

export type SuggestionView = {
  id: string;
  intent: string | null;
  // no_fit: the model answered that no template fits the note.
  // manual_needed: the model output failed the code checks twice.
  outcome: "valid" | "no_fit" | "manual_needed";
  template: TemplateId | null;
  slotKey: string | null;
  // time_not_offered or template_not_allowed, set for a no-fit answer.
  noFitReason: "time_not_offered" | "template_not_allowed" | null;
  model: string;
  effort: string;
  attempts: AttemptSummary[];
  // The parsed model output of each attempt, kept for display even when it
  // failed. Null when the output was not JSON or did not match the schema.
  outputs: unknown[];
  // Set when the model's pick passed the checks but the case changed during
  // the call so that it no longer fits. The problems against the new case.
  caseChanged: string[];
  recordedAt: string;
};

export type SentView = {
  draftId: string;
  template: TemplateId;
  title: string;
  slotKey: string;
  slotLabel: string;
  text: string;
  edited: boolean;
  // Evidence items the approval recorded.
  evidenceIds: string[];
  // recorded, none (the template records no claim), or not_confirmed (the
  // text was edited and the user did not confirm what it asserts).
  claims: "recorded" | "none" | "not_confirmed";
  approvedAt: string;
  // Always true. Nothing leaves the app.
  simulated: true;
};

export type ReplyView = {
  version: number;
  options: ReplyOption[];
  withheld: WithheldOption[];
  draft: DraftView | null;
  suggestion: SuggestionView | null;
  sent: SentView[];
};
