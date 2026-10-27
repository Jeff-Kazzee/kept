// Shapes of the slot projection. Shared by the server and the UI, so this
// file must not import Node modules.
import type { SlotState, SourceType } from "../domain/claim.ts";
import type { IcsTime } from "../domain/ics.ts";
import type { TemplateId } from "../reply/templates.ts";

// What one accepted evidence item says about a slot. A reminder says the
// slot is held, so it asserts confirmed.
export type SlotStatus = "offered" | "requested" | "confirmed" | "canceled" | "declined";

export type ClashView = {
  uid: string | null;
  summary: string;
  start: IcsTime;
  end: IcsTime | null;
  recurring: boolean;
};

export type SlotView = {
  key: string;
  date: string;
  time: string | null;
  label: string;
  state: SlotState;
  // For example "Confirmed · office message, change proposed".
  stateLabel: string;
  // The evidence item that set the state, and its source.
  stateEvidenceId: string;
  sourceType: SourceType;
  sourceLabel: string;
  location: string | null;
  // True when accepted evidence gives the slot places that do not agree.
  locationDisputed: boolean;
  // Details a held slot lacks. Empty for slots that are not held.
  missing: Array<"time" | "location">;
  // Every accepted evidence item placed on this slot.
  evidenceIds: string[];
  // Evidence that proposes a change to this slot. Empty unless the state
  // is change_proposed.
  proposalEvidenceIds: string[];
  // Automated reminders for this slot marked possibly stale (rule 6).
  staleEvidenceIds: string[];
  // Null when no calendar is loaded or the slot has no time.
  clashes: ClashView[] | null;
};

export type ConflictKind =
  | "both_held"
  | "change_proposed"
  | "unknown_order"
  | "ambiguous_date"
  | "possibly_stale"
  | "location_mismatch"
  | "incomplete_slot";

// The order in which the app asks about conflicts when the model does not
// pick one.
export const CONFLICT_PRIORITY: ConflictKind[] = [
  "both_held",
  "change_proposed",
  "unknown_order",
  "ambiguous_date",
  "possibly_stale",
  "location_mismatch",
  "incomplete_slot",
];

// A claim that an answer records as user-reported evidence. `clarifies`
// names the evidence item whose date or time the answer resolves.
export type ChoiceEffect = {
  claim_type: "offer" | "request" | "confirm" | "cancel" | "decline" | "clarify";
  date: string;
  time: string | null;
  location: string | null;
  clarifies: string | null;
};

// An answer choice. Code builds every choice from the conflict. `settles`
// lists evidence with an unknown event time that the answer replaces, so it
// no longer raises a conflict. `draft` names the reply the choice starts.
// A choice that starts a reply records no claim, because the slot changes
// only when the user approves the reply (W30).
export type Choice = {
  id: string;
  label: string;
  effects: ChoiceEffect[];
  settles: string[];
  draft?: { template: TemplateId; slotKey: string };
};

export type Conflict = {
  id: string;
  kind: ConflictKind;
  slotKeys: string[];
  // The sources that disagree, or the single source of a missing detail.
  evidenceIds: string[];
  // Code-written description, shown when no explanation is available.
  summary: string;
  // Fixed question wording, used when the model's proposal is invalid.
  fixedQuestion: string;
  choices: Choice[];
  // False when no choice would change anything, so the app does not ask.
  askable: boolean;
};

export type Projection = {
  slots: SlotView[];
  conflicts: Conflict[];
  staleEvidenceIds: string[];
};
