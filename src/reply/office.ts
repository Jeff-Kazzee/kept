// The office as the case holds it (0016, M1, M3 and H4): its name for the
// reply's greeting and the calendar event's title, its place, and a plain
// label for one of its messages. Code builds each from the office's own
// messages and the accepted facts. Pure functions, safe in the browser.
import { timeLabel } from "../slots/labels.ts";

// The parts of the case views these read, so the page can use them too.
type MessageView = { id: string; sourceType: string; importedFrom?: string; status?: string; message: { channel: string; from: string; received_at: string } };
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
  // The slot's own place from accepted evidence, the one the schedule and
  // the reply show (0017, E2). Never the office's other places.
  location: string | null;
};

// Fix round 2, N3: one office is one address. The address inside a sender
// line, or the line itself when it has none, so "Lantern Hill <a@x>" and
// "Front Desk <a@x>" are the same office.
export function senderKey(from: string): string {
  const inside = /<([^<>]+@[^<>]+)>/.exec(from)?.[1];
  const bare = /^\s*([^\s<>@]+@[^\s<>@]+)\s*$/.exec(from)?.[1];
  return (inside ?? bare ?? oneLine(from)).trim().toLowerCase();
}

const sameSender = (m: MessageView, messages: MessageView[]) => {
  const key = senderKey(m.message.from);
  return messages.filter((x) => x.sourceType === "office_message" && senderKey(x.message.from) === key);
};

// The places the office's accepted facts give. Only accepted facts name or
// place the office (fix round 2, N3).
const acceptedPlaces = (group: MessageView[], evidence: EvidenceView[]) => {
  const ids = new Set(group.map((x) => x.id));
  return [...new Set(evidence.filter((e) => e.status === "accepted" && e.messageId !== null && ids.has(e.messageId) && e.claim.slot.location).map((e) => oneLine(e.claim.slot.location!)))];
};

// 0016, M1 and C2: the name the case holds for the sender of an office
// message, for every place the page or a reply names it. A pasted sender is
// the name the person's message gave, kept as it is. For Gmail, every
// message from the same address names one office: the sender name a place
// of the office's accepted facts spells in full, else the sender name of
// its latest message. Null for a message that is not from the office, or a
// sender with only an address.
export function officeNameOf(m: MessageView, evidence: EvidenceView[], messages: MessageView[]): string | null {
  if (m.sourceType !== "office_message") return null;
  const own = senderName(m.message.from);
  if (m.importedFrom !== "gmail") return own;
  const group = sameSender(m, messages).filter((x) => x.importedFrom === "gmail");
  if (!group.some((x) => x.id === m.id)) group.push(m);
  const latestFirst = [...group].sort((a, b) => Date.parse(b.message.received_at) - Date.parse(a.message.received_at));
  const names = latestFirst.map((x) => senderName(x.message.from)).filter((x): x is string => x !== null);
  const places = acceptedPlaces(group, evidence);
  for (const name of names) {
    const full = fullerName(name, places);
    if (full !== name) return full;
  }
  return names[0] ?? null;
}

// 0017, E6: the office's name as the page and the activity labels show it
// now. For Gmail, while one of the office's messages is not read yet or one
// of its facts that gives a place waits for review, the name may still
// become the fuller one that place spells, so it is null until then and the
// page names no one rather than show the email account's name for a moment.
// A name already made fuller, and a pasted sender, show at once.
export function officeNameShown(m: MessageView, evidence: EvidenceView[], messages: MessageView[]): string | null {
  const name = officeNameOf(m, evidence, messages);
  if (name === null || m.importedFrom !== "gmail") return name;
  const group = sameSender(m, messages).filter((x) => x.importedFrom === "gmail");
  if (!group.some((x) => x.id === m.id)) group.push(m);
  if (!group.some((x) => senderName(x.message.from) === name)) return name;
  const ids = new Set(group.map((x) => x.id));
  const waiting = group.some((x) => x.status === "imported") || evidence.some((e) => e.status === "pending" && e.messageId !== null && ids.has(e.messageId) && e.claim.slot.location);
  return waiting ? null : name;
}

// The office of a slot: the sender of the latest office message on it.
export function officeOf(slot: SlotView, evidence: EvidenceView[], messages: MessageView[]): OfficeOf {
  for (const id of [...slot.evidenceIds].reverse()) {
    const ev = evidence.find((e) => e.id === id);
    const message = ev?.messageId ? messages.find((m) => m.id === ev.messageId) : undefined;
    if (!ev || !message || message.sourceType !== "office_message") continue;
    // 0017, fix round 1, R8: the name the page shows, so the reply's
    // greeting and the calendar event never hold the account's name while
    // the page holds it back.
    return { name: officeNameShown(message, evidence, messages), evidenceId: id, messageId: message.id, location: slot.location };
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
