// Browser side of the local API. Types mirror the server projections.
import type { CaseView, ConflictView } from "../src/case/types.ts";
import type { ChecklistItem } from "../src/case/checklist.ts";
import type { Channel, Effort, EvidenceClaim, Message, SourceType } from "../src/domain/claim.ts";

export type { CaseView, ChecklistItem, ConflictView };

// One case event as the history shows it. Labels are built by code.
export type HistoryEntry = { seq: number; at: string; streamId: string; label: string; undone: boolean };

export type Attempt = {
  attempt: number;
  effort: Effort;
  outcome: "valid" | "invalid";
  problem: string | null;
  detail: string | null;
  latency_ms: number;
  claim_count: number;
};

export type Rejection = {
  attempt: number;
  claim: { claim_type: string; date: string | null; time: string | null; location: string | null; quote: string };
  problems: string[];
};

export type MessageView = {
  id: string;
  version: number;
  message: Message;
  sourceType: SourceType;
  status: "imported" | "claims_pending" | "no_claims" | "manual_entry_needed";
  attempts: Attempt[];
  rejections: Rejection[];
  evidenceIds: string[];
  manualEvidenceIds: string[];
};

export type EvidenceView = {
  id: string;
  version: number;
  messageId: string | null;
  claim: EvidenceClaim;
  // "agent": a change an agent proposed and the user confirmed. Its claim
  // carries agent_name, the name of the grant the agent used.
  origin: "model" | "manual" | "answer" | "reply" | "agent";
  status: "pending" | "accepted" | "rejected";
  decidedAt: string | null;
  answer: { question_id: string; conflict_id: string; choice_id: string; clarifies: string | null; after: string } | null;
  reply?: { draft_id: string; after: string; index: number } | null;
};

export type AppState = {
  mode: "recorded" | "live";
  modelClient: string;
  messages: MessageView[];
  evidence: EvidenceView[];
  case: CaseView;
  // The version Delete case states.
  caseVersion: number;
  // The case generation. Delete case moves it. Every write sends the one
  // this page last read.
  generation: number;
  // True when a Delete case still has to clear the database file.
  erasePending: boolean;
  history: HistoryEntry[];
};

export type FixtureScenario = {
  id: string;
  title: string;
  messages: Array<Message & { channel: Channel }>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: { error?: string; message?: string; issues?: Array<{ path: string; message: string }> };
  constructor(status: number, body: ApiError["body"]) {
    super(body.message ?? body.issues?.map((i) => `${i.path}: ${i.message}`).join("; ") ?? body.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// The case generation from the last state this page read. A write from a
// page that has not seen a Delete case is refused by the server.
let lastGeneration: number | null = null;

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "POST" && lastGeneration !== null ? { "X-Case-Generation": String(lastGeneration) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export const api = {
  state: async () => {
    const state = await request<AppState>("GET", "/api/state");
    lastGeneration = state.generation;
    return state;
  },
  fixtures: () => request<FixtureScenario[]>("GET", "/api/fixtures"),
  calendar: () => request<{ name: string; text: string }>("GET", "/api/fixtures/calendar"),
  addMessage: (m: Omit<Message, "id"> & { id?: string }) => request<MessageView>("POST", "/api/messages", m),
  extract: (id: string, effort: Effort, expectedVersion: number) =>
    request("POST", `/api/messages/${encodeURIComponent(id)}/extract`, { effort, expectedVersion }),
  manual: (id: string, expectedVersion: number, claim: unknown) =>
    request<EvidenceView>("POST", `/api/messages/${encodeURIComponent(id)}/manual`, { expectedVersion, claim }),
  accept: (id: string, expectedVersion: number) =>
    request<EvidenceView>("POST", `/api/evidence/${encodeURIComponent(id)}/accept`, { expectedVersion }),
  reject: (id: string, expectedVersion: number) =>
    request<EvidenceView>("POST", `/api/evidence/${encodeURIComponent(id)}/reject`, { expectedVersion }),
  loadCalendar: (name: string, text: string, expectedVersion: number) =>
    request<CaseView>("POST", "/api/calendar", { name, text, expectedVersion }),
  explain: (conflictId: string, expectedVersion: number) =>
    request<ConflictView>("POST", `/api/conflicts/${encodeURIComponent(conflictId)}/explain`, { expectedVersion }),
  nextQuestion: (expectedVersion: number) => request<CaseView>("POST", "/api/questions/next", { expectedVersion }),
  answer: (questionId: string, choiceId: string, expectedVersion: number, replyVersion: number) =>
    request<CaseView>("POST", `/api/questions/${encodeURIComponent(questionId)}/answer`, { expectedVersion, choiceId, replyVersion }),
  suggestReply: (intent: string | null, expectedVersion: number) => request<CaseView>("POST", "/api/reply/suggest", { expectedVersion, intent }),
  startDraft: (template: string, slotKey: string, expectedVersion: number) =>
    request<CaseView>("POST", "/api/reply/drafts", { expectedVersion, template, slotKey }),
  editDraft: (id: string, text: string, expectedVersion: number) =>
    request<CaseView>("POST", `/api/reply/drafts/${encodeURIComponent(id)}/edit`, { expectedVersion, text }),
  discardDraft: (id: string, expectedVersion: number) =>
    request<CaseView>("POST", `/api/reply/drafts/${encodeURIComponent(id)}/discard`, { expectedVersion }),
  deleteCase: (expectedVersion: number, confirmation: string) =>
    request<{ erased: number }>("POST", "/api/case/delete", { expectedVersion, confirmation }),
  approveDraft: (id: string, confirmedFields: string[], expectedVersion: number, confirmClaim: boolean) =>
    request<CaseView>("POST", `/api/reply/drafts/${encodeURIComponent(id)}/approve`, { expectedVersion, confirmedFields, confirmClaim }),
};
