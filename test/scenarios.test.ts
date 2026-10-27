// D2 acceptance: runs every D2 checkpoint in the fixtures through the real
// path. Messages go through recorded extraction and the review queue,
// questions through the recorded model and the question queue, and answers
// through the user's tap on a choice built by code.
import { describe, expect, it } from "vitest";
import { CaseService } from "../src/case/service.ts";
import type { CaseView } from "../src/case/types.ts";
import { loadScenarios, readFixtureText } from "../src/fixtures/load.ts";
import type { D2Checkpoint } from "../src/fixtures/schema.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, intake } from "./helpers.ts";

const scenarios = loadScenarios().filter((s) => s.d2);

async function runCheckpoint(calendar: string | undefined, checkpoint: D2Checkpoint) {
  const store = new EventStore();
  const service = intake(store, () => "2026-11-11T12:00:00.000Z");
  const kase = new CaseService(store, service, RecordedModelClient.fromDirectory(), { now: () => "2026-11-11T12:00:00.000Z" });
  if (calendar) kase.loadCalendar(calendar, readFixtureText(calendar), 0);
  for (const step of checkpoint.steps) {
    if ("message" in step) {
      await acceptMessages(service, [step.message]);
      continue;
    }
    const asked = await kase.askNext(kase.view().questionsVersion);
    expect(asked.question?.conflictKind).toBe(step.answer.kind);
    const choice = asked.question!.choices.find((c) => c.label === step.answer.choice);
    expect(choice, step.answer.choice).toBeDefined();
    kase.answer(asked.question!.id, choice!.id, asked.questionsVersion);
  }
  return kase;
}

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
        const kase = await runCheckpoint(s.calendar, checkpoint);
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
});
