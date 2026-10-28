// Words and times the UI shows, built by code. Times show in the case's
// time zone, America/Denver, with MDT or MST, so the hour on either side of
// the 2026-11-01 change is clear.
import type { EvidenceClaimType } from "../src/domain/claim.ts";
import { ApiError, isNotPaired } from "./api.ts";

export const TIME_ZONE = "America/Denver";

const DENVER = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

const DENVER_SHORT = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

// "2026-11-01 01:30 MDT" and, an hour later, "2026-11-01 01:30 MST".
export function denverTime(iso: string): string {
  const parts = Object.fromEntries(DENVER.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

// "Thu, Nov 5, 10:02 AM MST", for chat and card headers.
export function denverShort(iso: string): string {
  const parts = Object.fromEntries(DENVER_SHORT.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
}

// The claim types the domain defines (src/domain/claim.ts), kept here so
// the page does not load the validation library. A test checks they match.
export const CLAIM_TYPES = ["offer", "confirm", "cancel", "move", "reminder", "office_request"] as const;
export const DEFAULT_EXTRACTION_EFFORT = "minimal";

const CLAIM_WORDS: Record<EvidenceClaimType, string> = {
  offer: "Offer",
  confirm: "Confirmation",
  cancel: "Cancellation",
  move: "Move",
  reminder: "Reminder",
  office_request: "Office request",
  request: "Your request",
  decline: "You declined",
  clarify: "Your clarification",
};

export const claimWord = (t: EvidenceClaimType) => CLAIM_WORDS[t];

const CHANNEL_WORDS: Record<string, string> = {
  sms: "Text message",
  email: "Email",
  portal: "Portal message",
  voicemail_transcript: "Voicemail transcript",
  user_report: "Your own report",
};

export const channelWord = (c: string) => CHANNEL_WORDS[c] ?? c;

const NOTHING_SAVED = "Nothing was saved.";

// What went wrong, as a plain sentence that says nothing was saved. Never
// shows a raw response body.
export function errorSentence(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.body.error;
    if (isNotPaired(e)) return "This browser is not paired with the app. Nothing was saved.";
    if (code === "case_deleted") return "The case was deleted in another tab or window. Nothing was saved. The empty case is loaded.";
    if (code === "stale_edit" || e.status === 409) return "This changed since it was shown. Nothing was saved. The current version is loaded.";
    if (code === "busy") return "The app is busy with another change. Nothing was saved. Try again in a moment.";
    if (code === "invalid_body") return "The page sent a request the app could not read. Nothing was saved.";
    if (code === "not_found") return "That item is no longer in the case. Nothing was saved.";
    if (code === "server_error") return "The app could not complete the request. Nothing was saved.";
    const message = e.body.message;
    if (typeof message === "string" && message.trim() !== "") return message.includes(NOTHING_SAVED) ? message : `${message.trim()} ${NOTHING_SAVED}`;
    return `The app refused the request (HTTP ${e.status}). ${NOTHING_SAVED}`;
  }
  if (e instanceof TypeError) return "The page could not reach the app. Nothing was saved. Check that the app is running.";
  return `Something went wrong. ${NOTHING_SAVED}`;
}
