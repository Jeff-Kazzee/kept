// Input rules for record writes. The app, the in-app agent and the MCP
// server all validate with these schemas, so an agent gets no looser rules
// than the person.
import { z } from "zod";
import { isValidDate, isValidTime } from "../domain/datetime.ts";

export const MAX_NOTE_CHARS = 2_000;
export const MAX_TAGS = 20;
export const MAX_TAG_CHARS = 40;

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
