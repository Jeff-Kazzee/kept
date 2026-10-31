// 0019, P18: the cards in caseCards.ts load on demand. The shell starts the
// load as soon as a case needs one, beside the first reads, and once the
// browser is idle. See onDemand.tsx.
import type { AppState } from "../api.ts";
import { onDemand } from "../components/onDemand.tsx";

const cards = onDemand(() => import("./caseCards.ts"));
export const loadCaseCards = cards.ensure;

// True when the case shows one of these cards on its first screen.
export const caseNeedsCards = (state: Pick<AppState, "case" | "messages">) =>
  state.messages.length > 0 ||
  state.case.conflicts.length > 0 || state.case.question !== null || state.case.reply.draft !== null || state.case.reply.sent.length > 0 || state.messages.some((m) => m.ownReport !== null);

const card = <div className="card card-loading" aria-busy="true" />;
const panel = <div className="panel-loading" aria-busy="true" />;

export const ClaimsCard = cards.part((m) => m.ClaimsCard, "ClaimsCard", card);
export const ReplyCard = cards.part((m) => m.ReplyCard, "ReplyCard", card);
export const ReplyPanel = cards.part((m) => m.ReplyPanel, "ReplyPanel", card);
export const QuestionCard = cards.part((m) => m.QuestionCard, "QuestionCard", card);
export const ExplanationCard = cards.part((m) => m.ExplanationCard, "ExplanationCard", card);
export const OwnReportCard = cards.part((m) => m.OwnReportCard, "OwnReportCard", card);
export const ChecklistPanel = cards.part((m) => m.ChecklistPanel, "ChecklistPanel", panel);
export const ActivityTab = cards.part((m) => m.ActivityTab, "ActivityTab", panel);
