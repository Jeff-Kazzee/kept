// Browser side of the local API. Types mirror the server projections.
import type { Channel, Effort, EvidenceClaim, Message, SourceType } from "../src/domain/claim.ts";

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
};

export type EvidenceView = {
  id: string;
  version: number;
  messageId: string;
  claim: EvidenceClaim;
  origin: "model" | "manual";
  status: "pending" | "accepted" | "rejected";
  decidedAt: string | null;
};

export type AppState = { mode: "recorded" | "live"; modelClient: string; messages: MessageView[]; evidence: EvidenceView[] };

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

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export const api = {
  state: () => request<AppState>("GET", "/api/state"),
  fixtures: () => request<FixtureScenario[]>("GET", "/api/fixtures"),
  calendar: () => request<{ name: string; text: string }>("GET", "/api/fixtures/calendar"),
  addMessage: (m: Omit<Message, "id"> & { id?: string }) => request<MessageView>("POST", "/api/messages", m),
  extract: (id: string, effort: Effort, expectedVersion: number) =>
    request("POST", `/api/messages/${encodeURIComponent(id)}/extract`, { effort, expectedVersion }),
  manual: (id: string, claim: unknown) => request<EvidenceView>("POST", `/api/messages/${encodeURIComponent(id)}/manual`, claim),
  accept: (id: string, expectedVersion: number) =>
    request<EvidenceView>("POST", `/api/evidence/${encodeURIComponent(id)}/accept`, { expectedVersion }),
  reject: (id: string, expectedVersion: number) =>
    request<EvidenceView>("POST", `/api/evidence/${encodeURIComponent(id)}/reject`, { expectedVersion }),
};
