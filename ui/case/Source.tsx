// Evidence as a source: where it came from and its quote. Quotes from a
// message are shown as quoted data. A confirmed agent report's quote is the
// agent's own statement, so it stays in a labeled untrusted box.
import { untrustedLabel } from "../../src/domain/untrusted.ts";
import { sourceLabel } from "../../src/slots/labels.ts";
import type { AppState, EvidenceView, MessageView } from "../api.ts";
import { officeNameOf, senderName } from "../../src/reply/office.ts";
import { UntrustedBox } from "../components/Untrusted.tsx";
import { channelWord, claimWord, shortTime } from "../format.ts";

// "reported by you through <grant name>" for a confirmed agent report. The
// name is the grant's, stored on the evidence when the user confirmed it,
// never a name the agent's client reported.
export const agentSource = (item: EvidenceView) => sourceLabel("reported_by_user_via_agent", item.claim.agent_name ?? null);

// Where an evidence item came from.
export function evidenceOrigin(item: EvidenceView): string {
  switch (item.origin) {
    case "model":
      return "Model output, passed the quote check";
    case "answer":
      return "Your answer to a question";
    case "reply":
      return "Your approved reply (simulated send)";
    case "agent": {
      const label = agentSource(item);
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
    case "manual":
      return "Entered by you";
  }
}

// The words of the source as a short phrase: "office message", "your
// answer" and so on.
export function sourcePhrase(item: EvidenceView): string {
  if (item.origin === "answer") return "your answer";
  if (item.origin === "reply") return "your approved reply";
  if (item.origin === "agent") return agentSource(item);
  return item.claim.source_type === "office_message" ? "office message" : "reported by you";
}

// Text an agent wrote, shown as data in a labeled box.
export function UntrustedText({ label, text }: { label: string; text: string }) {
  return <UntrustedBox label={untrustedLabel(label)} text={text} />;
}

export function AgentQuote({ item }: { item: EvidenceView }) {
  return <UntrustedText label={`Words from ${item.claim.agent_name ?? "an agent"}`} text={item.claim.quote ?? ""} />;
}

// The slot a claim names, in words: "Thursday 11/12 10:30 AM · 400 Elm Street".
export function claimSlotText(c: EvidenceView["claim"]): string {
  const parts = [c.slot.date ?? "No date", c.slot.time ?? "no time"];
  if (c.slot.location) parts.push(c.slot.location);
  return parts.join(" · ");
}

// 0016, C1 and C2: the sender as the page names it: the office by the name
// the case holds for it, never an email address. The full sender line
// shows only with the whole message.
export function senderShown(m: MessageView, state: Pick<AppState, "evidence" | "messages">): string {
  return officeNameOf(m, state.evidence, state.messages) ?? senderName(m.message.from) ?? "an unknown sender";
}

// One evidence item as a source card.
export function SourceQuote({ id, state }: { id: string; state: AppState }) {
  const item = state.evidence.find((e) => e.id === id);
  if (!item) return <div className="source">This fact is no longer in the case.</div>;
  const c = item.claim;
  const message = state.messages.find((m) => m.id === item.messageId);
  return (
    <figure className="source">
      <figcaption className="source-meta">
        <span>
          {claimWord(c.claim_type)} · {sourcePhrase(item)}
        </span>
        {message && (
          <span>
            {senderShown(message, state)} · {channelWord(message.message.channel)} · {shortTime(message.message.received_at)}
          </span>
        )}
        {state.case.staleEvidenceIds.includes(id) && <span className="warn">Possibly stale</span>}
      </figcaption>
      {c.quote ? item.origin === "agent" ? <AgentQuote item={item} /> : <blockquote className="quote">“{c.quote}”</blockquote> : <span className="muted">No quote.</span>}
    </figure>
  );
}
