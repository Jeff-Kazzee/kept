import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { quoteAppearsIn } from "../src/domain/quote.ts";
import { checkSlotValues, isValidDate, isValidEventTime, isValidTime, mentionsIn } from "../src/domain/datetime.ts";
import { parseIcs, IcsParseError } from "../src/domain/ics.ts";
import { fromPackage } from "../src/paths.ts";

describe("quote check", () => {
  const source = "Hi Dana,\n\nThis confirms your appointment on Thursday,  November 12 at 10:30 AM.";

  it("accepts a verbatim quote and normalizes only whitespace", () => {
    expect(quoteAppearsIn("Thursday, November 12 at 10:30 AM", source)).toBe(true);
    expect(quoteAppearsIn("Hi Dana, This confirms", source)).toBe(true);
  });

  it("rejects changed case, punctuation, words and empty quotes", () => {
    expect(quoteAppearsIn("thursday, November 12 at 10:30 AM", source)).toBe(false);
    expect(quoteAppearsIn("Thursday November 12 at 10:30 AM", source)).toBe(false);
    expect(quoteAppearsIn("Thursday, November 12 at 10:30 am", source)).toBe(false);
    expect(quoteAppearsIn("Thursday, November 12 at 10:30 AM at our office", source)).toBe(false);
    expect(quoteAppearsIn("   ", source)).toBe(false);
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

  it("reads dates, weekdays and times from a quote", () => {
    const m = mentionsIn("Can you do Friday 11/13 at 9:15 AM or Monday 11/16 at 1:00 PM instead?");
    expect([...m.monthDays]).toEqual(["11-13", "11-16"]);
    expect([...m.weekdays].sort()).toEqual([1, 5]);
    expect([...m.times]).toEqual(["09:15", "13:00"]);
    expect(mentionsIn("at noon on Nov. 3rd, 2026").times.has("12:00")).toBe(true);
    expect(mentionsIn("at noon on Nov. 3rd, 2026").years.has(2026)).toBe(true);
  });

  it("passes values that match the quote", () => {
    expect(
      checkSlotValues({ date: "2026-11-10", time: "14:00", event_time: null, quote: "Tuesday, November 10 at 2:00 PM" }),
    ).toEqual([]);
    expect(checkSlotValues({ date: null, time: null, event_time: null, quote: "Please bring your new insurance card" })).toEqual([]);
  });

  it("rejects values that contradict the quote", () => {
    const quote = "Tuesday, November 10 at 2:00 PM";
    expect(checkSlotValues({ date: "2026-11-11", time: "14:00", event_time: null, quote })).toContain("date_not_in_quote");
    expect(checkSlotValues({ date: "2026-11-10", time: "02:00", event_time: null, quote })).toEqual(["time_not_in_quote"]);
    expect(checkSlotValues({ date: "2027-11-10", time: "14:00", event_time: null, quote })).toEqual(["weekday_mismatch"]);
  });

  it("rejects a time read from a bare clock value without AM or PM", () => {
    expect(checkSlotValues({ date: null, time: "14:00", event_time: null, quote: "come in at 2:00 on Tuesday" })).toEqual([
      "ambiguous_time",
    ]);
    expect(checkSlotValues({ date: null, time: "14:00", event_time: null, quote: "come in at 14:00" })).toEqual([]);
  });

  it("rejects invalid formats instead of repairing them", () => {
    expect(checkSlotValues({ date: "Nov 10", time: "2pm", event_time: "last week", quote: "x" })).toEqual([
      "invalid_date",
      "invalid_time",
      "invalid_event_time",
    ]);
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
