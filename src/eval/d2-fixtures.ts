// Replays the checkpoints in the fixtures. Messages go through recorded
// extraction and are accepted. Answer steps ask the next question and tap
// the choice with the given label. Approve steps approve the open reply. Used by the scenario tests and by the
// conflict evaluation, which needs the conflict states without spending
// model calls to reach them.
import { CaseService } from "../case/service.ts";
import { DEFAULT_EXTRACTION_EFFORT } from "../domain/claim.ts";
import { loadCaseProfile, readFixtureText } from "../fixtures/load.ts";
import type { D2Step, ResolvedScenario } from "../fixtures/schema.ts";
import { IntakeService } from "../intake/service.ts";
import type { ModelClient } from "../model/client.ts";
import { RecordedModelClient } from "../model/recorded.ts";
import { ReplyService } from "../reply/service.ts";
import { EventStore } from "../store/event-log.ts";

export const REPLAY_NOW = "2026-11-11T12:00:00.000Z";

export type Replayed = { store: EventStore; intake: IntakeService; kase: CaseService; reply: ReplyService };

export async function replayCheckpoint(
  scenario: ResolvedScenario,
  checkpoint: { steps: D2Step[] },
  client: ModelClient = RecordedModelClient.fromDirectory(),
): Promise<Replayed> {
  const store = new EventStore();
  const now = () => REPLAY_NOW;
  const intake = new IntakeService(store, RecordedModelClient.fromDirectory(), { now });
  const kase = new CaseService(store, intake, client, { now, userName: loadCaseProfile().user_name });
  const reply = new ReplyService(store, kase, client, { now });
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
    if ("approve_reply" in step) {
      const { draft, version } = kase.view().reply;
      const want = step.approve_reply;
      if (!draft || draft.template !== want.template || draft.slotKey !== want.slot) {
        throw new Error(`${scenario.id}: expected an open ${want.template} draft for ${want.slot}, got ${draft ? `${draft.template} for ${draft.slotKey}` : "none"}.`);
      }
      reply.approve(draft.id, draft.fields.map((f) => f.name), version);
      continue;
    }
    const asked = await kase.askNext(kase.view().questionsVersion);
    const question = asked.question!;
    if (question.conflictKind !== step.answer.kind) {
      throw new Error(`${scenario.id}: expected a ${step.answer.kind} question, got ${question.conflictKind}.`);
    }
    const choice = question.choices.find((c) => c.label === step.answer.choice);
    if (!choice) throw new Error(`${scenario.id}: no choice "${step.answer.choice}".`);
    kase.answer(question.id, choice.id, asked.questionsVersion, asked.reply.version);
  }
  return { store, intake, kase, reply };
}
