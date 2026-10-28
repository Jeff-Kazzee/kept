// SP12.1: "Am I booked Monday?" fell back to the fixed sentence in 2 of 3
// live runs. The cause in the code: get_schedule told the model what each
// state means in words the answer check cannot map ("You have not accepted
// it", "not settled"), and the model repeated them. These tests hold the
// failing shapes, the new wording, the answer word set off by a dash, and
// the report that keeps each replaced answer with its problems.
import { describe, expect, it } from "vitest";
import { retryMessage } from "../src/agent/agent.ts";
import { checkAnswer, type Fact, type Grounds } from "../src/agent/grounding.ts";
import { UNGROUNDED_TEXT } from "../src/agent/types.ts";
import type { SlotState } from "../src/domain/claim.ts";
import { readFixtureText } from "../src/fixtures/load.ts";
import { stateMeaning } from "../src/slots/labels.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages } from "./helpers.ts";
import { CLOCK, agentFor, fnCall, message, reply, say, sequence, services, turnOutputs } from "./agent-helpers.ts";

// The demo after m1 to m3, as get_schedule returns it.
const FACTS: Fact[] = [
  { date: "2026-11-05", time: null },
  { date: "2026-11-10", time: "14:00", state: "offered" },
  { date: "2026-11-12", time: "10:30", state: "change_proposed" },
  { date: "2026-11-13", time: "09:15", state: "offered" },
  { date: "2026-11-16", time: "13:00", state: "offered" },
  { date: "2026-11-13", time: "09:00" },
];
const grounds = (facts: Fact[] = FACTS): Grounds => ({ facts, statuses: new Set(["claim:accepted"]), today: "2026-11-05", scheduleRead: true });

async function demoCase() {
  const app = services(new EventStore(":memory:", CLOCK));
  app.kase.loadCalendar("dana.ics", readFixtureText("calendar/dana.ics"), 0);
  await acceptMessages(app.intake, ["m1", "m2", "m3"]);
  return app;
}

describe("SP12.1: the answer to Am I booked Monday?", () => {
  it("the old state meanings, repeated by the model, failed the check", () => {
    for (const text of [
      "No. Monday 11/16 1:00 PM is offered. You have not accepted it.",
      "Not yet. The office offered Monday 11/16 1:00 PM, and you have not accepted it.",
      "No. Thursday 11/12 10:30 AM is confirmed, but a change to it is proposed and not settled. Monday 11/16 1:00 PM is offered.",
    ]) {
      expect(checkAnswer(text, grounds()), text).toEqual(["state_mismatch"]);
    }
  });

  it("each state meaning get_schedule gives passes the check when repeated about a slot in that state", () => {
    const words: Record<SlotState, string> = {
      offered: "offered",
      requested: "requested",
      confirmed: "confirmed",
      change_proposed: "confirmed",
      canceled: "canceled",
      declined: "declined",
    };
    for (const state of Object.keys(words) as SlotState[]) {
      const facts: Fact[] = [{ date: "2026-11-16", time: "13:00", state }];
      const text = `Monday 11/16 1:00 PM is ${words[state]}. ${stateMeaning(state)}`;
      expect(checkAnswer(text, grounds(facts)), text).toEqual([]);
    }
    // The answers the new words lead to.
    for (const text of [
      "No. Monday 11/16 1:00 PM is offered. It is not booked until you ask for it and the office confirms.",
      "No. Thursday 11/12 10:30 AM is confirmed, and the office proposed a change to it. Monday 11/16 1:00 PM is offered.",
    ]) {
      expect(checkAnswer(text, grounds()), text).toEqual([]);
    }
  });

  it("an answer word set off by a dash is its own clause, and a wrong day, time or state is still caught", () => {
    expect(checkAnswer("No — Monday 11/16 1:00 PM is offered, not booked.", grounds())).toEqual([]);
    expect(checkAnswer("Not yet – Monday 11/16 1:00 PM is only offered.", grounds())).toEqual([]);
    expect(checkAnswer("No — Monday 11/16 1:00 PM is confirmed.", grounds())).toEqual(["state_mismatch"]);
    expect(checkAnswer("Yes - Monday 11/16 1:00 PM is booked.", grounds())).toEqual(["state_mismatch"]);
    expect(checkAnswer("No — Monday 11/16 3:00 PM is offered.", grounds())).toContain("ungrounded");
    expect(checkAnswer("No — Tuesday 11/16 1:00 PM is offered.", grounds())).toContain("ungrounded");
    // A dash inside a clause still keeps its negation.
    expect(checkAnswer("Thursday 11/12 10:30 AM is not — as far as I can tell — confirmed.", grounds())).toEqual(["state_mismatch"]);
  });

  it("the retry names the state words when the states did not agree", () => {
    const text = (retryMessage(["state_mismatch"]) as { content: string }).content;
    expect(text).toContain("state_mismatch");
    expect(text).toContain("offered, requested, confirmed, canceled or declined");
    expect((retryMessage(["claims_action"]) as { content: string }).content).not.toContain("state word");
  });

  it("the turn report keeps each replaced answer and its problems, and the chat stores only the fixed sentence", async () => {
    const app = await demoCase();
    const first = "No. Monday 11/16 1:00 PM is offered. You have not accepted it.";
    const second = "No. Monday 11/16 1:00 PM is offered, and you have not accepted it.";
    const model = sequence(reply(fnCall("get_schedule", {})), reply(message(first)), reply(message(second)));
    const agent = agentFor(app, model);
    const r = await say(agent, app, "Am I booked Monday?");
    expect(r.report.outcome).toBe("ungrounded");
    expect(r.report.rejected).toEqual([
      { text: first, problems: ["state_mismatch"] },
      { text: second, problems: ["state_mismatch"] },
    ]);
    expect(r.text).toBe(UNGROUNDED_TEXT);
    expect(JSON.stringify(app.store.readAll())).not.toContain("You have not accepted it");
    // The schedule the model read gives the new meaning.
    const schedule = turnOutputs(model.calls[1]!.body.input).find((o) => o.name === "get_schedule")!.output;
    const mon = schedule.appointments.find((a: { slot_key: string }) => a.slot_key === "2026-11-16T13:00");
    expect(mon.state_meaning).toBe("The office offered this time. It is not booked until you ask for it and the office confirms.");
    // SP12.2: the tool and both checks are timed.
    expect(r.report.timings.tools.map((t) => t.tool)).toEqual(["get_schedule"]);
    expect(r.report.timings.checks).toHaveLength(2);
  });
});
