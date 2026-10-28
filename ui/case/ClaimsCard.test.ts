// Finding 8: a confirmed agent report in the evidence list. Rendered to
// static markup with the server renderer. The item has the shape the domain
// writes on confirmation (src/records/service.ts): origin agent, and the
// grant's name in claim.agent_name. test/mcp.test.ts proves that name comes
// from the grant, not from the name the agent's client reports.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppState, EvidenceView } from "./api.ts";
import { EvidenceCard, SourceQuote, evidenceOrigin } from "./App.tsx";

const item: EvidenceView = {
  id: "p-1a2b3c4d-1",
  version: 1,
  messageId: null,
  claim: {
    claim_type: "confirm",
    slot: { date: "2026-11-16", time: "13:00", location: null },
    quote: "Dana says the office called and confirmed Monday 11/16 at 1:00 PM.",
    source_type: "reported_by_user_via_agent",
    sender_kind: "person",
    evidence_time: "2026-11-06T17:00:00.000Z",
    event_time: null,
    request_item: null,
    agent_name: "Laptop assistant",
  },
  origin: "agent",
  status: "accepted",
  decidedAt: "2026-11-06T17:05:00.000Z",
  answer: null,
};

const state = { messages: [], evidence: [item], case: { staleEvidenceIds: [] } } as unknown as AppState;

describe("evidence list", () => {
  it("finding 8: shows a confirmed agent report as reported by you through the grant's name", () => {
    const html = renderToStaticMarkup(createElement(EvidenceCard, { item, state, run: async () => {} }));
    expect(html).toContain("p-1a2b3c4d-1 · Reported by you through Laptop assistant · accepted");
    expect(html).toContain("from you through Laptop assistant");
    expect(html).not.toContain("Entered by you");
    // The source shown beside a conflict uses the same name.
    const quote = renderToStaticMarkup(createElement(SourceQuote, { id: item.id, state }));
    expect(quote).toContain("p-1a2b3c4d-1 · reported by you through Laptop assistant");
  });

  it("takes the name only from the evidence's agent_name", () => {
    expect(evidenceOrigin({ ...item, claim: { ...item.claim, agent_name: "Kitchen tablet" } })).toBe("Reported by you through Kitchen tablet");
    expect(evidenceOrigin({ ...item, claim: { ...item.claim, agent_name: null } })).toBe("Reported by you through an agent");
  });

  it("labels the other origins as before", () => {
    expect(evidenceOrigin({ ...item, origin: "manual" })).toBe("Entered by you");
    expect(evidenceOrigin({ ...item, origin: "model" })).toBe("Model output, passed the quote check");
    expect(evidenceOrigin({ ...item, origin: "answer" })).toBe("Your answer to a question");
    expect(evidenceOrigin({ ...item, origin: "reply" })).toBe("Your approved reply (simulated send)");
  });
});
