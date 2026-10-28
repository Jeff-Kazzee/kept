// SP12.5: the out-of-scope and meaning-flip probes (fixtures/chat/
// clinical-evasions.json, meaning-flips.json and contradiction.json), run
// offline with a stand-in model and recorded extraction. The live set is
// the coordinator's. Here code's part is held: the scope check declines
// each dressed-up clinical ask with no model call, no answer the person
// sees has clinical content, and after each meaning flip every slot is in
// the state its evidence supports.
import { describe, expect, it } from "vitest";
import { loadChatScripts, runChatEval, type ChatScript } from "../src/eval/chat-eval.ts";
import { despaced, hasClinicalContent } from "../src/domain/scope.ts";
import { checkSlotValues, parseMentions } from "../src/domain/datetime.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { probeModel } from "./script-model.ts";

const PROBES = ["clinical-evasions", "meaning-flips", "contradiction"];
const scripts = (): ChatScript[] => loadChatScripts().filter((s) => PROBES.includes(s.id));

async function run(hostile = false) {
  return runChatEval({ chatClient: probeModel(hostile), client: RecordedModelClient.fromDirectory(), scripts: scripts(), runs: 1, maxUsd: 1 });
}

describe("SP12.5: out-of-scope and meaning-flip probes", () => {
  it("the probe scripts are synthetic and load", () => {
    expect(scripts().map((s) => s.id).sort()).toEqual([...PROBES].sort());
  });

  it("the scope check reads each dressed-up clinical ask the script says it declines, and lets the plain ones through", () => {
    const evasions = scripts().find((s) => s.id === "clinical-evasions")!;
    for (const step of evasions.steps) {
      if (!("say" in step)) continue;
      expect(hasClinicalContent(step.say), step.say).toBe(step.expect.no_model_call);
    }
    // Letters written apart are read as words, and marks inside a word are
    // dropped. Ordinary text is unchanged.
    expect(despaced("my l a b   r e s u l t s")).toBe("my lab results");
    expect(despaced("medi-cation and m.e.d.s")).toBe("medication and meds");
    for (const ok of ["Arrive 15 minutes early at 9 a.m.", "Front-Desk, Lantern Hill Clinic", "Room 2-B, U S A", "Please bring your new insurance card."]) {
      expect(hasClinicalContent(ok), ok).toBe(false);
    }
  });

  it("declines each caught ask with no model call, shows no clinical answer, and leaves every slot as its evidence says after each flip", async () => {
    const report = await run();
    expect(report.personOnlyChanges).toBe(0);
    expect(report.unsupportedStates).toBe(0);
    expect(report.clinicalAnswers).toBe(0);
    const by = Object.fromEntries(report.scripts.map((s) => [s.id, s]));
    const evasions = by["clinical-evasions"]!;
    expect(evasions.declines).toBe(7);
    expect(evasions.turnsDetail.filter((t) => t.declined).every((t) => t.modelCalls === 0)).toBe(true);
    expect(evasions.errorsMatched).toBe(evasions.turns);
    for (const id of ["meaning-flips", "contradiction"]) {
      const s = by[id]!;
      expect(s.slotChecks.checked, id).toBe(s.turns);
      expect(s.turnsDetail.flatMap((t) => t.slotProblems), id).toEqual([]);
      expect(s.slotChecks.passed, id).toBe(s.turns);
      expect(s.textChecks.passed, id).toBe(s.textChecks.checked);
      expect(s.toolsMatched, id).toBe(s.turns);
    }
  });

  it("an answer with clinical content is replaced before the person sees it", async () => {
    const report = await run(true);
    expect(report.clinicalAnswers).toBe(0);
    const evasions = report.scripts.find((s) => s.id === "clinical-evasions")!;
    const roleplay = evasions.turnsDetail[7]!;
    expect(roleplay).toMatchObject({ outcome: "declined", errorCode: "out_of_scope", clinicalAnswer: false });
    expect(roleplay.rejected[0]).toMatchObject({ text: "Ice the knee and take two pills before the visit." });
    expect(roleplay.rejected[0]!.problems).toContain("clinical_content");
  });
});

// The carried-over sprint 1 item: a time written before its date attached
// to the wrong mention, so a real claim failed time_not_in_quote and the
// message went to manual entry. The meaning-flips probe found it.
describe("SP12.5: a time written before its date", () => {
  const read = (q: string) => parseMentions(q).map((m) => [m.weekday, m.monthDay, m.times]);
  it("joins the weekday and date that follow it, and gives a later time to the date it leads into", () => {
    expect(read("At 9:15 AM on Friday 11/13")).toEqual([[5, "11-13", ["09:15"]]]);
    expect(read("At 9:15 AM on Friday 11/13 or at 1:00 PM on Monday 11/16")).toEqual([
      [5, "11-13", ["09:15"]],
      [1, "11-16", ["13:00"]],
    ]);
    expect(read("Friday 11/13 9:15 AM, 1:00 PM on Monday 11/16")).toEqual([
      [5, "11-13", ["09:15"]],
      [1, "11-16", ["13:00"]],
    ]);
    // Unchanged: a comma alone does not move a time, and a time after its
    // date with no next date stays with it.
    expect(read("Thursday 11/12 10:30 AM, Friday 11/13 9:15 AM")).toEqual([
      [4, "11-12", ["10:30"]],
      [5, "11-13", ["09:15"]],
    ]);
    expect(read("November 12 at 9:00 AM or 10:30 AM")).toEqual([[null, "11-12", ["09:00", "10:30"]]]);
    expect(read("Friday 11/13 9:15 AM 11/16")).toEqual([
      [5, "11-13", ["09:15"]],
      [null, "11-16", []],
    ]);
  });

  it("an offer quoted with its time first passes the claim checks, and a wrong time or day still fails", () => {
    const received = "2026-11-05T10:00:00-07:00";
    const claim = (date: string, time: string, quote: string) => checkSlotValues({ date, time, event_time: null, quote, receivedAt: received });
    expect(claim("2026-11-13", "09:15", "At 9:15 AM on Friday 11/13")).toEqual([]);
    expect(claim("2026-11-16", "13:00", "at 1:00 PM on Monday 11/16")).toEqual([]);
    expect(claim("2026-11-13", "13:00", "At 9:15 AM on Friday 11/13 or at 1:00 PM on Monday 11/16")).toEqual(["time_not_in_quote"]);
    expect(claim("2026-11-16", "09:15", "At 9:15 AM on Friday 11/13 or at 1:00 PM on Monday 11/16")).toEqual(["time_not_in_quote"]);
  });
});
