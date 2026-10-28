// Words and times the UI shows, built by code. Times show in the case's
// time zone with its short name ("MST", "GMT+2"), so the hour on either side
// of a clock change is clear. The zone comes from /api/settings. The user
// or their agent sets it. Until the page reads it, America/Denver is used.
import type { EvidenceClaimType } from "../src/domain/claim.ts";
import { ApiError } from "./api.ts";
import { DEFAULT_ZONE } from "./contract.ts";

let caseZone = DEFAULT_ZONE;

// The page sets this when it reads the settings. Every formatter below uses
// it unless a zone is passed.
export function setCaseZone(zone: string): void {
  caseZone = zone;
}
export const getCaseZone = () => caseZone;

const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(kind: "stamp" | "short" | "wall" | "offset" | "name", zone: string): Intl.DateTimeFormat {
  const key = `${kind}:${zone}`;
  let f = cache.get(key);
  if (!f) {
    const options: Record<typeof kind, Intl.DateTimeFormatOptions> = {
      stamp: { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" },
      short: { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
      wall: { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
      offset: { timeZoneName: "longOffset" },
      name: { timeZoneName: "short" },
    };
    f = new Intl.DateTimeFormat(kind === "wall" ? "en-CA" : "en-US", { timeZone: zone, ...options[kind] });
    cache.set(key, f);
  }
  return f;
}

const parts = (f: Intl.DateTimeFormat, ms: number) => Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));

// "2026-11-01 01:30 MDT" and, an hour later, "2026-11-01 01:30 MST".
export function stampTime(iso: string, zone = caseZone): string {
  const p = parts(formatter("stamp", zone), Date.parse(iso));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

// "Thu, Nov 5, 10:02 AM MST", for chat and card headers.
export function shortTime(iso: string, zone = caseZone): string {
  const p = parts(formatter("short", zone), Date.parse(iso));
  return `${p.weekday}, ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}

// "10:02 AM", for a timeline row under its day.
export function clockTime(iso: string, zone = caseZone): string {
  const p = parts(formatter("short", zone), Date.parse(iso));
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

// The zone with its short name, "America/Denver (MST)", or the name alone
// when they are the same, as for UTC.
export function zoneWithShortName(zone = caseZone, now = Date.now()): string {
  const short = zoneShortName(zone, now);
  return short === zone ? zone : `${zone} (${short})`;
}

// The zone's short name now: "MST", "GMT+2".
export function zoneShortName(zone = caseZone, now = Date.now()): string {
  return parts(formatter("name", zone), now).timeZoneName ?? zone;
}

// The claim types the domain defines (src/domain/claim.ts), kept here so
// the page does not load the validation library. A test checks they match.
export const CLAIM_TYPES = ["offer", "confirm", "cancel", "move", "reminder", "office_request"] as const;
export const DEFAULT_EXTRACTION_EFFORT = "minimal" as const;

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
  unknown: "Channel not stated",
};

export const channelWord = (c: string) => CHANNEL_WORDS[c] ?? c;

const NOTHING_SAVED = "Nothing was saved.";

// What went wrong, as a plain sentence that says nothing was saved. Never
// shows a raw response body.
export function errorSentence(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.body.error;
    // Undo refused because a later action depends on this one. The
    // server's sentence says why.
    if (code === "undo_blocked" && typeof e.body.message === "string" && e.body.message.trim() !== "") return e.body.message.trim();
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

// The offset of a zone at an instant, in minutes.
function zoneOffset(zone: string, ms: number): number {
  const name = parts(formatter("offset", zone), ms).timeZoneName ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

// A wall time typed in the case zone ("2026-11-01T01:30") as an ISO time
// with its offset ("2026-11-01T01:30:00-06:00"). An hour that happens twice
// on a clock change is read as the first one (for Denver on 2026-11-01, MDT).
export function wallToIso(wall: string, zone = caseZone): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall);
  if (!m) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // The offset a day earlier is the one before any change on this day.
  let offset = zoneOffset(zone, asUtc - 24 * 3600_000);
  const second = zoneOffset(zone, asUtc - offset * 60_000);
  if (second !== offset && zoneOffset(zone, asUtc - second * 60_000) === second) offset = second;
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${wall}:00${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// The current time on the case's clock, for a datetime-local field.
export function wallNow(now = Date.now(), zone = caseZone): string {
  const p = parts(formatter("wall", zone), now);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// A calendar date and time on the case's clock, for an instant.
export function wallParts(ms: number, zone = caseZone): { date: string; time: string } {
  const p = parts(formatter("wall", zone), ms);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
