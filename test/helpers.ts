// Shared test helpers for slot states. Evidence views are built by hand for
// rule tests, and through the recorded extraction path for scenario tests.
import type { EvidenceClaim } from "../src/domain/claim.ts";
import { corpusMessages, loadScenarios } from "../src/fixtures/load.ts";
import type { FixtureMessage } from "../src/fixtures/schema.ts";
import type { AnswerMeta, EvidenceView } from "../src/intake/events.ts";
import { IntakeService } from "../src/intake/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import type { ApiRequest, ApiResponse } from "../server/api.ts";

const corpus = corpusMessages(loadScenarios());

export function fixtureMessage(id: string): Omit<FixtureMessage, "expected"> {
  const found = corpus.find((m) => m.id === id);
  if (!found) throw new Error(`No fixture message ${id}.`);
  const { expected: _expected, ...message } = found;
  return message;
}

type EvOptions = Partial<Omit<EvidenceClaim, "slot" | "claim_type">> & {
  location?: string | null;
  origin?: EvidenceView["origin"];
  status?: EvidenceView["status"];
  answer?: AnswerMeta | null;
};

// An evidence view with an office message from a person by default.
export function ev(
  id: string,
  claim_type: EvidenceClaim["claim_type"],
  date: string | null,
  time: string | null,
  at: string,
  options: EvOptions = {},
): EvidenceView {
  const { location = null, origin = "manual", status = "accepted", answer = null, ...claim } = options;
  return {
    id,
    version: status === "pending" ? 1 : 2,
    messageId: origin === "answer" ? null : `msg-${id}`,
    claim: {
      claim_type,
      slot: { date, time, location },
      quote: null,
      source_type: "office_message",
      sender_kind: "person",
      evidence_time: at,
      event_time: null,
      request_item: null,
      ...claim,
    },
    origin,
    status,
    decidedAt: status === "pending" ? null : at,
    answer,
  };
}

// Imports each message, extracts it with the recorded client and accepts
// every claim, in order.
export async function acceptMessages(service: IntakeService, ids: string[]): Promise<void> {
  for (const id of ids) {
    const imported = service.importMessage(fixtureMessage(id));
    const { evidence } = await service.extract(id, { effort: "low", expectedVersion: imported.version });
    for (const e of evidence) service.accept(e.id, e.version);
  }
}

// A local API handler as a page that just read the state uses it: every
// request carries the current case generation unless the test gives one.
export function asFreshPage(
  handle: (req: ApiRequest) => Promise<ApiResponse>,
  kase: { generation(): number },
): (req: ApiRequest) => Promise<ApiResponse> {
  return (req) => handle(req.generation === undefined ? { ...req, generation: kase.generation() } : req);
}

export function intake(store: ConstructorParameters<typeof IntakeService>[0], now = () => "2026-11-06T10:00:00.000Z") {
  return new IntakeService(store, RecordedModelClient.fromDirectory(), { now });
}
