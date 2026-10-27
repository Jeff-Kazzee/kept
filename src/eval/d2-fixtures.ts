// Replays the D2 checkpoints in the fixtures. Messages go through recorded
// extraction and are accepted. Answer steps ask the next question and tap
// the choice with the given label. Used by the scenario tests and by the
// conflict evaluation, which needs the conflict states without spending
// model calls to reach them.
import { CaseService } from "../case/service.ts";
import { DEFAULT_EXTRACTION_EFFORT } from "../domain/claim.ts";
import { readFixtureText } from "../fixtures/load.ts";
import type { D2Checkpoint, ResolvedScenario } from "../fixtures/schema.ts";
import { IntakeService } from "../intake/service.ts";
import type { ModelClient } from "../model/client.ts";
import { RecordedModelClient } from "../model/recorded.ts";
import { EventStore } from "../store/event-log.ts";

export const REPLAY_NOW = "2026-11-11T12:00:00.000Z";

export async function replayCheckpoint(
  scenario: ResolvedScenario,
  checkpoint: D2Checkpoint,
  client: ModelClient = RecordedModelClient.fromDirectory(),
): Promise<{ store: EventStore; intake: IntakeService; kase: CaseService }> {
  const store = new EventStore();
  const now = () => REPLAY_NOW;
  const intake = new IntakeService(store, RecordedModelClient.fromDirectory(), { now });
  const kase = new CaseService(store, intake, client, { now });
  if (scenario.calendar) kase.loadCalendar(scenario.calendar, readFixtureText(scenario.calendar), 0);
  for (const step of checkpoint.steps) {
    if ("message" in step) {
      const message = scenario.messages.find((m) => m.id === step.message)!;
      const { expected: _expected, ...input } = message;
      const imported = intake.importMessage(input);
      const { evidence } = await intake.extract(message.id, { effort: DEFAULT_EXTRACTION_EFFORT, expectedVersion: imported.version });
      for (const e of evidence) intake.accept(e.id, e.version);
      continue;
    }
    const asked = await kase.askNext(kase.view().questionsVersion);
    const question = asked.question!;
    if (question.conflictKind !== step.answer.kind) {
      throw new Error(`${scenario.id}: expected a ${step.answer.kind} question, got ${question.conflictKind}.`);
    }
    const choice = question.choices.find((c) => c.label === step.answer.choice);
    if (!choice) throw new Error(`${scenario.id}: no choice "${step.answer.choice}".`);
    kase.answer(question.id, choice.id, asked.questionsVersion);
  }
  return { store, intake, kase };
}
