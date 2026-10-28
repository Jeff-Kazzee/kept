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
  // The source fields the assistant suggested for a message pasted in the
  // chat, and the note to show beside them (0007, E1). Empty and null for
  // messages imported any other way.
  sourceSuggested: Array<"channel" | "from" | "received_at">;
  sourceNote: string | null;
  // Where the message came from when an agent fetched it, such as Gmail.
  // Assumed field until the Google back end settles it (0011). The page
  // also reads it from the activity entry of the import.
  importedFrom?: "gmail";
  status: "imported" | "claims_pending" | "no_claims" | "manual_entry_needed";
  // "Record this as your own report?" (0009, D1'): "offered" while the
  // question is open, then the person's answer. Null when never asked.
  ownReport: "offered" | "yes" | "no" | null;
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
  // Notes, tags and archive of every appointment, archived ones included.
  records: RecordView[];
  // Sprint 8 sends the time zone settings and the activity here too. The
  // page reads both from their own routes.
  settings?: unknown;
  activity?: unknown;
  // The version this state was read at. The page polls for a newer one.
  live: LiveVersion;
};

// The case generation and the highest event number. Any write moves one.
export type LiveVersion = { generation: number; seq: number };

export const versionChanged = (a: LiveVersion, b: LiveVersion) => a.generation !== b.generation || a.seq !== b.seq;

// An agent is "the assistant" or "an external agent" (0009, A22). Old
// records keep the name of the grant they came through.
export type Actor = { kind: "user" } | { kind: "agent"; name: string } | { kind: "agent"; grant_id: string; grant_name: string };

export const actorName = (a: Extract<Actor, { kind: "agent" }>) => ("name" in a ? a.name : a.grant_name);

export type RecordView = {
  id: string;
  version: number;
  archived: boolean;
  notes: Array<{ id: string; text: string; by: Actor; at: string }>;
  tags: string[];
  history: Array<{ version: number; type: string; by: Actor; at: string; undone: boolean; reverses: number | null }>;
};

export type FixtureScenario = {
  id: string;
  title: string;
  messages: Array<Message & { channel: Channel }>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: { error?: string; message?: string; issues?: Array<{ path: string; message: string }>; retryable?: boolean };
  constructor(status: number, body: ApiError["body"]) {
    super(body.message ?? body.issues?.map((i) => `${i.path}: ${i.message}`).join("; ") ?? body.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// The case generation from the last state this page read. A write from a
// page that has not seen a Delete case is refused by the server.
let lastGeneration: number | null = null;

// The headers of a write: JSON, the app's own header and the case
// generation this page last read. The server refuses a write without the
// generation, so a write before the page has read the case reads it first.
// The chat route (chat/transport.ts) sends the same headers.
export async function writeHeaders(): Promise<Record<string, string>> {
  if (lastGeneration === null) await api.state();
  return {
    "Content-Type": "application/json",
    // Every write says it comes from the app's page. The browser adds
    // Sec-Fetch-Site and Origin, which the server checks too.
    "X-Appointments-App": "1",
    ...(lastGeneration !== null ? { "X-Case-Generation": String(lastGeneration) } : {}),
  };
}

export async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === "GET" ? {} : await writeHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = {};
  try {
    json = await res.json();
  } catch {
    // Not JSON, such as a 404 page. The status says enough.
  }
  if (!res.ok) throw new ApiError(res.status, json as ApiError["body"]);
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
  // The person's answer on an own_report card. `expectedVersion` is the
  // message's version. Answers the message.
  ownReport: (id: string, answer: "yes" | "no", expectedVersion: number) =>
    request<MessageView>("POST", `/api/messages/${encodeURIComponent(id)}/own-report`, { expectedVersion, answer }),
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
  liveVersion: () => request<LiveVersion>("GET", "/api/case/version"),
  archive: (id: string, expectedVersion: number) => request<RecordView>("POST", `/api/records/${encodeURIComponent(id)}/archive`, { expectedVersion }),
  undo: (id: string, version: number, expectedVersion: number) =>
    request<RecordView>("POST", `/api/records/${encodeURIComponent(id)}/undo`, { expectedVersion, version }),
  approveDraft: (id: string, confirmedFields: string[], expectedVersion: number, confirmClaim: boolean) =>
    request<CaseView>("POST", `/api/reply/drafts/${encodeURIComponent(id)}/approve`, { expectedVersion, confirmedFields, confirmClaim }),
};
