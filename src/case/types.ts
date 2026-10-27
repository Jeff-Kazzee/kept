// Shapes of the case view sent to the UI. Shared by the server and the UI,
// so this file must not import Node modules.
import type { IcsEvent } from "../domain/ics.ts";
import type { ReplyView } from "../reply/types.ts";
import type { ChecklistItem } from "./checklist.ts";
import type { Choice, Conflict, ConflictKind, SlotView } from "../slots/types.ts";

export type AttemptSummary = {
  attempt: number;
  outcome: "valid" | "invalid";
  problems: string[];
  detail: string | null;
  latency_ms: number;
};

export type ExplanationView = {
  // "unavailable" means the model output failed the checks twice.
  outcome: "valid" | "unavailable";
  text: string | null;
  citedEvidenceIds: string[];
  model: string;
  effort: string;
  attempts: AttemptSummary[];
  recordedAt: string;
};

export type ConflictView = Conflict & {
  // open: not asked yet. asked: the current question is about it.
  // answered: a question about this evidence was answered.
  status: "open" | "asked" | "answered";
  answer: { questionId: string; choiceId: string; label: string; answeredAt: string } | null;
  // The explanation made for the conflict's current evidence, if any.
  explanation: ExplanationView | null;
  // Version of the conflict's stream, for the expected version of a write.
  version: number;
};

export type QuestionView = {
  id: string;
  conflictId: string;
  conflictKind: ConflictKind;
  text: string;
  // model: the model proposed it and it passed the checks. fixed: code's
  // wording after the model output failed.
  origin: "model" | "fixed";
  citedEvidenceIds: string[];
  choices: Array<Pick<Choice, "id" | "label">>;
  askedAt: string;
  attempts: AttemptSummary[];
};

export type CalendarView = {
  name: string;
  events: IcsEvent[];
  timeZone: string;
  assumedSlotMinutes: number;
};

export type CaseView = {
  slots: SlotView[];
  conflicts: ConflictView[];
  staleEvidenceIds: string[];
  // The one open question, or null.
  question: QuestionView | null;
  // Conflicts that wait to be asked about.
  waiting: number;
  questionsVersion: number;
  calendar: CalendarView | null;
  calendarVersion: number;
  // Reply templates, the open draft and simulated sends.
  reply: ReplyView;
  // What the office asked the user to bring or do, from accepted evidence.
  checklist: ChecklistItem[];
};
