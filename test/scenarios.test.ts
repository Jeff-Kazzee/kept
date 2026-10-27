// D2 acceptance: runs every D2 checkpoint in the fixtures through the real
// path. Messages go through recorded extraction and the review queue,
// questions through the recorded model and the question queue, and answers
// through the user's tap on a choice built by code.
import { describe, expect, it } from "vitest";
import type { CaseView } from "../src/case/types.ts";
import { replayCheckpoint } from "../src/eval/d2-fixtures.ts";
import { loadScenarios } from "../src/fixtures/load.ts";

const scenarios = loadScenarios().filter((s) => s.d2);

function observed(view: CaseView) {
  return {
    slots: Object.fromEntries(view.slots.map((s) => [s.key, s.stateLabel])),
    clashes: Object.fromEntries(view.slots.filter((s) => s.clashes?.length).map((s) => [s.key, s.clashes!.map((c) => c.summary)])),
    missing: Object.fromEntries(view.slots.filter((s) => s.missing.length > 0).map((s) => [s.key, s.missing])),
    stale: view.staleEvidenceIds,
    conflicts: view.conflicts.map((c) => ({ kind: c.kind, slots: c.slotKeys, evidence: c.evidenceIds, status: c.status })),
  };
}

describe("D2 checkpoints in the fixtures", () => {
  it("covers S1 to S7", () => {
    expect(scenarios.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
  });

  for (const s of scenarios) {
    s.d2!.forEach((checkpoint, i) => {
      it(`${s.id}.${i + 1}: ${checkpoint.expect}`, async () => {
        const { kase } = await replayCheckpoint(s, checkpoint);
        const view = kase.view();
        const { question, expect: _text, steps: _steps, ...expected } = checkpoint;
        expect(observed(view)).toEqual(expected);
        if (question === null) {
          expect(view).toMatchObject({ question: null, waiting: 0 });
          return;
        }
        // The app asks exactly this question next, and no other at the same time.
        const asked = await kase.askNext(view.questionsVersion);
        expect(asked.question).toMatchObject({ conflictKind: question.kind, origin: "model" });
        expect(asked.question!.choices.map((c) => c.label)).toEqual(question.choices);
        await expect(kase.askNext(asked.questionsVersion)).rejects.toThrow(/still open/);
      });
    });
  }

  it("refuses a replay whose answer step does not match the next question", async () => {
    const s3 = scenarios.find((s) => s.id === "S3")!;
    const steps = [{ message: "m2" }, { message: "m3" }, { answer: { kind: "both_held" as const, choice: "Not sure yet" } }];
    await expect(replayCheckpoint(s3, { ...s3.d2![1]!, steps })).rejects.toThrow(/expected a both_held question, got change_proposed/);
    const wrong = [{ message: "m2" }, { message: "m3" }, { answer: { kind: "change_proposed" as const, choice: "Keep it" } }];
    await expect(replayCheckpoint(s3, { ...s3.d2![1]!, steps: wrong })).rejects.toThrow(/no choice "Keep it"/);
  });
});
