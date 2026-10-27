// Reply templates. Each template fixes what the reply asserts, so neither
// the model nor a field value can flip its meaning. A template renders only
// for a slot in a state its row allows, and only when the slot has every
// field the template needs. Runs in the browser and in Node, so it must not
// import Node modules. docs/decisions/0003-reply-templates.md holds the
// reasoning.
import type { SlotState } from "../domain/claim.ts";

export const TEMPLATE_IDS = ["accept_offer", "decline_offer", "ask_still_stands", "keep_original"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

// Labels the UI shows. Kept here so the server, the UI and the tests use
// the same words.
export const EDITED_LABEL = "Edited by you. Not checked.";
export const SIMULATED_SEND_LABEL = "Simulated. Nothing was sent.";
// Why an open draft no longer fits the case.
export const OFFICE_REPLIED_NOTICE = "The office replied. This draft no longer fits. Discard it and start a new one if you still need to reply.";
export const CASE_CHANGED_NOTICE = "The case changed since this draft was made. This draft no longer fits. Discard it and start a new one.";

export const FIELD_NAMES = ["office_name", "date", "time", "location", "declined_slots", "user_name"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export type TemplateDef = {
  id: TemplateId;
  title: string;
  // What the reply asserts, in the words the UI shows.
  asserts: string;
  validStates: SlotState[];
  // Fields the slot must have. Other fields are left out of the text when
  // the case has no value for them.
  required: FieldName[];
  // Fields the template can show.
  fields: FieldName[];
  // The claim that approval records on the slot, if any.
  records: "request" | "decline" | "decline_alternatives" | null;
};

const COMMON: FieldName[] = ["office_name", "date", "time", "location", "user_name"];

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  accept_offer: {
    id: "accept_offer",
    title: "Accept an offered slot",
    asserts: "You accept the slot and ask the office to confirm it.",
    validStates: ["offered"],
    required: ["date", "time"],
    fields: COMMON,
    records: "request",
  },
  decline_offer: {
    id: "decline_offer",
    title: "Decline and ask for another time",
    asserts: "You decline the slot and ask for another time.",
    validStates: ["offered"],
    required: ["date", "time"],
    fields: COMMON,
    records: "decline",
  },
  ask_still_stands: {
    id: "ask_still_stands",
    title: "Ask whether a slot still stands",
    asserts: "A question. You commit to nothing.",
    validStates: ["confirmed", "change_proposed"],
    required: ["date", "time"],
    fields: COMMON,
    records: null,
  },
  keep_original: {
    id: "keep_original",
    title: "Keep the original",
    asserts: "You keep the confirmed slot and decline the proposed change.",
    validStates: ["change_proposed"],
    required: ["date", "time"],
    fields: ["office_name", "date", "time", "location", "declined_slots", "user_name"],
    records: "decline_alternatives",
  },
};

export const FIELD_LABELS: Record<FieldName, string> = {
  office_name: "Office",
  date: "Date",
  time: "Time",
  location: "Place",
  declined_slots: "Proposed change you decline",
  user_name: "Your name",
};

// The text shown for each field. `display` is null when the case has no
// value, and the template then leaves that part out.
export type FieldDisplays = Record<FieldName, string | null>;

export function renderReply(template: TemplateId, f: FieldDisplays): string {
  const greeting = f.office_name ? `Hello ${f.office_name},` : "Hello,";
  const sign = f.user_name ? `Thank you,\n${f.user_name}` : "Thank you.";
  const when = `${f.date} at ${f.time}${f.location ? ` at ${f.location}` : ""}`;
  let body: string;
  switch (template) {
    case "accept_offer":
      body = `I accept the appointment on ${when}. Please confirm it.`;
      break;
    case "decline_offer":
      body = `I can't take the appointment on ${when}. Could you offer me another time?`;
      break;
    case "ask_still_stands":
      body = `Is my appointment on ${when} still set? Please let me know.`;
      break;
    case "keep_original":
      body = `I would like to keep my appointment on ${when}. I decline the proposed change${f.declined_slots ? ` to ${f.declined_slots}` : ""}.`;
      break;
  }
  return `${greeting}\n\n${body}\n\n${sign}`;
}
