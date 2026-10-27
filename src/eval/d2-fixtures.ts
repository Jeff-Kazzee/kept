// Replays the checkpoints in the fixtures. Messages go through recorded
// extraction and are accepted. Answer steps ask the next question and tap
// the choice with the given label. Approve steps approve the open reply.
// D4 steps explain a conflict, ask a question and leave it open, or close
// the app and open it again on the same database file. Used by the scenario
// tests and by the conflict evaluation, which needs the conflict states
// without spending model calls to reach them.
import { CaseService } from "../case/service.ts";
import { DEFAULT_EXTRACTION_EFFORT } from "../domain/claim.ts";
import { loadCaseProfile, readFixtureText } from "../fixtures/load.ts";
import type { D4Step, ResolvedScenario } from "../fixtures/schema.ts";
import { IntakeService } from "../intake/service.ts";
import type { ModelCall, ModelClient } from "../model/client.ts";
import { Recording, RecordedModelClient } from "../model/recorded.ts";
import { ReplyService } from "../reply/service.ts";
import { EventStore } from "../store/event-log.ts";

export const REPLAY_NOW = "2026-11-11T12:00:00.000Z";

export type Replayed = {
  store: EventStore;
  intake: IntakeService;
  kase: CaseService;
  reply: ReplyService;
  // The whole app state just before and just after each reopen step.
  reopens: Array<{ before: AppSnapshot; after: AppSnapshot }>;
};

// Everything the app shows, read from the store.
export type AppSnapshot = { messages: unknown; evidence: unknown; case: unknown; history: unknown; caseVersion: number };

export function snapshot(r: Pick<Replayed, "intake" | "kase">): AppSnapshot {
  return {
    messages: r.intake.messages(),
    evidence: r.intake.evidence(),
    case: r.kase.view(),
    history: r.kase.history(),
    caseVersion: r.kase.caseVersion(),
  };
}

// `file` is the database file. A checkpoint with a reopen step needs one.
export async function replayCheckpoint(
  scenario: ResolvedScenario,
  checkpoint: { steps: D4Step[] },
  base: ModelClient = RecordedModelClient.fromDirectory(),
  options: { file?: string } = {},
): Promise<Replayed> {
  const now = () => REPLAY_NOW;
  // A suggest step may name a fault recording, which answers that one call
  // in place of the base client.
  let fault: Recording | null = null;
  const client: ModelClient = {
    label: base.label,
    call: (request: ModelCall) =>
      fault && fault.message_id === request.key ? RecordedModelClient.withOverrides([fault]).call(request) : base.call(request),
  };
  const openApp = () => {
    const store = new EventStore(options.file ?? ":memory:");
    const intake = new IntakeService(store, RecordedModelClient.fromDirectory(), { now });
    const kase = new CaseService(store, intake, client, { now, userName: loadCaseProfile().user_name });
    const reply = new ReplyService(store, kase, client, { now });
    return { store, intake, kase, reply };
  };
  let { store, intake, kase, reply } = openApp();
  const reopens: Replayed["reopens"] = [];
  if (scenario.calendar) kase.loadCalendar(scenario.calendar, readFixtureText(scenario.calendar), 0);
  for (const step of checkpoint.steps) {
    if ("reopen" in step) {
      if (!options.file) throw new Error(`${scenario.id}: a reopen step needs a database file.`);
      const before = snapshot({ intake, kase });
      store.close();
      ({ store, intake, kase, reply } = openApp());
      reopens.push({ before, after: snapshot({ intake, kase }) });
      continue;
    }
    if ("explain" in step) {
      const conflict = kase.view().conflicts.find((c) => c.kind === step.explain);
      if (!conflict) throw new Error(`${scenario.id}: no ${step.explain} conflict to explain.`);
      await kase.explain(conflict.id, conflict.version);
      continue;
    }
    if ("ask" in step) {
      const asked = await kase.askNext(kase.view().questionsVersion);
      if (asked.question?.conflictKind !== step.ask) {
        throw new Error(`${scenario.id}: expected a ${step.ask} question, got ${asked.question?.conflictKind ?? "none"}.`);
      }
      continue;
    }
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
    if ("suggest" in step) {
      fault = step.suggest.recording ? Recording.parse(JSON.parse(readFixtureText(step.suggest.recording))) : null;
      await reply.suggest(step.suggest.intent, kase.view().reply.version);
      fault = null;
      continue;
    }
    if ("start_reply" in step) {
      reply.start(step.start_reply.template, step.start_reply.slot, kase.view().reply.version);
      continue;
    }
    if ("edit_reply" in step) {
      const { draft, version } = kase.view().reply;
      if (!draft) throw new Error(`${scenario.id}: no open draft to edit.`);
      reply.edit(draft.id, step.edit_reply, version);
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
  return { store, intake, kase, reply, reopens };
}
