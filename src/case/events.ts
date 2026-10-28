// Event kinds for the calendar, the question queue and conflict
// explanations, and the projections built from them.
//
// - The `calendar` stream holds each loaded calendar file.
// - The `questions` stream is the question queue. One stream means every
//   ask and answer states one expected version, so two questions cannot be
//   opened at once.
// - Each `conflict:<id>` stream holds the explanations of one conflict.
import type { Effort } from "../domain/claim.ts";
import type { StoredEvent } from "../store/event-log.ts";
import type { Choice, ConflictKind } from "../slots/types.ts";
import type { AttemptSummary } from "./types.ts";

export const CALENDAR_STREAM = "calendar";
export const QUESTIONS_STREAM = "questions";
export const conflictStream = (id: string) => `conflict:${id}`;

export type AttemptData = AttemptSummary & {
  effort: Effort;
  model: string;
  usage: { input: number; cachedInput: number; output: number; reasoning: number };
  // The parsed model output, kept for the record even when it failed.
  output: unknown;
};

export type CaseEvent =
  | { type: "calendar_loaded"; data: { name: string; text: string } }
  | {
      type: "question_asked";
      data: {
        question_id: string;
        conflict_id: string;
        conflict_kind: ConflictKind;
        // The conflict's evidence when asked. The question stays current
        // only while the conflict has the same evidence.
        conflict_evidence_ids: string[];
        text: string;
        origin: "model" | "fixed";
        cited_evidence_ids: string[];
        // Built by code. Stored so the answer applies what was shown.
        choices: Choice[];
        key: string;
        attempts: AttemptData[];
      };
    }
  // "undone": an undo of the ask in the activity log.
  | { type: "question_withdrawn"; data: { question_id: string; reason: "conflict_changed" | "undone" } }
  // An undo of the answer in the activity log. The question is open again
  // and the evidence it settled counts again.
  | { type: "question_answer_undone"; data: { question_id: string; settled_evidence_ids: string[] } }
  | {
      type: "question_answered";
      data: {
        question_id: string;
        choice_id: string;
        label: string;
        // Evidence items the answer created.
        evidence_ids: string[];
        // Evidence with an unknown event time that the answer replaces.
        settled_evidence_ids: string[];
      };
    }
  | { type: "explanation_attempted"; data: AttemptData & { key: string } }
  | {
      type: "explanation_finished";
      data: {
        conflict_evidence_ids: string[];
        outcome: "valid" | "unavailable";
        text: string | null;
        cited_evidence_ids: string[];
      };
    };

export type QuestionRecord = {
  id: string;
  conflictId: string;
  conflictKind: ConflictKind;
  conflictEvidenceIds: string[];
  text: string;
  origin: "model" | "fixed";
  citedEvidenceIds: string[];
  choices: Choice[];
  attempts: AttemptData[];
  askedAt: string;
  status: "open" | "answered" | "withdrawn";
  answer: { choiceId: string; label: string; evidenceIds: string[]; answeredAt: string } | null;
};

export type QuestionQueue = { version: number; questions: QuestionRecord[]; settled: Set<string> };

export function projectQuestions(events: StoredEvent[]): QuestionQueue {
  const queue: QuestionQueue = { version: 0, questions: [], settled: new Set() };
  for (const e of events) {
    if (e.streamId !== QUESTIONS_STREAM) continue;
    queue.version = e.version;
    const event = { type: e.type, data: e.data } as CaseEvent;
    if (event.type === "question_asked") {
      const d = event.data;
      queue.questions.push({
        id: d.question_id,
        conflictId: d.conflict_id,
        conflictKind: d.conflict_kind,
        conflictEvidenceIds: d.conflict_evidence_ids,
        text: d.text,
        origin: d.origin,
        citedEvidenceIds: d.cited_evidence_ids,
        choices: d.choices,
        attempts: d.attempts,
        askedAt: e.recordedAt,
        status: "open",
        answer: null,
      });
      continue;
    }
    if (event.type !== "question_withdrawn" && event.type !== "question_answered" && event.type !== "question_answer_undone") continue;
    const q = queue.questions.find((x) => x.id === event.data.question_id);
    if (!q) continue;
    if (event.type === "question_withdrawn") q.status = "withdrawn";
    else if (event.type === "question_answer_undone") {
      q.status = "open";
      q.answer = null;
      for (const id of event.data.settled_evidence_ids) queue.settled.delete(id);
    } else {
      q.status = "answered";
      q.answer = { choiceId: event.data.choice_id, label: event.data.label, evidenceIds: event.data.evidence_ids, answeredAt: e.recordedAt };
      for (const id of event.data.settled_evidence_ids) queue.settled.add(id);
    }
  }
  return queue;
}

export type ExplanationRecord = {
  conflictEvidenceIds: string[];
  outcome: "valid" | "unavailable";
  text: string | null;
  citedEvidenceIds: string[];
  attempts: AttemptData[];
  recordedAt: string;
};

export function projectExplanations(events: StoredEvent[]): { version: number; explanations: ExplanationRecord[] } {
  let version = 0;
  let attempts: AttemptData[] = [];
  const explanations: ExplanationRecord[] = [];
  for (const e of events) {
    version = e.version;
    const event = { type: e.type, data: e.data } as CaseEvent;
    if (event.type === "explanation_attempted") {
      const { key: _key, ...attempt } = event.data;
      attempts.push(attempt);
    } else if (event.type === "explanation_finished") {
      explanations.push({
        conflictEvidenceIds: event.data.conflict_evidence_ids,
        outcome: event.data.outcome,
        text: event.data.text,
        citedEvidenceIds: event.data.cited_evidence_ids,
        attempts,
        recordedAt: e.recordedAt,
      });
      attempts = [];
    }
  }
  return { version, explanations };
}

export function latestCalendar(events: StoredEvent[]): { version: number; name: string; text: string } | null {
  let found: { version: number; name: string; text: string } | null = null;
  for (const e of events) {
    const event = { type: e.type, data: e.data } as CaseEvent;
    if (e.streamId === CALENDAR_STREAM && event.type === "calendar_loaded") {
      found = { version: e.version, name: event.data.name, text: event.data.text };
    }
  }
  return found;
}
