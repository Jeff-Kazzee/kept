// Domain types for D1 evidence intake. Shared by the server, the scripts and
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

// Slot state names only. The rules that move a slot between states are D2.
export const SLOT_STATES = ["offered", "requested", "confirmed", "change_proposed", "canceled", "declined"] as const;
export type SlotState = (typeof SLOT_STATES)[number];

// `user_report` is a message the user typed about something that happened
// elsewhere, for example a phone call. Every other channel is a message the
// user pasted or selected from the office.
export const Channel = z.enum(["sms", "email", "portal", "voicemail_transcript", "user_report"]);
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
  claim_type: ClaimType,
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
});
export type EvidenceClaim = z.infer<typeof EvidenceClaim>;
