// The office as the case holds it (0016, M1, M3 and H4): its name for the
// reply's greeting and the calendar event's title, its place, and a plain
// label for one of its messages. Code builds each from the office's own
// messages and the accepted facts. Pure functions, safe in the browser.
import { timeLabel } from "../slots/labels.ts";

// The parts of the case views these read, so the page can use them too.
type MessageView = { id: string; sourceType: string; importedFrom?: string; message: { channel: string; from: string; received_at: string } };
type EvidenceView = { id: string; status: string; messageId: string | null; claim: { slot: { location: string | null } } };
type SlotView = { evidenceIds: string[]; location: string | null };

// Imported text such as a sender name is shown on one line and cut.
const MAX_NAME_CHARS = 120;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);

// The name in a sender line, never an email address. "Front Desk, Lantern
// Hill Clinic <front@lanternhill.example>" is "Front Desk, Lantern Hill
// Clinic". A bare address, or a name that holds one, is null.
export function senderName(from: string): string | null {
  const name = oneLine(from.replace(/<[^>]*>/g, " ").replace(/^["'\s]+|["'\s]+$/g, ""));
  return name === "" || name.includes("@") || /^unknown sender$/i.test(name) ? null : name;
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// A sender name the office's own place spells in full, as when the email
// account is named "lantern hill" and the office's message gives its place
// as "Lantern Hill Clinic, 400 Elm Street". The place's first part names
// the office when it holds every word of the sender name in order.
function fullerName(name: string, places: string[]): string {
  const want = words(name);
  for (const place of places) {
    const head = oneLine(place.split(",")[0] ?? "");
    const have = words(head);
    if (have.length <= want.length) continue;
    for (let i = 0; i + want.length <= have.length; i++) {
      if (want.every((w, j) => have[i + j] === w)) return head;
    }
  }
  return name;
}

export type OfficeOf = {
  name: string | null;
  // The office message the name comes from, for its source line.
  evidenceId: string | null;
  messageId: string | null;
  // The slot's place, or the one place the office's accepted facts give
  // when the slot has none.
  location: string | null;
};

const sameSender = (m: MessageView, messages: MessageView[]) =>
  new Set(messages.filter((x) => x.sourceType === "office_message" && x.message.from === m.message.from).map((x) => x.id));

const placesOf = (ids: Set<string>, evidence: EvidenceView[], ok: (status: string) => boolean) => [
  ...new Set(evidence.filter((e) => ok(e.status) && e.messageId !== null && ids.has(e.messageId) && e.claim.slot.location).map((e) => oneLine(e.claim.slot.location!))),
];

// 0016, M1 and C2: the name the case holds for the sender of an office
// message, for every place the page or a reply names it. A pasted sender is
// the name the person's message gave, kept as it is. A Gmail sender's name
// is spelled in full by a place its messages give that is not rejected.
// Null for a message that is not from the office, or a sender with only an
// address.
export function officeNameOf(m: MessageView, evidence: EvidenceView[], messages: MessageView[]): string | null {
  if (m.sourceType !== "office_message") return null;
  const name = senderName(m.message.from);
  if (!name || m.importedFrom !== "gmail") return name;
  return fullerName(name, placesOf(sameSender(m, messages), evidence, (s) => s !== "rejected"));
}

// The office of a slot: the sender of the latest office message on it.
export function officeOf(slot: SlotView, evidence: EvidenceView[], messages: MessageView[]): OfficeOf {
  for (const id of [...slot.evidenceIds].reverse()) {
    const ev = evidence.find((e) => e.id === id);
    const message = ev?.messageId ? messages.find((m) => m.id === ev.messageId) : undefined;
    if (!ev || !message || message.sourceType !== "office_message") continue;
    // The place the office's accepted facts give, when there is only one.
    const places = placesOf(sameSender(message, messages), evidence, (s) => s === "accepted");
    return {
      name: officeNameOf(message, evidence, messages),
      evidenceId: id,
      messageId: message.id,
      location: slot.location ?? (places.length === 1 ? places[0]! : null),
    };
  }
  return { name: null, evidenceId: null, messageId: null, location: slot.location };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CHANNEL_WORDS: Record<string, string> = {
  email: "the email",
  sms: "the text message",
  portal: "the portal message",
  voicemail_transcript: "the voicemail",
  user_report: "your report",
  unknown: "the message",
};

// "the email from Lantern Hill Clinic, Oct 28, 6:43 PM", in the case's
// zone. `wall` turns an instant into its date and time there. `who` is the
// sender's name as the case holds it (officeNameOf), or the sender line's
// name without it. Never the message id or an address.
export function messageLabel(m: MessageView, wall: (iso: string) => { date: string; time: string } | null, who: string | null = m.sourceType === "office_message" ? senderName(m.message.from) : null): string {
  const what = CHANNEL_WORDS[m.message.channel] ?? "the message";
  const at = wall(m.message.received_at);
  const when = at ? `${MONTHS[Number(at.date.slice(5, 7)) - 1]} ${Number(at.date.slice(8, 10))}, ${timeLabel(at.time)}` : null;
  return [`${what}${who ? ` from ${who}` : ""}`, when].filter(Boolean).join(", ");
}
