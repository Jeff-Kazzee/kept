// Gmail, read only (0012, item 4). Code builds the search query: recent
// mail with appointment words, and optionally only from chosen senders, in
// a date window. Each message comes back as sender, subject, sent time and
// plain-text body. The text is untrusted data. It becomes the same import
// shape a pasted message uses, with the sender and the sent time from the
// message's own headers, and goes through extraction, the quote check and
// the clinical scope rules like a paste.
//
// Endpoints (Gmail API reference, read on 2026-10-28):
//   GET gmail/v1/users/me/messages?q=...&maxResults=...   ids only
//   GET gmail/v1/users/me/messages/{id}?format=full        headers and parts
// Part bodies are base64url. internalDate is epoch milliseconds, when Google
// accepted the message.
import { z } from "zod";
import type { Message } from "../domain/claim.ts";
import type { GoogleConnection } from "./connection.ts";
import { GoogleError, apiError } from "./http.ts";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_SOURCE = "Gmail";

// Gmail message ids are short hexadecimal strings. Anything else is refused
// before it reaches a URL.
export const GmailMessageId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Use a message_id from gmail_search.");

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const SenderAddress = z.string().trim().toLowerCase().regex(EMAIL, "Use a plain email address.");

export const SEARCH_WORDS = [
  "appointment",
  "appointments",
  "reschedule",
  "rescheduled",
  "confirm",
  "confirmed",
  "confirmation",
  "cancel",
  "canceled",
  "cancelled",
  "reminder",
  "booking",
  "booked",
  "visit",
  "scheduled",
];

export const MAX_DAYS = 60;
export const DEFAULT_DAYS = 30;
export const MAX_RESULTS = 10;

// The fixed query. Days and senders are checked before they get here, so no
// argument can add another operator.
export function appointmentQuery(options: { days: number; senders?: readonly string[] }): string {
  const days = Math.min(MAX_DAYS, Math.max(1, Math.trunc(options.days)));
  const senders = (options.senders ?? []).map((s) => SenderAddress.parse(s));
  const parts = [`newer_than:${days}d`, `{${SEARCH_WORDS.join(" ")}}`, "-in:chats", "-in:spam", "-in:trash", "-category:promotions", "-category:social"];
  if (senders.length > 0) parts.push(`{${senders.map((s) => `from:${s}`).join(" ")}}`);
  return parts.join(" ");
}

export type GmailMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  // ISO 8601 in UTC.
  sentAt: string;
  text: string;
};

type Part = {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
};

const RawMessage = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  internalDate: z.string().regex(/^\d{1,16}$/).optional(),
  payload: z.unknown(),
});

// Limits on the part tree (review round 1, finding 8). Real mail nests a
// few levels and has a few parts.
export const MAX_PART_DEPTH = 20;
export const MAX_PARTS = 200;
const MAX_HEADERS = 500;
const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

const invalid = () => new GoogleError("google_invalid_response");
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// The part tree as the app reads it: only string fields of the expected
// names, headers with a string name and value, base64url body data, and
// child parts within the depth and count limits. Anything else is left
// out, and a tree past the limits or not made of objects is refused.
function normalizePart(raw: unknown, depth: number, count: { n: number }): Part {
  count.n += 1;
  if (depth > MAX_PART_DEPTH || count.n > MAX_PARTS) throw invalid();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const r = raw as Record<string, unknown>;
  const headers = Array.isArray(r.headers)
    ? r.headers.slice(0, MAX_HEADERS).flatMap((h) => {
        const name = h && typeof h === "object" ? str((h as Record<string, unknown>).name) : undefined;
        const value = h && typeof h === "object" ? str((h as Record<string, unknown>).value) : undefined;
        return name !== undefined && value !== undefined ? [{ name, value }] : [];
      })
    : [];
  const b = r.body && typeof r.body === "object" && !Array.isArray(r.body) ? (r.body as Record<string, unknown>) : {};
  const data = str(b.data);
  if (r.parts !== undefined && !Array.isArray(r.parts)) throw invalid();
  return {
    mimeType: str(r.mimeType),
    filename: str(r.filename),
    headers,
    body: { data: data !== undefined && BASE64URL.test(data) ? data : undefined, attachmentId: str(b.attachmentId) },
    parts: ((r.parts as unknown[] | undefined) ?? []).map((p) => normalizePart(p, depth + 1, count)),
  };
}

// RFC 2047 encoded words, such as =?UTF-8?B?...?= in a From or Subject
// header.
export function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset: string, enc: string, data: string) => {
      try {
        const bytes =
          enc.toUpperCase() === "B"
            ? Buffer.from(data, "base64")
            : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
        return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
      } catch {
        return whole;
      }
    });
}

const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const oneLine = (s: string, max: number) => decodeHeader(s).replace(HIDDEN, "").replace(/\s+/g, " ").trim().slice(0, max);

function header(part: Part, name: string): string | null {
  const h = part.headers?.find((x) => x.name?.toLowerCase() === name);
  return typeof h?.value === "string" ? h.value : null;
}

function charsetOf(part: Part): string {
  const ct = header(part, "content-type") ?? "";
  const m = /charset="?([A-Za-z0-9._-]+)"?/i.exec(ct);
  return m ? m[1]!.toLowerCase() : "utf-8";
}

function decodeBody(part: Part): string {
  const data = part.body?.data;
  if (!data) return "";
  const bytes = Buffer.from(data, "base64url");
  try {
    return new TextDecoder(charsetOf(part), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// HTML mail as plain text: no tags, scripts or styles, block ends as line
// breaks. Used only when the message has no text/plain part.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

// The parts of a given type that are message text, not attachments, in
// order.
function textParts(part: Part, type: string, out: Part[] = []): Part[] {
  const mime = (part.mimeType ?? "").toLowerCase();
  if (mime.startsWith("multipart/")) for (const p of part.parts ?? []) textParts(p, type, out);
  else if (mime === type && !part.filename && !part.body?.attachmentId) out.push(part);
  return out;
}

export function plainText(payload: Part): string {
  const plain = textParts(payload, "text/plain").map(decodeBody);
  const text = plain.some((t) => t.trim() !== "") ? plain.join("\n") : textParts(payload, "text/html").map((p) => htmlToText(decodeBody(p))).join("\n");
  return text
    .replace(/\r\n?/g, "\n")
    .replace(HIDDEN, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The sent time: the Date header, unless it is missing, not a date, or
// later than Google's own receipt time (a forged future date). Then the
// receipt time.
function sentTime(payload: Part, internalDate: string | undefined): string {
  const received = internalDate ? Number(internalDate) : NaN;
  const dateHeader = header(payload, "date");
  const stated = dateHeader ? Date.parse(dateHeader) : NaN;
  const ms = Number.isFinite(stated) && (!Number.isFinite(received) || stated <= received + 5 * 60_000) ? stated : received;
  if (!Number.isFinite(ms)) throw new GoogleError("google_invalid_response");
  return new Date(ms).toISOString();
}

// Any failure while reading the message, such as a charset the decoder
// does not know or a tree past the limits, is google_invalid_response.
export function parseMessage(raw: unknown): GmailMessage {
  const parsed = RawMessage.safeParse(raw);
  if (!parsed.success || !GmailMessageId.safeParse(parsed.data.id).success) throw invalid();
  const { id, threadId, internalDate } = parsed.data;
  try {
    const payload = normalizePart(parsed.data.payload, 0, { n: 0 });
    return {
      id,
      threadId: threadId ?? id,
      from: oneLine(header(payload, "from") ?? "", 200),
      subject: oneLine(header(payload, "subject") ?? "", 300),
      sentAt: sentTime(payload, internalDate),
      text: plainText(payload),
    };
  } catch (err) {
    if (err instanceof GoogleError) throw err;
    throw invalid();
  }
}

// The longest body the app imports, the same limit as a pasted message.
export const MAX_IMPORT_CHARS = 20_000;

export const gmailMessageId = (id: string) => `gmail-${id}`;

// A Gmail message as the import shape of a pasted message. The sender and
// the sent time come from the message's headers, so neither is marked as
// suggested. The subject heads the text, as a person would paste it, so a
// date given only in the subject can be quoted. The text is empty only
// when the email has neither a subject nor a body.
export function toImport(m: GmailMessage): { source: typeof GMAIL_SOURCE; message: Message } {
  const text = [m.subject ? `Subject: ${m.subject}` : "", m.text].filter((t) => t.trim() !== "").join("\n\n");
  return {
    source: GMAIL_SOURCE,
    message: { id: gmailMessageId(m.id), channel: "email", from: m.from || "Unknown sender", received_at: m.sentAt, text },
  };
}

export class Gmail {
  readonly #conn: GoogleConnection;

  constructor(connection: GoogleConnection) {
    this.#conn = connection;
  }

  async get(id: string): Promise<GmailMessage> {
    const safe = GmailMessageId.parse(id);
    const res = await this.#conn.call("gmail", `${GMAIL_API}/messages/${encodeURIComponent(safe)}?format=full`);
    if (res.status !== 200) throw apiError(res.status, res.body);
    return parseMessage(res.body);
  }

  // Likely appointment emails, newest first, at most MAX_RESULTS.
  async search(options: { days: number; senders?: readonly string[]; max?: number }): Promise<GmailMessage[]> {
    const max = Math.min(MAX_RESULTS, Math.max(1, options.max ?? MAX_RESULTS));
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set("q", appointmentQuery(options));
    url.searchParams.set("maxResults", String(max));
    const res = await this.#conn.call("gmail", url.toString());
    if (res.status !== 200) throw apiError(res.status, res.body);
    const list = z.object({ messages: z.array(z.object({ id: z.string() })).optional() }).safeParse(res.body);
    if (!list.success) throw new GoogleError("google_invalid_response");
    const ids = (list.data.messages ?? []).map((m) => m.id).filter((id) => GmailMessageId.safeParse(id).success).slice(0, max);
    const out: GmailMessage[] = [];
    for (const id of ids) out.push(await this.get(id));
    return out;
  }
}
