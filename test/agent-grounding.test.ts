// The checks on the agent's final text (G4, G5, review round 1 findings 3,
// 4 and 6) and the fact chips, as units.
import { describe, expect, it } from "vitest";
import { canonicalDates } from "../src/agent/dates.ts";
import { checkAnswer, chipLabel, chipsFor, claimsAction, grounded, statesAgree, type Fact, type Grounds, type Status } from "../src/agent/grounding.ts";
import { caseLocal } from "../src/agent/tools.ts";
import type { SlotView } from "../src/slots/types.ts";

// The demo after m1 to m3: Thursday confirmed with a change proposed, the
// other three offered, and the team meeting on Friday at 9:00 AM.
const FACTS: Fact[] = [
  { date: "2026-11-10", time: "14:00", state: "offered" },
  { date: "2026-11-12", time: "10:30", state: "change_proposed" },
  { date: "2026-11-13", time: "09:15", state: "offered" },
  { date: "2026-11-16", time: "13:00", state: "offered" },
  { date: "2026-11-13", time: "09:00" },
  { date: "2026-11-20", time: null },
];
const TODAY = "2026-11-05";
const grounds = (facts: Fact[] = FACTS, statuses: Status[] = ["claim:accepted"], scheduleRead = true): Grounds => ({ facts, statuses: new Set(statuses), today: TODAY, scheduleRead });

describe("grounding of dates and times", () => {
  it("passes dates, weekdays and times that match one fact as a unit", () => {
    for (const ok of [
      "Monday 11/16 1:00 PM is offered.",
      "Your Thursday, November 12 visit at 10:30 AM is confirmed.",
      "Friday 11/13 9:15 AM overlaps the meeting at 9:00 AM.",
      "It is on Friday.",
      "The office asked you to arrive 15 minutes early.",
      "Nothing has a date.",
      "Friday 11/20 has no time yet.",
      "You may bring your card. I am glad to help.",
    ]) {
      expect(grounded(ok, FACTS, TODAY), ok).toBe(true);
    }
  });

  it("fails a date, weekday or time that no fact holds, or a time that does not fit its date", () => {
    for (const bad of ["Monday 11/16 at 3:00 PM.", "Wednesday works.", "Thursday 11/12 at 1:00 PM.", "November 16, 2027 at 1:00 PM.", "Friday 11/20 at 9:00 AM.", "Tuesday 11/12."]) {
      expect(grounded(bad, FACTS, TODAY), bad).toBe(false);
    }
  });

  it("finding 4: reads spelled, ordinal, day-month, other-digit, relative and markdown forms, and checks them", () => {
    const readable: Array<[string, boolean]> = [
      ["See you on the 16th at one in the afternoon.", true],
      ["See you on the 16th at three in the afternoon.", false],
      ["16 November at 1:00 PM is offered.", true],
      ["16 November at 2:00 PM is offered.", false],
      ["The sixteenth of November at half past one is open.", false],
      ["November sixteenth at one o'clock pm is offered.", true],
      ["Monday ١١/١٦ at ١:٠٠ PM is offered.", true],
      ["Monday ١١/١٧ at ١:٠٠ PM is offered.", false],
      ["Monday १६ November at 1:00 PM.", true],
      ["**11**/16 at `1:00 PM` is offered.", true],
      ["**11**/17 at `1:00 PM` is offered.", false],
      ["Monday 11/16 at 3:​00 PM.", false],
      ["Monday 11/16 at ３:００ PM.", false],
      ["Next Monday at 1:00 PM is offered.", false], // next Monday from Thursday 11/5 is 11/9
      ["Tomorrow at 1:00 PM works.", false],
      ["Today is Thursday 11/5.", false], // no fact for today in this set
    ];
    for (const [text, ok] of readable) expect(grounded(text, FACTS, TODAY), text).toBe(ok);
    // With today's date among the facts, today and tomorrow resolve.
    expect(grounded("Today is Thursday 11/5.", [...FACTS, { date: TODAY, time: null }], TODAY)).toBe(true);
    expect(grounded("Tomorrow is Friday 11/6.", [...FACTS, { date: "2026-11-06", time: null }], TODAY)).toBe(true);
  });

  it("finding 4: a time with no date of its own needs a date in its sentence or the facts' single date", () => {
    expect(grounded("At 1:00 PM on Monday 11/16.", FACTS, TODAY)).toBe(true);
    expect(grounded("1:00 PM works.", FACTS, TODAY)).toBe(false);
    expect(grounded("1:00 PM works.", [{ date: "2026-11-16", time: "13:00", state: "offered" }], TODAY)).toBe(true);
    expect(grounded("Monday 11/16 is offered. It starts at 1:00 PM.", FACTS, TODAY)).toBe(false);
  });

  it("finding 4: fails closed on date-like text it cannot read", () => {
    for (const text of ["See you at 1.", "It is in November.", "Come the day before.", "Next week works.", "It starts at 13h00.", "Monday at 1.00 pm.", "It is on 11-16."]) {
      expect(canonicalDates(text, TODAY).unreadable.length > 0 || !grounded(text, FACTS, TODAY), text).toBe(true);
    }
    // A day alone resolves when the facts hold exactly one date with that day.
    expect(grounded("It is on the 16th.", FACTS, TODAY)).toBe(true);
    expect(grounded("It is on the 13th.", FACTS, TODAY)).toBe(true);
    expect(grounded("It is on the 13th.", [...FACTS, { date: "2026-12-13", time: null }], TODAY)).toBe(false);
  });
});

describe("finding 3: states agree with the slots", () => {
  it("rejects a state the slot is not in, and passes the true one", () => {
    const cases: Array<[string, boolean]> = [
      ["Monday 11/16 1:00 PM is confirmed.", false],
      ["Monday 11/16 1:00 PM is booked.", false],
      ["Monday 11/16 1:00 PM is requested.", false],
      ["Monday 11/16 1:00 PM is offered.", true],
      ["Thursday 11/12 10:30 AM is confirmed.", true],
      ["Thursday 11/12 10:30 AM has been canceled.", false],
      ["Thursday 11/12 10:30 AM is not canceled.", true],
      ["Monday 11/16 1:00 PM is not confirmed yet.", true],
      ["Thursday 11/12 10:30 AM isn't confirmed.", false],
      ["Monday 11/16 1:00 PM is offered. It is confirmed.", false],
      ["Monday 11/16 1:00 PM is offered. The office has not confirmed it yet.", true],
      ["Thursday 11/12 10:30 AM is confirmed, but Monday 11/16 1:00 PM is only offered.", true],
      ["Thursday 11/12 10:30 AM is confirmed and Monday 11/16 1:00 PM is confirmed.", false],
      ["Was Monday 11/16 1:00 PM confirmed?", true],
      ["Thursday 11/12 10:30 AM was moved.", false],
    ];
    for (const [text, ok] of cases) expect(statesAgree(text, grounds()), text).toBe(ok);
  });

  it("a state with no slot named needs a slot in that state among the facts", () => {
    expect(statesAgree("You are confirmed.", grounds())).toBe(true); // Thursday is
    expect(statesAgree("You are requested.", grounds())).toBe(false);
    expect(statesAgree("You are confirmed.", grounds([{ date: "2026-11-16", time: "13:00", state: "offered" }]))).toBe(false);
    expect(statesAgree("You are confirmed.", grounds([]))).toBe(false);
    expect(statesAgree("Nothing is confirmed yet.", grounds([], [], true))).toBe(true);
    expect(statesAgree("Nothing is confirmed yet.", grounds([], [], false))).toBe(false);
  });

  it("finding 6: passive and first-person claims about the case are checked or refused", () => {
    expect(statesAgree("Thursday has been canceled.", grounds())).toBe(false);
    expect(statesAgree("Your claims were accepted.", grounds(FACTS, []))).toBe(false);
    expect(statesAgree("Your claims were accepted.", grounds(FACTS, ["claim:accepted"]))).toBe(true);
    expect(statesAgree("Your reply was sent.", grounds(FACTS, ["claim:accepted"]))).toBe(false);
    expect(statesAgree("Your reply was sent.", grounds(FACTS, ["reply:sent"]))).toBe(true);
    expect(statesAgree("The draft was approved.", grounds(FACTS, []))).toBe(false);
    expect(statesAgree("None of the claims is accepted yet.", grounds(FACTS, []))).toBe(true);
    for (const t of [
      "I accepted every claim.",
      "I've just canceled Thursday.",
      "I did cancel it.",
      "We canceled Thursday.",
      "I have sent the reply.",
      "I just booked Monday.",
      "I already approved it.",
      "We've gone ahead and rescheduled it.",
    ]) {
      expect(claimsAction(t), t).toBe(true);
    }
    for (const t of ["Thursday is canceled by the office.", "You accepted the claim.", "I can draft a reply.", "I cannot cancel appointments."]) {
      expect(claimsAction(t), t).toBe(false);
    }
  });

  it("0009 design 5: a first-person claim must match an action of this turn, and approving, sending or canceling never does", () => {
    const done = (...kinds: string[]) => new Set(kinds);
    expect(claimsAction("I imported the message.")).toBe(true);
    expect(claimsAction("I imported the message.", done("message_imported"))).toBe(false);
    expect(claimsAction("I accepted every claim.", done("message_imported"))).toBe(true);
    expect(claimsAction("I accepted every claim.", done("claim_accepted"))).toBe(false);
    expect(claimsAction("I've rejected the offer.", done("claim_accepted"))).toBe(true);
    expect(claimsAction("I answered the question.", done("question_answered"))).toBe(false);
    expect(claimsAction("I archived Tuesday.", done("appointment_archived"))).toBe(false);
    expect(claimsAction("I undid that.", done("undo"))).toBe(false);
    expect(claimsAction("I updated your schedule.", done())).toBe(true);
    expect(claimsAction("I updated your schedule.", done("claim_accepted"))).toBe(false);
    const all = done("message_imported", "claim_accepted", "claim_rejected", "question_answered", "appointment_archived", "draft_started", "undo", "timezone_set");
    for (const t of ["I sent the reply.", "I approved the draft.", "I confirmed Monday.", "I canceled Thursday.", "I booked Monday.", "I rescheduled it.", "I deleted the case."]) {
      expect(claimsAction(t, all), t).toBe(true);
    }
  });
});

describe("checkAnswer", () => {
  it("reads fullwidth digits and hidden characters as the scope check does", () => {
    expect(checkAnswer("Monday 11/16 at ３:００ PM.", grounds())).toEqual(["ungrounded"]);
    expect(checkAnswer("I​ accepted it.", grounds())).toEqual(["claims_action"]);
    expect(checkAnswer("​ ", grounds())).toEqual(["empty"]);
  });

  it("flags clinical text, including preparation advice, and answers that run too long", () => {
    expect(checkAnswer("Bring your medication list.", grounds())).toEqual(["clinical_content"]);
    // Midnight is also a time with no date behind it.
    expect(checkAnswer("Fast after midnight and drink only water.", grounds())).toEqual(["clinical_content", "ungrounded"]);
    expect(checkAnswer("Fine. ".repeat(300), grounds())).toEqual(["ungrounded"]);
    expect(checkAnswer("Bring your insurance card and arrive 15 minutes early.", grounds())).toEqual([]);
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
    expect(chipsFor(slots, "16 November is offered.").map((c) => c.slotKey)).toEqual(["2026-11-16T13:00"]);
    expect(chipsFor(slots, "Nothing is booked yet.").map((c) => c.slotKey)).toEqual(["2026-11-13T09:15", "2026-11-16T13:00", "2026-11-20"]);
    expect(chipsFor(slots, null)).toHaveLength(3);
    expect(chipLabel("2026-11-20", null)).toBe("Fri 11/20");
  });
});

describe("calendar times in the case's time zone", () => {
  it("converts UTC and other zones to Denver wall-clock time across the 2026-11-01 change", () => {
    const local = (t: Parameters<typeof caseLocal>[0]) => caseLocal(t, "America/Denver");
    expect(local({ date: "2026-10-31", time: "15:00", tzid: null, utc: true })).toEqual({ date: "2026-10-31", time: "09:00" });
    expect(local({ date: "2026-11-02", time: "15:00", tzid: null, utc: true })).toEqual({ date: "2026-11-02", time: "08:00" });
    expect(local({ date: "2026-11-13", time: "09:00", tzid: "America/Denver", utc: false })).toEqual({ date: "2026-11-13", time: "09:00" });
    expect(local({ date: "2026-11-13", time: "11:00", tzid: "America/New_York", utc: false })).toEqual({ date: "2026-11-13", time: "09:00" });
    expect(local({ date: "2026-11-14", time: "05:30", tzid: null, utc: true })).toEqual({ date: "2026-11-13", time: "22:30" });
    expect(local({ date: "2026-11-13", time: null, tzid: null, utc: false })).toEqual({ date: "2026-11-13", time: null });
  });

  it("reads the same events in Asia/Tokyo and Europe/London, across London's 2026-10-25 change", () => {
    // 09:00 in Denver on 11/13 is 01:00 the next day in Tokyo.
    expect(caseLocal({ date: "2026-11-13", time: "09:00", tzid: "America/Denver", utc: false }, "Asia/Tokyo")).toEqual({ date: "2026-11-14", time: "01:00" });
    // A time with no zone is read in the case's zone.
    expect(caseLocal({ date: "2026-11-13", time: "09:00", tzid: null, utc: false }, "Asia/Tokyo")).toEqual({ date: "2026-11-13", time: "09:00" });
    // London is UTC+1 until 2026-10-25 01:00 UTC, then UTC+0.
    expect(caseLocal({ date: "2026-10-24", time: "12:00", tzid: null, utc: true }, "Europe/London")).toEqual({ date: "2026-10-24", time: "13:00" });
    expect(caseLocal({ date: "2026-10-26", time: "12:00", tzid: null, utc: true }, "Europe/London")).toEqual({ date: "2026-10-26", time: "12:00" });
  });
});
