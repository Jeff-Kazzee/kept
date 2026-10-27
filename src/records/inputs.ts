// Input rules for record writes and proposals. The app and the MCP server
// both validate with these schemas, so an agent gets no looser rules than
// the user. Date and time use the same format checks as a manual entry. An
// agent report has no event time, the same as a manual entry, so slot order
// falls back to when the agent reported it.
import { z } from "zod";
import { ClaimType } from "../domain/claim.ts";
import { checkSlotFormats, isValidDate, isValidTime } from "../domain/datetime.ts";

export const MAX_NOTE_CHARS = 2_000;
export const MAX_TAGS = 20;
export const MAX_TAG_CHARS = 40;
export const MAX_STATEMENT_CHARS = 500;

// Control characters other than tab and newline, and the Unicode marks that
// reorder or hide text.
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;
const noHidden = (s: string) => !HIDDEN.test(s);

// A slot key: YYYY-MM-DD, or YYYY-MM-DDTHH:MM.
export const AppointmentId = z
  .string()
  .max(16)
  .refine((s) => {
    const [date, time] = s.split("T");
    return isValidDate(date ?? "") && (time === undefined || isValidTime(time)) && s.split("T").length <= 2;
  }, "An appointment id is a date (YYYY-MM-DD) or a date and time (YYYY-MM-DDTHH:MM).");

export const ExpectedVersion = z.number().int().nonnegative();

export const NoteText = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NOTE_CHARS)
  .refine(noHidden, "The text contains control characters.");

export const Tag = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TAG_CHARS)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, "A tag uses letters, digits, spaces, _ and - only.");

// Tags are compared without case and kept in the order given, without
// repeats.
export const Tags = z
  .array(Tag)
  .max(MAX_TAGS)
  .transform((tags) => {
    const seen = new Set<string>();
    return tags.filter((t) => {
      const key = t.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

const Statement = z
  .string()
  .trim()
  .min(1)
  .max(MAX_STATEMENT_CHARS)
  .refine(noHidden, "The statement contains control characters.");
const Place = z.string().trim().min(1).max(300).refine(noHidden, "The place contains control characters.");
const Item = z.string().trim().min(1).max(300).refine(noHidden, "The item contains control characters.");
const DateString = z.string().refine((s) => checkSlotFormats({ date: s, time: null, event_time: null }).length === 0, "Use YYYY-MM-DD.");
const TimeString = z.string().refine((s) => checkSlotFormats({ date: null, time: s, event_time: null }).length === 0, "Use 24-hour HH:MM.");

export const ProposedChangeInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("new_appointment"),
      date: DateString,
      time: TimeString,
      location: Place.nullable().default(null),
      status: z.enum(["offered", "confirmed"]),
      statement: Statement,
    })
    .strict(),
  z
    .object({
      kind: z.literal("user_report"),
      claim_type: ClaimType,
      date: DateString.nullable(),
      time: TimeString.nullable().default(null),
      location: Place.nullable().default(null),
      request_item: Item.nullable().default(null),
      statement: Statement,
    })
    .strict()
    .refine((c) => c.claim_type !== "office_request" || c.request_item !== null, {
      message: "An office request needs the item to bring or the task to do.",
      path: ["request_item"],
    })
    .refine((c) => c.claim_type === "office_request" || c.date !== null, {
      message: "A report about a slot needs its date.",
      path: ["date"],
    }),
  z
    .object({
      kind: z.literal("detail_edit"),
      appointment_id: AppointmentId,
      expected_version: ExpectedVersion,
      location: Place,
      statement: Statement,
    })
    .strict(),
  z
    .object({
      kind: z.literal("archive"),
      appointment_id: AppointmentId,
      expected_version: ExpectedVersion,
      statement: Statement,
    })
    .strict(),
]);
export type ProposedChangeInput = z.input<typeof ProposedChangeInput>;
