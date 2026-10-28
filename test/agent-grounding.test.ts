// The checks on the agent's final text (G4, G5) and the fact chips, as
// units.
import { describe, expect, it } from "vitest";
import { checkAnswer, chipLabel, chipsFor, claimsAction, grounded, type Fact } from "../src/agent/grounding.ts";
import { caseLocal } from "../src/agent/tools.ts";
import type { SlotView } from "../src/slots/types.ts";

const FACTS: Fact[] = [
  { date: "2026-11-12", time: "10:30" },
  { date: "2026-11-13", time: "09:15" },
  { date: "2026-11-13", time: "09:00" },
  { date: "2026-11-16", time: "13:00" },
  { date: "2026-11-20", time: null },
];

describe("grounding", () => {
  it("passes dates, weekdays and times that match one fact as a unit", () => {
    for (const ok of [
      "Monday 11/16 1:00 PM is offered.",
      "Your Thursday, November 12 visit at 10:30 AM is confirmed.",
      "Friday 11/13 9:15 AM overlaps the meeting at 9:00 AM.",
      "It is on Friday.",
      "The office asked you to arrive 15 minutes early.",
      "Nothing has a date.",
      "Friday 11/20 has no time yet.",
    ]) {
      expect(grounded(ok, FACTS), ok).toBe(true);
    }
  });

  it("fails a date, weekday or time that no fact holds, or a time that does not fit its date", () => {
    for (const bad of [
      "Monday 11/16 at 3:00 PM.",
      "Wednesday works.",
      "Thursday 11/12 at 1:00 PM.",
      "November 16, 2027 at 1:00 PM.",
      "Friday 11/20 at 9:00 AM.", // that slot has no known time
      "Tuesday 11/12.", // 11/12 is a Thursday
    ]) {
      expect(grounded(bad, FACTS), bad).toBe(false);
    }
  });

  it("reads fullwidth digits and hidden characters as the scope check does", () => {
    expect(checkAnswer("Monday 11/16 at ３:００ PM.", FACTS)).toEqual(["ungrounded"]);
    expect(checkAnswer("Monday 11/16 at 3:​00 PM.", FACTS)).toEqual(["ungrounded"]);
    expect(checkAnswer("I​ accepted it.", FACTS)).toEqual(["claims_action"]);
    expect(checkAnswer("​ ", FACTS)).toEqual(["empty"]);
  });

  it("finds claims that the agent changed the schedule, and leaves statements about the case alone", () => {
    for (const t of ["I accepted every claim.", "I've cancelled Thursday.", "I have sent the reply.", "I just booked Monday.", "I already approved it."]) {
      expect(claimsAction(t), t).toBe(true);
    }
    for (const t of ["Thursday is canceled by the office.", "You accepted the claim.", "I can draft a reply.", "I cannot cancel appointments."]) {
      expect(claimsAction(t), t).toBe(false);
    }
  });

  it("flags clinical text and answers that run too long", () => {
    expect(checkAnswer("Bring your medication list.", FACTS)).toEqual(["clinical_content"]);
    expect(checkAnswer("Fine. ".repeat(300), FACTS)).toEqual(["ungrounded"]);
  });
});

describe("chips", () => {
  const slot = (key: string, state = "offered"): SlotView =>
    ({
      key,
      date: key.slice(0, 10),
      time: key.length > 10 ? key.slice(11) : null,
      stateLabel: `${state[0]!.toUpperCase()}${state.slice(1)} · office message`,
      evidenceIds: [`e-${key}`],
    }) as SlotView;

  it("names the slots the text mentions, or all slots from the tools when it names none", () => {
    const slots = [slot("2026-11-13T09:15"), slot("2026-11-16T13:00"), slot("2026-11-16T13:00"), slot("2026-11-20")];
    expect(chipsFor(slots, "Monday 11/16 1:00 PM is offered.")).toEqual([
      { slotKey: "2026-11-16T13:00", label: "Mon 11/16 1:00 PM", stateLabel: "Offered · office message", evidenceIds: ["e-2026-11-16T13:00"] },
    ]);
    expect(chipsFor(slots, "Nothing is booked yet.").map((c) => c.slotKey)).toEqual(["2026-11-13T09:15", "2026-11-16T13:00", "2026-11-20"]);
    expect(chipsFor(slots, null)).toHaveLength(3);
    expect(chipLabel("2026-11-20", null)).toBe("Fri 11/20");
  });
});

describe("calendar times in America/Denver", () => {
  it("converts UTC and other zones to Denver wall-clock time across the 2026-11-01 change", () => {
    expect(caseLocal({ date: "2026-10-31", time: "15:00", tzid: null, utc: true })).toEqual({ date: "2026-10-31", time: "09:00" });
    expect(caseLocal({ date: "2026-11-02", time: "15:00", tzid: null, utc: true })).toEqual({ date: "2026-11-02", time: "08:00" });
    expect(caseLocal({ date: "2026-11-13", time: "09:00", tzid: "America/Denver", utc: false })).toEqual({ date: "2026-11-13", time: "09:00" });
    expect(caseLocal({ date: "2026-11-13", time: "11:00", tzid: "America/New_York", utc: false })).toEqual({ date: "2026-11-13", time: "09:00" });
    expect(caseLocal({ date: "2026-11-14", time: "05:30", tzid: null, utc: true })).toEqual({ date: "2026-11-13", time: "22:30" });
    expect(caseLocal({ date: "2026-11-13", time: null, tzid: null, utc: false })).toEqual({ date: "2026-11-13", time: null });
  });
});
