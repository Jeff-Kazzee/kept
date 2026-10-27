// Event kinds for replies and the projection built from them. The `reply`
// stream holds every suggestion, draft, edit, discard, approval and
// simulated send of the case, so every write states one expected version and
// two drafts cannot be open at once. A new draft replaces the open one
// through an explicit discard event.
import type { AttemptData } from "../case/events.ts";
import type { StoredEvent } from "../store/event-log.ts";
import { TEMPLATES, type TemplateId } from "./templates.ts";
import type { DraftOrigin, FieldView } from "./types.ts";

export const REPLY_STREAM = "reply";

export type ReplyEvent =
  | {
      type: "reply_suggested";
      data: {
        suggestion_id: string;
        intent: string | null;
        key: string;
        outcome: "valid" | "manual_needed";
        template: TemplateId | null;
        slot_key: string | null;
        attempts: AttemptData[];
        // Problems with a valid pick once the case changed during the model
        // call. The suggestion then falls back to manual entry.
        case_changed?: string[];
      };
    }
  | {
      type: "reply_drafted";
      data: {
        draft_id: string;
        template: TemplateId;
        slot_key: string;
        slot_label: string;
        origin: DraftOrigin;
        question_id: string | null;
        suggestion_id: string | null;
        // Built by code. Stored so approval sends what was read back.
        fields: FieldView[];
        declines: string[];
        text: string;
      };
    }
  | { type: "reply_edited"; data: { draft_id: string; text: string } }
  | { type: "reply_discarded"; data: { draft_id: string; reason: "replaced" | "by_user" } }
  | {
      type: "reply_approved";
      data: {
        draft_id: string;
        // The field names the user read back before approving.
        confirmed_fields: string[];
        text: string;
        edited: boolean;
        evidence_ids: string[];
        // recorded: the template's claims were recorded. none: the template
        // records no claim. not_confirmed: the text was edited away from the
        // code render and the user did not confirm what it still asserts,
        // so no claim was recorded.
        claims: ApprovalClaims;
      };
    }
  // Nothing leaves the app. This event is the whole send.
  | { type: "reply_send_simulated"; data: { draft_id: string } };

export type ApprovalClaims = "recorded" | "none" | "not_confirmed";

export type DraftRecord = {
  id: string;
  template: TemplateId;
  slotKey: string;
  slotLabel: string;
  origin: DraftOrigin;
  questionId: string | null;
  suggestionId: string | null;
  fields: FieldView[];
  declines: string[];
  renderedText: string;
  text: string;
  edited: boolean;
  status: "open" | "discarded" | "approved";
  createdAt: string;
  approval: { text: string; edited: boolean; evidenceIds: string[]; claims: ApprovalClaims; approvedAt: string; sent: boolean } | null;
};

export type SuggestionRecord = Extract<ReplyEvent, { type: "reply_suggested" }>["data"] & { recordedAt: string };

export type ReplyLog = { version: number; drafts: DraftRecord[]; suggestions: SuggestionRecord[] };

export function projectReplies(events: StoredEvent[]): ReplyLog {
  const log: ReplyLog = { version: 0, drafts: [], suggestions: [] };
  for (const e of events) {
    if (e.streamId !== REPLY_STREAM) continue;
    log.version = e.version;
    const event = { type: e.type, data: e.data } as ReplyEvent;
    if (event.type === "reply_suggested") {
      log.suggestions.push({ ...event.data, recordedAt: e.recordedAt });
      continue;
    }
    if (event.type === "reply_drafted") {
      const d = event.data;
      log.drafts.push({
        id: d.draft_id,
        template: d.template,
        slotKey: d.slot_key,
        slotLabel: d.slot_label,
        origin: d.origin,
        questionId: d.question_id,
        suggestionId: d.suggestion_id,
        fields: d.fields,
        declines: d.declines,
        renderedText: d.text,
        text: d.text,
        edited: false,
        status: "open",
        createdAt: e.recordedAt,
        approval: null,
      });
      continue;
    }
    const draft = log.drafts.find((x) => x.id === event.data.draft_id);
    if (!draft) continue;
    if (event.type === "reply_edited") {
      draft.text = event.data.text;
      draft.edited = true;
    } else if (event.type === "reply_discarded") {
      draft.status = "discarded";
    } else if (event.type === "reply_approved") {
      draft.status = "approved";
      draft.approval = {
        text: event.data.text,
        edited: event.data.edited,
        evidenceIds: event.data.evidence_ids,
        claims: event.data.claims,
        approvedAt: e.recordedAt,
        sent: false,
      };
    } else if (event.type === "reply_send_simulated" && draft.approval) {
      draft.approval.sent = true;
    }
  }
  return log;
}

export const openDraft = (log: ReplyLog) => log.drafts.find((d) => d.status === "open") ?? null;

// The events that open a new draft. An open draft is discarded first, in
// the same write.
export function draftEvents(
  log: ReplyLog,
  draft: Omit<Extract<ReplyEvent, { type: "reply_drafted" }>["data"], "draft_id">,
): ReplyEvent[] {
  const events: ReplyEvent[] = [];
  const open = openDraft(log);
  if (open) events.push({ type: "reply_discarded", data: { draft_id: open.id, reason: "replaced" } });
  events.push({ type: "reply_drafted", data: { draft_id: `d${log.drafts.length + 1}`, ...draft } });
  return events;
}

export const templateTitle = (t: TemplateId) => TEMPLATES[t].title;
