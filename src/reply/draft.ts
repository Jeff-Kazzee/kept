// Code builds every reply: it checks the template against the slot's state,
// fills each field from the projected slot, the evidence and the case
// profile, and renders the template. Model output never supplies a value.
// Pure functions over the case projection.
import { agentWordsLabel, untrustedLabel } from "../domain/untrusted.ts";
import type { EvidenceView, MessageView } from "../intake/events.ts";
import { dateLabel, timeLabel } from "../slots/labels.ts";
import type { SlotView } from "../slots/types.ts";
import { localDateTime } from "../domain/zone.ts";
import { normalizeWhitespace } from "../domain/quote.ts";
import { FIELD_LABELS, TEMPLATES, TEMPLATE_IDS, renderReply, type FieldDisplays, type FieldName, type TemplateId } from "./templates.ts";
import { messageLabel, officeOf } from "./office.ts";
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
  // The case's time zone, for the labels of messages in field sources.
  timeZone?: string;
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

// 0016, M1: the office by the name the case holds for it, never an email
// address. M3: its source names the message by sender and time, not id.
function officeName(slot: SlotView, ctx: ReplyContext): { value: string; source: FieldSource } | null {
  const office = officeOf(slot, ctx.evidence, ctx.messages);
  const message = office.messageId ? ctx.messages.find((m) => m.id === office.messageId) : undefined;
  if (!office.name || !message) return null;
  const zone = ctx.timeZone ?? "UTC";
  const wall = (iso: string) => (Number.isFinite(Date.parse(iso)) ? localDateTime(Date.parse(iso), zone) : null);
  return { value: office.name, source: { kind: "evidence", evidenceId: office.evidenceId, text: `Sender of ${messageLabel(message, wall, office.name)}` } };
}

// Fix round 2, N4: a source without a quote, in words without its id.
export const NO_QUOTE_SOURCE = "From the message that set this time";

// An evidence item as a field source. The quote of an agent's confirmed
// report is the agent's own words, so it carries the agent's name and the
// untrusted label instead of being shown as a quote.
function evidenceSource(e: EvidenceView): FieldSource {
  const c = e.claim;
  if (c.source_type === "reported_by_user_via_agent") {
    return { kind: "evidence", evidenceId: e.id, text: c.quote ?? NO_QUOTE_SOURCE, agentName: c.agent_name ?? null, untrustedLabel: agentWordsLabel(c.agent_name) };
  }
  return { kind: "evidence", evidenceId: e.id, text: c.quote ? `Quote: “${c.quote}”` : NO_QUOTE_SOURCE };
}

// Sprint 18 fix round 1, item 8: the Place field's source quotes the
// place's own words, never the claim's quote, which names the time. The
// words are found in the claim's quote first, then in its message, with
// a leading "our", "the", "my" or "your" kept, as in "our Elm Street
// office". A place its message does not name word for word gets no quote.
export const NO_PLACE_QUOTE_SOURCE = "From the message that named this place";

const PLACE_LEAD = /(?:^|\s)((?:our|the|my|your)\s)$/i;

export function placeWords(place: string, text: string | null | undefined): string | null {
  if (!text) return null;
  const p = normalizeWhitespace(place);
  const t = normalizeWhitespace(text);
  if (p === "") return null;
  const at = t.toLowerCase().indexOf(p.toLowerCase());
  if (at === -1) return null;
  const before = t.slice(0, at);
  const after = t[at + p.length] ?? "";
  if ((before && /[\p{L}\p{N}]$/u.test(before)) || /[\p{L}\p{N}]/u.test(after)) return null;
  const lead = PLACE_LEAD.exec(before)?.[1] ?? "";
  return `${lead}${t.slice(at, at + p.length)}`.slice(0, 200);
}

function placeSource(e: EvidenceView, place: string, ctx: ReplyContext): FieldSource {
  const c = e.claim;
  // An agent's report keeps its own words and label.
  if (c.source_type === "reported_by_user_via_agent") return evidenceSource(e);
  const message = e.messageId ? ctx.messages.find((m) => m.id === e.messageId) : undefined;
  const words = placeWords(place, c.quote) ?? placeWords(place, message?.message.text);
  return { kind: "evidence", evidenceId: e.id, text: words ? `Quote: “${words}”` : NO_PLACE_QUOTE_SOURCE };
}

// A value that only agents' words support, such as a place an agent
// reported, is labeled as untrusted. A value an office message or the user
// also states is not.
function agentOnly(f: FieldView): FieldView {
  const agents = f.sources.filter((s) => s.untrustedLabel);
  if (f.value === null || agents.length === 0 || agents.length !== f.sources.length) return f;
  const names = [...new Set(agents.map((s) => s.agentName ?? "an agent"))].join(" and ");
  return { ...f, untrustedLabel: untrustedLabel(`Reported only by ${names}`) };
}

function field(name: FieldName, value: string | null, display: string | null, sources: FieldSource[]): FieldView {
  return { name, label: FIELD_LABELS[name], value, display: value === null ? null : display, sources: value === null ? [] : sources };
}

export function slotFields(template: TemplateId, slot: SlotView, ctx: ReplyContext): { fields: FieldView[]; declines: string[] } {
  const slotSource: FieldSource = { kind: "slot", evidenceId: slot.stateEvidenceId, text: `${slot.label}, ${slot.stateLabel}` };
  const office = officeName(slot, ctx);
  const placeSources: FieldSource[] = ctx.evidence
    .filter((e) => e.status === "accepted" && slot.location !== null && e.claim.slot.date === slot.date && e.claim.slot.location === slot.location)
    .map((e) => placeSource(e, slot.location!, ctx));
  const alternatives = template === "keep_original" ? proposedAlternatives(slot, ctx.slots) : [];
  const all: Record<FieldName, FieldView> = {
    // 0016, R6: the office's name comes from its messages, so the readback
    // labels it as untrusted text, as an agent-only place is.
    office_name: office
      ? { ...field("office_name", office.value, office.value, [office.source]), untrustedLabel: untrustedLabel("The office's name, from its message") }
      : field("office_name", null, null, []),
    date: field("date", slot.date, dateLabel(slot.date), [slotSource]),
    time: field("time", slot.time, slot.time === null ? null : timeLabel(slot.time), [slotSource]),
    location: agentOnly(
      field("location", slot.location === null ? null : oneLine(slot.location), slot.location === null ? null : oneLine(slot.location), placeSources),
    ),
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

// A field's value, display, sources and labels. A draft stored before
// sources carried labels lacks those keys, which count as null, so its
// agent sources differ from the ones code builds now.
const signature = (fields: FieldView[]) =>
  JSON.stringify(
    fields.map((f) => [
      f.name,
      f.value,
      f.display,
      f.untrustedLabel ?? null,
      f.sources.map((s) => [s.kind, s.evidenceId, s.text, s.agentName ?? null, s.untrustedLabel ?? null]),
    ]),
  );

// True when a stored draft's fields still equal what code builds from the
// current case: values, the words shown for them, their sources and their
// labels. Any difference makes the draft stale.
export function sameFields(a: FieldView[], b: FieldView[]): boolean {
  return signature(a) === signature(b);
}
