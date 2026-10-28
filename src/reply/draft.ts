// Code builds every reply: it checks the template against the slot's state,
// fills each field from the projected slot, the evidence and the case
// profile, and renders the template. Model output never supplies a value.
// Pure functions over the case projection.
import type { EvidenceView, MessageView } from "../intake/events.ts";
import { dateLabel, timeLabel } from "../slots/labels.ts";
import type { SlotView } from "../slots/types.ts";
import { FIELD_LABELS, TEMPLATES, TEMPLATE_IDS, renderReply, type FieldDisplays, type FieldName, type TemplateId } from "./templates.ts";
import type { FieldSource, FieldView, ReplyOption, WithheldOption } from "./types.ts";

export type ReplyContext = {
  slots: SlotView[];
  evidence: EvidenceView[];
  messages: MessageView[];
  // From the case profile. Null leaves the name out of the reply.
  userName: string | null;
  // Event seq numbers at which the user accepted a claim from an office
  // message. Used only to say why a draft no longer fits.
  officeAcceptedSeqs?: number[];
  // Slot keys of archived appointments. They leave the reply panel, and no
  // draft is built for one until the archive is undone.
  archived?: string[];
};

export type DraftProblem = "unknown_slot" | "slot_archived" | "template_not_valid_for_state" | "missing_field";

// The slots a reply may name: every slot that is not archived.
export function replySlots(ctx: ReplyContext): SlotView[] {
  const archived = new Set(ctx.archived ?? []);
  return archived.size === 0 ? ctx.slots : ctx.slots.filter((s) => !archived.has(s.key));
}

export type DraftContent = {
  template: TemplateId;
  slot: SlotView;
  fields: FieldView[];
  text: string;
  // Slots that approval declines. Set only for keep_original.
  declines: string[];
};

export type DraftResult =
  | { ok: true; content: DraftContent }
  | { ok: false; problems: DraftProblem[]; missing: FieldName[] };

// Imported text such as a sender name is data. It is shown on one line and
// cut to this length.
export const MAX_FIELD_CHARS = 120;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_CHARS);

// The open slots that make up the change proposed to `slot`: offered or
// requested slots that a proposal on `slot` offered.
export function proposedAlternatives(slot: SlotView, slots: SlotView[]): SlotView[] {
  if (slot.state !== "change_proposed") return [];
  return slots.filter(
    (t) => t.key !== slot.key && (t.state === "offered" || t.state === "requested") && t.evidenceIds.some((id) => slot.proposalEvidenceIds.includes(id)),
  );
}

function officeName(slot: SlotView, ctx: ReplyContext): { value: string; source: FieldSource } | null {
  // The sender of the latest office message on the slot.
  for (const id of [...slot.evidenceIds].reverse()) {
    const ev = ctx.evidence.find((e) => e.id === id);
    const message = ev?.messageId ? ctx.messages.find((m) => m.id === ev.messageId) : undefined;
    if (!ev || !message || message.sourceType !== "office_message") continue;
    const value = oneLine(message.message.from);
    if (value) return { value, source: { kind: "evidence", evidenceId: id, text: `Sender of message ${message.id}` } };
  }
  return null;
}

function field(name: FieldName, value: string | null, display: string | null, sources: FieldSource[]): FieldView {
  return { name, label: FIELD_LABELS[name], value, display: value === null ? null : display, sources: value === null ? [] : sources };
}

export function slotFields(template: TemplateId, slot: SlotView, ctx: ReplyContext): { fields: FieldView[]; declines: string[] } {
  const slotSource: FieldSource = { kind: "slot", evidenceId: slot.stateEvidenceId, text: `${slot.label}, ${slot.stateLabel}` };
  const office = officeName(slot, ctx);
  const placeSources: FieldSource[] = ctx.evidence
    .filter((e) => e.status === "accepted" && slot.location !== null && e.claim.slot.date === slot.date && e.claim.slot.location === slot.location)
    .map((e) => ({ kind: "evidence", evidenceId: e.id, text: e.claim.quote ? `Quote: “${e.claim.quote}”` : `Evidence ${e.id}` }));
  const alternatives = template === "keep_original" ? proposedAlternatives(slot, ctx.slots) : [];
  const all: Record<FieldName, FieldView> = {
    office_name: field("office_name", office?.value ?? null, office?.value ?? null, office ? [office.source] : []),
    date: field("date", slot.date, dateLabel(slot.date), [slotSource]),
    time: field("time", slot.time, slot.time === null ? null : timeLabel(slot.time), [slotSource]),
    location: field("location", slot.location === null ? null : oneLine(slot.location), slot.location === null ? null : oneLine(slot.location), placeSources),
    declined_slots: field(
      "declined_slots",
      alternatives.length === 0 ? null : alternatives.map((t) => t.key).join(","),
      alternatives.map((t) => t.label).join(" and "),
      alternatives.map((t) => ({ kind: "slot", evidenceId: t.stateEvidenceId, text: `${t.label}, ${t.stateLabel}` })),
    ),
    user_name: field("user_name", ctx.userName, ctx.userName, [{ kind: "case", evidenceId: null, text: "Case profile" }]),
  };
  return { fields: TEMPLATES[template].fields.map((n) => all[n]), declines: alternatives.map((t) => t.key) };
}

export function renderFields(template: TemplateId, fields: FieldView[]): string {
  const displays = Object.fromEntries(fields.map((f) => [f.name, f.display])) as FieldDisplays;
  return renderReply(template, displays);
}

// Checks the template against the slot and builds the draft. S9: a template
// whose state row does not include the slot's state is blocked. S7: a
// template that needs a field the slot lacks is blocked.
export function buildDraft(template: TemplateId, slotKey: string, ctx: ReplyContext): DraftResult {
  const def = TEMPLATES[template];
  const slot = ctx.slots.find((s) => s.key === slotKey);
  if (!slot) return { ok: false, problems: ["unknown_slot"], missing: [] };
  if (ctx.archived?.includes(slotKey)) return { ok: false, problems: ["slot_archived"], missing: [] };
  const problems: DraftProblem[] = [];
  if (!def.validStates.includes(slot.state)) problems.push("template_not_valid_for_state");
  const { fields, declines } = slotFields(template, slot, ctx);
  const missing = def.required.filter((n) => fields.find((f) => f.name === n)?.value == null);
  if (missing.length > 0) problems.push("missing_field");
  if (problems.length > 0) return { ok: false, problems, missing };
  return { ok: true, content: { template, slot, fields, text: renderFields(template, fields), declines } };
}

// Every template and slot pair the user may start a reply from, and the
// pairs a state allows but a missing field withholds.
export function replyOptions(ctx: ReplyContext): { options: ReplyOption[]; withheld: WithheldOption[] } {
  const options: ReplyOption[] = [];
  const withheld: WithheldOption[] = [];
  for (const slot of replySlots(ctx)) {
    for (const template of TEMPLATE_IDS) {
      if (!TEMPLATES[template].validStates.includes(slot.state)) continue;
      const option = { template, title: TEMPLATES[template].title, slotKey: slot.key, slotLabel: slot.label };
      const result = buildDraft(template, slot.key, ctx);
      if (result.ok) options.push(option);
      else withheld.push({ ...option, missing: result.missing });
    }
  }
  return { options, withheld };
}

const signature = (fields: FieldView[]) => JSON.stringify(fields.map((f) => [f.name, f.value]));

// True when a stored draft's fields still equal what code builds from the
// current case.
export function sameFields(a: FieldView[], b: FieldView[]): boolean {
  return signature(a) === signature(b);
}
