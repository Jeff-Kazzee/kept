import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { phraseAppearsIn, quoteAppearsIn, wordsAppearIn } from "../src/domain/quote.ts";
import { checkSlotValues, isValidDate, isValidEventTime, isValidTime, parseMentions } from "../src/domain/datetime.ts";
import { parseIcs, IcsParseError } from "../src/domain/ics.ts";
import { fromPackage } from "../src/paths.ts";

const M1_TEXT =
  "Lantern Hill Clinic: Hi Dana, we can see you Tuesday, November 10 at 2:00 PM or Thursday, November 12 at 10:30 AM at our Elm Street office. Reply 1 or 2.";
const M1_RECEIVED = "2026-10-30T15:04:00-06:00";
const check = (date: string | null, time: string | null, quote: string, event_time: string | null = null) =>
  checkSlotValues({ date, time, event_time, quote, receivedAt: M1_RECEIVED });

describe("quote check", () => {
  const source = "Hi Dana,\n\nThis confirms your appointment on Thursday,  November 12 at 10:30 AM.";

  it("accepts a verbatim quote and normalizes only whitespace", () => {
    expect(quoteAppearsIn("Thursday, November 12 at 10:30 AM", source)).toBe(true);
    expect(quoteAppearsIn("Hi Dana, This confirms", source)).toBe(true);
    expect(quoteAppearsIn("10:30 AM.", source)).toBe(true);
  });

  it("rejects changed case, punctuation, words and empty quotes", () => {
    expect(quoteAppearsIn("thursday, November 12 at 10:30 AM", source)).toBe(false);
    expect(quoteAppearsIn("Thursday November 12 at 10:30 AM", source)).toBe(false);
    expect(quoteAppearsIn("Thursday, November 12 at 10:30 am", source)).toBe(false);
    expect(quoteAppearsIn("Thursday, November 12 at 10:30 AM at our office", source)).toBe(false);
    expect(quoteAppearsIn("   ", source)).toBe(false);
  });

  it("rejects fragments that do not start and end on word boundaries", () => {
    expect(quoteAppearsIn("uesda", M1_TEXT)).toBe(false);
    expect(quoteAppearsIn("Tuesday, November 1", M1_TEXT)).toBe(false);
    expect(quoteAppearsIn("Tuesday", M1_TEXT)).toBe(true);
  });

  it("matches locations as whole runs of words and request items by their words", () => {
    expect(phraseAppearsIn("Elm Street office", M1_TEXT)).toBe(true);
    expect(phraseAppearsIn("Oak Avenue clinic", M1_TEXT)).toBe(false);
    expect(phraseAppearsIn("Elm Street offic", M1_TEXT)).toBe(false);
    expect(wordsAppearIn("Bring new insurance card", "Please bring your new insurance card")).toBe(true);
    expect(wordsAppearIn("bring a passport", "Please bring your new insurance card")).toBe(false);
  });
});

describe("date and time values", () => {
  it("accepts only strict formats and real calendar dates", () => {
    expect(isValidDate("2026-11-12")).toBe(true);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-11-31")).toBe(false);
    expect(isValidDate("11/12/2026")).toBe(false);
    expect(isValidTime("09:15")).toBe(true);
    expect(isValidTime("9:15")).toBe(false);
    expect(isValidTime("2:00 PM")).toBe(false);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidEventTime("2026-11-05T12:10:00-07:00")).toBe(true);
    expect(isValidEventTime("2026-11-05")).toBe(true);
    expect(isValidEventTime("yesterday")).toBe(false);
  });

  it("groups each date with its own weekday and time", () => {
    expect(parseMentions("Can you do Friday 11/13 at 9:15 AM or Monday 11/16 at 1:00 PM instead?")).toEqual([
      { monthDay: "11-13", year: null, weekday: 5, time: "09:15", ambiguousTimes: [] },
      { monthDay: "11-16", year: null, weekday: 1, time: "13:00", ambiguousTimes: [] },
    ]);
    expect(parseMentions("at noon on Nov. 3rd, 2026")).toEqual([
      { monthDay: "11-03", year: 2026, weekday: null, time: "12:00", ambiguousTimes: [] },
    ]);
    expect(parseMentions("They moved me to Monday")).toEqual([
      { monthDay: null, year: null, weekday: 1, time: null, ambiguousTimes: [] },
    ]);
  });

  it("passes values that match one mention in the quote", () => {
    expect(check("2026-11-10", "14:00", "Tuesday, November 10 at 2:00 PM")).toEqual([]);
    expect(check("2026-11-12", "10:30", M1_TEXT)).toEqual([]);
    expect(check(null, null, "Please bring your new insurance card")).toEqual([]);
  });

  it("rejects values that contradict the quote", () => {
    const quote = "Tuesday, November 10 at 2:00 PM";
    expect(check("2026-11-11", "14:00", quote)).toContain("date_not_in_quote");
    expect(check("2026-11-10", "02:00", quote)).toEqual(["time_not_in_quote"]);
    expect(check("2027-11-10", "14:00", quote)).toEqual(["weekday_mismatch"]);
    expect(check("2028-11-10", "14:00", "November 10 at 2:00 PM")).toEqual(["date_year_mismatch"]);
  });

  it("finding 1: rejects a date or time the quote does not state", () => {
    expect(check("2026-11-17", "09:00", "Tuesday")).toEqual(["date_outside_window", "time_not_in_quote"]);
    expect(check("2026-11-10", null, "Please bring your new insurance card")).toEqual(["date_not_in_quote"]);
    expect(check(null, "14:00", "Please bring your new insurance card")).toEqual(["time_not_in_quote"]);
  });

  it("resolves a weekday alone only within the window after arrival", () => {
    const received = "2026-11-05T12:10:00-07:00";
    const quote = "They moved me to Monday";
    expect(checkSlotValues({ date: "2026-11-16", time: null, event_time: null, quote, receivedAt: received })).toEqual([]);
    expect(checkSlotValues({ date: "2026-11-23", time: null, event_time: null, quote, receivedAt: received })).toEqual([
      "date_outside_window",
    ]);
    expect(checkSlotValues({ date: "2026-11-02", time: null, event_time: null, quote, receivedAt: received })).toEqual([
      "date_outside_window",
    ]);
    expect(checkSlotValues({ date: "2026-11-17", time: null, event_time: null, quote, receivedAt: received })).toEqual([
      "date_not_in_quote",
    ]);
  });

  it("finding 2: rejects a date and time taken from two different mentions", () => {
    expect(check("2026-11-10", "10:30", M1_TEXT)).toEqual(["time_not_in_quote"]);
    expect(check("2026-11-12", "14:00", M1_TEXT)).toEqual(["time_not_in_quote"]);
  });

  it("finding 3: rejects an event time the quote does not state", () => {
    expect(check(null, null, "Tuesday, November 10 at 2:00 PM", "2026-11-03T09:00:00-07:00")).toEqual([
      "event_time_not_in_quote",
    ]);
    expect(check(null, null, "Tuesday, November 10 at 2:00 PM", "2026-11-10T14:00:00-07:00")).toEqual([]);
    expect(check(null, null, "Tuesday, November 10 at 2:00 PM", "2026-11-10T15:00:00-07:00")).toEqual([
      "event_time_not_in_quote",
    ]);
  });

  it("rejects a time read from a bare clock value without AM or PM", () => {
    expect(check(null, "14:00", "come in at 2:00 on Tuesday")).toEqual(["ambiguous_time"]);
    expect(check(null, "14:00", "come in at 14:00")).toEqual([]);
  });

  it("rejects invalid formats instead of repairing them", () => {
    expect(check("Nov 10", "2pm", "x", "last week")).toEqual(["invalid_date", "invalid_time", "invalid_event_time"]);
  });
});

describe("ics parser", () => {
  it("reads the synthetic calendar", () => {
    const events = parseIcs(readFileSync(fromPackage("fixtures/calendar/dana.ics"), "utf8"));
    expect(events).toHaveLength(6);
    const friday = events.find((e) => e.start.date === "2026-11-13");
    expect(friday).toMatchObject({
      summary: "Team meeting",
      start: { time: "09:00", tzid: "America/Denver", utc: false },
      end: { time: "10:00" },
    });
  });

  it("unfolds lines, unescapes text, skips alarms and flags recurrence", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART:20261102T160000Z",
      "SUMMARY:Call with\\, Sam",
      "  and Lee",
      "RRULE:FREQ=WEEKLY",
      "BEGIN:VALARM",
      "SUMMARY:alarm text",
      "END:VALARM",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20261101",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [allDay, call] = parseIcs(ics);
    expect(allDay).toMatchObject({ start: { date: "2026-11-01", time: null } });
    expect(call).toMatchObject({ summary: "Call with, Sam and Lee", recurring: true, start: { utc: true, time: "16:00" } });
  });

  it("rejects files that are not calendars", () => {
    expect(() => parseIcs("hello")).toThrow(IcsParseError);
    expect(() => parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR")).toThrow(/DTSTART/);
  });
});
