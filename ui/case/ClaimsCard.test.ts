// Finding 8: a confirmed agent report in the evidence list. Rendered to
// static markup with the server renderer. The item has the shape the domain
// writes on confirmation (src/records/service.ts): origin agent, and the
// grant's name in claim.agent_name. test/mcp.test.ts proves that name comes
// from the grant, not from the name the agent's client reports.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLAIM_TYPES as DOMAIN_CLAIM_TYPES, DEFAULT_EXTRACTION_EFFORT as DOMAIN_EFFORT } from "../../src/domain/claim.ts";
import type { AppState, EvidenceView } from "../api.ts";
import { SOURCE_SUGGESTED_LABEL } from "../../src/agent/types.ts";
import { CLAIM_TYPES, DEFAULT_EXTRACTION_EFFORT } from "../format.ts";
import { ClaimsCard, EvidenceCard, factLine } from "./ClaimsCard.tsx";
import { AgentContext, DEFAULT_AGENT } from "../agent/AgentContext.tsx";
import { SourceQuote, evidenceOrigin } from "./Source.tsx";
import { setCaseZone } from "../format.ts";

// These tests read times as the demo shows them, in the clinic's zone. The
// app's own default is UTC, as the server's.
setCaseZone("America/Denver");

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
    expect(html).toContain("p-1a2b3c4d-1 · Reported by you through Laptop assistant");
    expect(html).toContain("Accepted");
    // The agent's words stay in a labeled untrusted box.
    expect(html).toContain('<div class="untrusted"><div class="label">p-1a2b3c4d-1 · words from Laptop assistant. Untrusted text, shown as data.</div>');
    expect(html).not.toContain("Entered by you");
    // The source shown beside a conflict uses the same name.
    const quote = renderToStaticMarkup(createElement(SourceQuote, { id: item.id, state }));
    expect(quote).toContain("Confirmation · reported by you through Laptop assistant");
    expect(quote).toContain("<code>p-1a2b3c4d-1</code>");
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

describe("claims card", () => {
  const message = {
    id: "m9",
    version: 2,
    message: { id: "m9", channel: "sms", from: "Lantern Hill Clinic", received_at: "2026-11-01T07:30:00Z", text: "See you <b>Monday</b>." },
    sourceType: "office_message",
    sourceSuggested: [],
    sourceNote: null,
    status: "claims_pending",
    attempts: [],
    rejections: [],
    evidenceIds: ["m9-e1"],
    manualEvidenceIds: [],
  };
  const pending: EvidenceView = { ...item, id: "m9-e1", messageId: "m9", origin: "model", status: "pending", decidedAt: null, claim: { ...item.claim, source_type: "office_message", quote: "See you Monday", agent_name: null } };
  const st = { messages: [message], evidence: [pending], case: { staleEvidenceIds: [] } } as unknown as AppState;

  it("lists each claim with its quote and the accept and reject buttons, and shows the message only as data", () => {
    const html = renderToStaticMarkup(createElement(ClaimsCard, { messageId: "m9", evidenceIds: ["m9-e1"], state: st, run: async () => {} }));
    expect(html).toContain("Facts from Lantern Hill Clinic");
    // Received 2026-11-01 07:30 UTC is 01:30 MDT, before the clocks change.
    expect(html).toContain('received <span class="tabular">Sun, Nov 1, 1:30 AM MDT</span>');
    // A fact no one has decided opens the card, as one line with Accept and Reject.
    expect(html).toContain('<span class="tabular">Mon 11/16 1:00 PM </span><span class="claim-what">confirmed</span><span class="fact-src"> · Lantern Hill Clinic</span>');
    expect(html).toContain("Confirmation: Monday 11/16 1:00 PM");
    expect(html).toContain("“See you Monday”");
    expect(html).toContain("Model output, passed the quote check");
    expect(html).toContain(" Accept</button>");
    expect(html).toContain(" Reject</button>");
    expect(html).toContain("<pre>See you &lt;b&gt;Monday&lt;/b&gt;.</pre>");
    expect(html).not.toContain("<b>Monday</b>");
  });

  it("says when the message is no longer in the case", () => {
    const html = renderToStaticMarkup(createElement(ClaimsCard, { messageId: "gone", evidenceIds: [], state: st, run: async () => {} }));
    expect(html).toContain("This message is no longer in the case.");
    // In the turn being streamed, a missing message is still loading.
    const fresh = renderToStaticMarkup(createElement(ClaimsCard, { messageId: "gone", evidenceIds: [], state: st, run: async () => {}, fresh: true }));
    expect(fresh).toContain("Loading the message…");
    expect(fresh).not.toContain("no longer in the case");
  });

  it("keeps its claim types and default effort the same as the domain's", () => {
    expect([...CLAIM_TYPES]).toEqual([...DOMAIN_CLAIM_TYPES]);
    expect(DEFAULT_EXTRACTION_EFFORT).toBe(DOMAIN_EFFORT);
  });

  it("7A E1: a message the chat imported shows the unknown channel and which source fields the assistant suggested, with the whole message", () => {
    const suggested = {
      ...message,
      message: { ...message.message, channel: "unknown", from: "Unknown sender" },
      sourceSuggested: ["channel", "from", "received_at"],
      sourceNote: SOURCE_SUGGESTED_LABEL,
    };
    const claim = { ...pending, claim: { ...pending.claim, source_note: SOURCE_SUGGESTED_LABEL } };
    const st2 = { ...st, messages: [suggested], evidence: [claim] } as unknown as AppState;
    const html = renderToStaticMarkup(createElement(ClaimsCard, { messageId: "m9", evidenceIds: ["m9-e1"], state: st2, run: async () => {} }));
    expect(html).toContain("Channel not stated · received");
    expect(html).toContain("Source suggested by the assistant: how it came, sender, time received. Check them against the message below.");
    // On the claim too, and the whole message is open.
    expect(html.split(SOURCE_SUGGESTED_LABEL).length - 1).toBe(2);
    expect(html).toMatch(/<details class="stack-sm" open="">\s*<summary class="small">Show the whole message<\/summary>/);
  });

  it("v2: a decided card is one receipt with the facts folded away, each fact one line with its quote behind a tap", () => {
    const accepted = { ...pending, status: "accepted" as const, decidedAt: "2026-11-01T08:00:00Z" };
    const st3 = { ...st, evidence: [accepted] } as unknown as AppState;
    const activity = { activityVersion: 1, entries: [{ id: "a1", at: "2026-11-01T08:00:00Z", actor: "agent" as const, kind: "claim_accepted", summary: "Accepted.", target: { type: "claim" as const, id: "m9-e1" }, undoable: true, undone: false }] };
    const html = renderToStaticMarkup(createElement(AgentContext.Provider, { value: { ...DEFAULT_AGENT, activity } }, createElement(ClaimsCard, { messageId: "m9", evidenceIds: ["m9-e1"], state: st3, run: async () => {} })));
    expect(html).toContain("Accepted 1 fact");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show 1 fact");
    expect(html).toMatch(/class="claims-body" hidden=""/);
    expect(html).toContain('aria-label="Undo: Accepted 1 fact"');
    // The line's quote panel is hidden until the line is tapped.
    expect(html).toMatch(/class="claim-more" hidden="">/);
    expect(html).not.toContain(" Accept</button>");
  });

  it("v2: writes each fact in a few words", () => {
    const base = pending.claim;
    expect(factLine({ ...base, claim_type: "confirm", slot: { date: "2026-11-12", time: "10:30", location: null } })).toEqual({ when: "Thu 11/12 10:30 AM", what: "confirmed" });
    expect(factLine({ ...base, claim_type: "offer", slot: { date: "2026-11-13", time: "09:15", location: null } })).toEqual({ when: "Fri 11/13 9:15 AM", what: "offered" });
    expect(factLine({ ...base, claim_type: "office_request", slot: { date: null, time: null, location: null }, request_item: "Bring new insurance card" })).toEqual({ when: null, what: "Asked: Bring new insurance card" });
    expect(factLine({ ...base, claim_type: "cancel", slot: { date: null, time: null, location: null } })).toEqual({ when: null, what: "Cancellation, no date or time" });
  });
});
