// D2 acceptance: runs every D2 checkpoint in the fixtures through the real
// path. Messages go through recorded extraction and the review queue,
// questions through the recorded model and the question queue, and answers
// through the user's tap on a choice built by code.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaseView } from "../src/case/types.ts";
import { replayCheckpoint } from "../src/eval/d2-fixtures.ts";
import { SCOPE_DECLINE } from "../src/domain/scope.ts";
import { loadScenarios } from "../src/fixtures/load.ts";
import { buildDraft } from "../src/reply/draft.ts";

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
        const { question, draft, expect: _text, steps: _steps, ...expected } = checkpoint;
        expect(observed(view)).toEqual(expected);
        if (draft !== undefined) {
          expect(view.reply.draft && { template: view.reply.draft.template, slot: view.reply.draft.slotKey }).toEqual(draft);
        }
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

// D3 acceptance: runs every D3 checkpoint through the real reply path.
// Suggest steps go through the recorded model, or a fault recording that
// the step names, and approval reads back every field.
describe("D3 checkpoints in the fixtures", () => {
  const d3 = loadScenarios().filter((s) => s.d3);

  it("covers S3, S7, S9, S11 and S12", () => {
    expect(d3.map((s) => s.id)).toEqual(["S3", "S7", "S9", "S11", "S12"]);
  });

  for (const s of d3) {
    s.d3!.forEach((checkpoint, i) => {
      it(`${s.id}.${i + 1}: ${checkpoint.expect}`, async () => {
        const { kase, reply, intake, store } = await replayCheckpoint(s, checkpoint);
        const view = kase.view();
        const r = view.reply;
        const pair = (x: { template: string; slotKey: string }) => ({ template: x.template, slot: x.slotKey });
        expect(r.options.map(pair)).toEqual(checkpoint.options);
        if (checkpoint.withheld) expect(r.withheld.map((w) => ({ ...pair(w), missing: w.missing }))).toEqual(checkpoint.withheld);
        expect(r.draft && { ...pair(r.draft), origin: r.draft.origin, edited: r.draft.edited }).toEqual(checkpoint.draft);
        if (checkpoint.suggestion !== undefined) {
          expect(r.suggestion && { outcome: r.suggestion.outcome, problems: r.suggestion.attempts.map((a) => a.problems) }).toEqual(checkpoint.suggestion);
        }
        expect(r.sent.map(pair)).toEqual(checkpoint.sent);
        expect(r.sent.every((x) => x.simulated)).toBe(true);
        if (checkpoint.slots) expect(Object.fromEntries(view.slots.map((x) => [x.key, x.stateLabel]))).toEqual(checkpoint.slots);
        if (checkpoint.messages) expect(intake.messages().map((m) => m.id)).toEqual(checkpoint.messages);

        // Code refuses each blocked draft and writes nothing.
        const count = store.readAll().length;
        for (const b of checkpoint.blocked ?? []) {
          expect(buildDraft(b.template, b.slot, kase.replyState().context)).toMatchObject({ ok: false, problems: b.problems });
          expect(() => reply.start(b.template, b.slot, r.version)).toThrow(`Code blocked this reply: ${b.problems.join(", ")}.`);
        }
        // The scope check declines before anything is recorded or a model is called.
        for (const id of checkpoint.declined?.messages ?? []) {
          const { expected: _expected, ...message } = s.messages.find((m) => m.id === id)!;
          expect(() => intake.importMessage(message)).toThrow(SCOPE_DECLINE);
        }
        for (const note of checkpoint.declined?.notes ?? []) {
          await expect(reply.suggest(note, r.version)).rejects.toThrow(SCOPE_DECLINE);
        }
        expect(store.readAll()).toHaveLength(count);
      });
    });
  }
});

// D4 acceptance: runs every D4 checkpoint on a database file. Each reopen
// step closes the store and opens a new one on the same file, and the app
// state after it must equal the state before it exactly. Readback ticks are
// held in the browser only and are not part of the state (O-h).
describe("D4 checkpoints in the fixtures", () => {
  const d4 = loadScenarios().filter((s) => s.d4);
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("covers S10", () => {
    expect(d4.map((s) => s.id)).toEqual(["S10"]);
  });

  for (const s of d4) {
    s.d4!.forEach((checkpoint, i) => {
      it(`${s.id}.${i + 1}: ${checkpoint.expect}`, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "d4-"));
        dirs.push(dir);
        const replayed = await replayCheckpoint(s, checkpoint, undefined, { file: path.join(dir, "app.sqlite") });
        const { kase, reopens, store } = replayed;
        try {
          expect(reopens.length).toBe(checkpoint.steps.filter((x) => "reopen" in x).length);
          for (const r of reopens) expect(r.after).toEqual(r.before);
          const view = kase.view();
          const pair = (x: { template: string; slotKey: string }) => ({ template: x.template, slot: x.slotKey });
          expect(Object.fromEntries(view.slots.map((x) => [x.key, x.stateLabel]))).toEqual(checkpoint.slots);
          expect(view.conflicts.map((c) => ({ kind: c.kind, status: c.status, explained: c.explanation !== null }))).toEqual(checkpoint.conflicts);
          expect(view.question && { kind: view.question.conflictKind, choices: view.question.choices.map((c) => c.label) }).toEqual(checkpoint.question);
          const d = view.reply.draft;
          const want = checkpoint.draft;
          expect(d && { ...pair(d), origin: d.origin, edited: d.edited, ...(want?.text !== undefined ? { text: d.text } : {}) }).toEqual(want);
          if (d) expect(d.valid).toBe(true);
          expect(view.reply.sent.map(pair)).toEqual(checkpoint.sent);
          expect(view.checklist.map((c) => ({ item: c.text, sources: c.sources.map((x) => [x.sourceLabel, x.quote]) }))).toEqual(checkpoint.checklist);
        } finally {
          store.close();
        }
      });
    });
  }
});
