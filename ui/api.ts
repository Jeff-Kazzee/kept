// Browser side of the local API. Types mirror the server projections.
import type { CaseView, ConflictView } from "../src/case/types.ts";
import type { ChecklistItem } from "../src/case/checklist.ts";
import type { Channel, Effort, EvidenceClaim, Message, SourceType } from "../src/domain/claim.ts";
import type { ProposedChange } from "../src/records/types.ts";

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
  // Notes, tags and archive of every appointment, archived ones included.
  records: RecordView[];
  // Every change an agent proposed, pending or decided.
  proposals: ProposalView[];
  grants: GrantInfo[];
  // The version this state was read at. The page polls for a newer one.
  live: LiveVersion;
};

// The case generation and the highest event number. Any write moves one.
export type LiveVersion = { generation: number; seq: number };

export const versionChanged = (a: LiveVersion, b: LiveVersion) => a.generation !== b.generation || a.seq !== b.seq;

export type Tier = "read" | "annotate" | "propose";

// A grant as the app lists it. Never holds the token or its hash.
export type GrantInfo = {
  id: string;
  name: string;
  tier: Tier;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  version: number;
  lastUsedAt: string | null;
};

export type Actor = { kind: "user" } | { kind: "agent"; grant_id: string; grant_name: string };

export type RecordView = {
  id: string;
  version: number;
  archived: boolean;
  notes: Array<{ id: string; text: string; by: Actor; at: string }>;
  tags: string[];
  history: Array<{ version: number; type: string; by: Actor; at: string; undone: boolean; reverses: number | null }>;
};

export type ProposalView = {
  id: string;
  version: number;
  grantId: string;
  grantName: string;
  change: ProposedChange;
  recordVersion: number | null;
  status: "pending" | "confirmed" | "rejected";
  proposedAt: string;
  decidedAt: string | null;
  evidenceIds: string[];
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

// The pairing code the user typed, kept for this browser tab only. The
// server asks for it to create a grant or confirm an agent's proposal.
const PAIRING_KEY = "appointments-pairing-code";

export const pairing = {
  get: (): string | null => globalThis.sessionStorage?.getItem(PAIRING_KEY) ?? null,
  set: (code: string) => globalThis.sessionStorage?.setItem(PAIRING_KEY, code.trim()),
  clear: () => globalThis.sessionStorage?.removeItem(PAIRING_KEY),
};

export const PAIRING_ERRORS = new Set(["pairing_required", "pairing_failed", "pairing_locked"]);

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, options: { paired?: boolean } = {}): Promise<T> {
  // The server refuses a write without the generation. A write before the
  // page has read the case reads it first.
  if (method === "POST" && lastGeneration === null) await api.state();
  const code = options.paired ? pairing.get() : null;
  const res = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      // Every write says it comes from the app's page. The browser adds
      // Sec-Fetch-Site and Origin, which the server checks too.
      ...(method === "POST" ? { "X-Appointments-App": "1" } : {}),
      ...(method === "POST" && lastGeneration !== null ? { "X-Case-Generation": String(lastGeneration) } : {}),
      ...(code ? { "X-Pairing-Code": code } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  // A wrong or old code is dropped, so the page asks for it again.
  if (!res.ok && PAIRING_ERRORS.has(json?.error)) pairing.clear();
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
  liveVersion: () => request<LiveVersion>("GET", "/api/case/version"),
  // The response holds the new token. It is shown once and never stored here.
  createGrant: (name: string, tier: Tier) => request<{ grant: GrantInfo; token: string }>("POST", "/api/grants", { name, tier }, { paired: true }),
  revokeGrant: (id: string, expectedVersion: number) => request<GrantInfo>("POST", `/api/grants/${encodeURIComponent(id)}/revoke`, { expectedVersion }),
  confirmProposal: (id: string, expectedVersion: number, recordVersion?: number) =>
    request<ProposalView>("POST", `/api/proposals/${encodeURIComponent(id)}/confirm`, { expectedVersion, recordVersion }, { paired: true }),
  rejectProposal: (id: string, expectedVersion: number) =>
    request<ProposalView>("POST", `/api/proposals/${encodeURIComponent(id)}/reject`, { expectedVersion }),
  archive: (id: string, expectedVersion: number) => request<RecordView>("POST", `/api/records/${encodeURIComponent(id)}/archive`, { expectedVersion }),
  undo: (id: string, version: number, expectedVersion: number) =>
    request<RecordView>("POST", `/api/records/${encodeURIComponent(id)}/undo`, { expectedVersion, version }),
  approveDraft: (id: string, confirmedFields: string[], expectedVersion: number, confirmClaim: boolean) =>
    request<CaseView>("POST", `/api/reply/drafts/${encodeURIComponent(id)}/approve`, { expectedVersion, confirmedFields, confirmClaim }),
};
