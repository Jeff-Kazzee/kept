// Domain types for evidence intake and slot states. Shared by the server, the scripts and
// the UI, so this file must not import Node modules.
import { z } from "zod";

export const CLAIM_TYPES = ["offer", "confirm", "cancel", "move", "reminder", "office_request"] as const;
export const ClaimType = z.enum(CLAIM_TYPES);
export type ClaimType = z.infer<typeof ClaimType>;

export const SourceType = z.enum(["office_message", "reported_by_user", "reported_by_user_via_agent"]);
export type SourceType = z.infer<typeof SourceType>;

export const SenderKind = z.enum(["person", "automated", "unknown"]);
export type SenderKind = z.infer<typeof SenderKind>;

export const Effort = z.enum(["minimal", "low"]);
export type Effort = z.infer<typeof Effort>;

// Jeff chose effort minimal for extraction on 2026-10-27. Sprint 2 measured
// both levels at 100% across three runs, and minimal was about twice as
// fast. Effort low stays available by option.
export const DEFAULT_EXTRACTION_EFFORT: Effort = "minimal";

// Claim types that only a user answer or an approved reply creates. The
// model can never return them, because the extraction schema lists
// CLAIM_TYPES only.
//   request  the user approved a reply that accepts this slot (rule 2)
//   decline  the user declined an offered slot
//   clarify  the user said which date, time or place a claim means
export const ANSWER_CLAIM_TYPES = ["request", "decline", "clarify"] as const;
export const EvidenceClaimType = z.enum([...CLAIM_TYPES, ...ANSWER_CLAIM_TYPES]);
export type EvidenceClaimType = z.infer<typeof EvidenceClaimType>;

// Slot state names. src/slots/project.ts holds the rules.
export const SLOT_STATES = ["offered", "requested", "confirmed", "change_proposed", "canceled", "declined"] as const;
export type SlotState = (typeof SLOT_STATES)[number];

// `user_report` is a message the user typed about something that happened
// elsewhere, for example a phone call. Every other channel is a message the
// user pasted or selected from the office.
// `unknown` is a message pasted in the chat whose channel the assistant
// could not name with one of the others (0007, E1).
export const Channel = z.enum(["sms", "email", "portal", "voicemail_transcript", "user_report", "unknown"]);
export type Channel = z.infer<typeof Channel>;

export function sourceTypeForChannel(channel: Channel): SourceType {
  return channel === "user_report" ? "reported_by_user" : "office_message";
}

const IsoDateTime = z.iso.datetime({ offset: true });

export const Message = z.object({
  id: z.string().min(1).max(100),
  channel: Channel,
  from: z.string().min(1).max(200),
  received_at: IsoDateTime,
  text: z.string().min(1).max(20_000),
});
export type Message = z.infer<typeof Message>;

export const Slot = z.object({
  date: z.string().nullable(),
  time: z.string().nullable(),
  location: z.string().nullable(),
});
export type Slot = z.infer<typeof Slot>;

// An evidence item: one claim about an appointment, tied to its source.
export const EvidenceClaim = z.object({
  claim_type: EvidenceClaimType,
  slot: Slot,
  // Verbatim words from the source message. Null only for a manual entry
  // where the user gave no quote.
  quote: z.string().nullable(),
  source_type: SourceType,
  sender_kind: SenderKind,
  // When the message arrived or the user reported it.
  evidence_time: IsoDateTime,
  // When the described event happened, if the message says so.
  event_time: z.string().nullable(),
  request_item: z.string().nullable(),
  // The grant name for reported_by_user_via_agent, taken from the grant and
  // never from the name the client reports. Absent for every other source.
  agent_name: z.string().min(1).max(100).nullable().optional(),
  // Set when the assistant suggested the source fields of the message this
  // claim came from (channel, sender, time). The review shows it beside
  // the source. Absent for every other claim.
  source_note: z.string().min(1).max(100).nullable().optional(),
});
export type EvidenceClaim = z.infer<typeof EvidenceClaim>;
