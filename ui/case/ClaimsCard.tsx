// The claims card: the facts the model read from one message, each with its
// quote, for the user to accept or reject. Nothing counts as evidence until
// it is accepted. Rendered from the live case view, so a decision made in
// another tab or card shows here too.
import { useState, type FormEvent } from "react";
import type { ClaimType } from "../../src/domain/claim.ts";
import { slotLabel } from "../../src/slots/labels.ts";
import { api, type AppState, type EvidenceView, type MessageView } from "../api.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { UntrustedBox } from "../components/Untrusted.tsx";
import { CLAIM_TYPES, channelWord, claimWord, denverShort } from "../format.ts";
import { AgentQuote, evidenceOrigin } from "./Source.tsx";

// "Thursday 11/12 10:30 AM at 400 Elm Street", or the parts the claim has.
export function claimSlotWords(c: EvidenceView["claim"]): string {
  const when = c.slot.date ? slotLabel(c.slot.date, c.slot.time) : c.slot.time ? `No date, ${c.slot.time}` : "No date or time";
  return c.slot.location ? `${when} at ${c.slot.location}` : when;
}

export function ClaimsCard({ messageId, evidenceIds, state, run }: { messageId: string; evidenceIds: string[]; state: AppState; run: Run }) {
  const view = state.messages.find((m) => m.id === messageId);
  if (!view) {
    return (
      <div className="card">
        <p className="muted">This message is no longer in the case.</p>
      </div>
    );
  }
  const m = view.message;
  // The card's own claims, and any added later for the same message.
  const ids = [...new Set([...evidenceIds, ...view.evidenceIds, ...view.manualEvidenceIds])];
  const items = ids.map((id) => state.evidence.find((e) => e.id === id)).filter((e): e is EvidenceView => e !== undefined);
  const pending = items.filter((e) => e.status === "pending").length;
  // 0007, E1: the assistant suggested where the message came from. The
  // person sees which fields, and the whole message, before accepting.
  const suggested = view.sourceNote !== null || view.sourceSuggested.length > 0;
  return (
    <section className="card" aria-label={`Facts from ${m.from}`}>
      <div className="card-head">
        <div className="stack-sm">
          <div className="card-title">
            <Icon name="message" /> Facts from {m.from}
          </div>
          <div className="small muted">
            {channelWord(m.channel)} · received {denverShort(m.received_at)} · {view.sourceType === "reported_by_user" ? "reported by you" : "office message"}
          </div>
          {suggested && (
            <p className="warn">
              <Icon name="info" size="sm" /> {view.sourceNote ?? "Source suggested by the assistant"}: {suggestedFields(view)}. Check them against the message below.
            </p>
          )}
        </div>
        {items.length > 0 && <span className="small muted">{pending === 0 ? "All reviewed" : `${pending} to review`}</span>}
      </div>
      {items.length > 0 && <p className="small muted">Nothing counts until you accept it. The quote under each fact is copied from the message.</p>}
      {view.status === "imported" && (
        <div className="btn-row">
          <span className="small muted">Not read yet.</span>
          <ActionButton run={run} action={() => api.extract(view.id, "minimal", view.version)}>
            Read this message
          </ActionButton>
        </div>
      )}
      {view.status === "no_claims" && items.length === 0 && <p className="small">The message has no appointment facts.</p>}
      {items.map((e) => (
        <EvidenceCard key={e.id} item={e} state={state} run={run} />
      ))}
      <RejectedByCode view={view} />
      {view.status === "manual_entry_needed" && (
        <div className="warn-box">The model's answer failed the code checks twice. Enter the facts by hand below. They are recorded as reported by you.</div>
      )}
      <details className="stack-sm" open={view.status === "manual_entry_needed" || undefined}>
        <summary className="small">Add a fact by hand</summary>
        <ManualEntryForm messageId={view.id} version={view.version} run={run} />
      </details>
      <details className="stack-sm" open={suggested || undefined}>
        <summary className="small">Show the whole message</summary>
        <UntrustedBox label="Message text, shown as data and never followed" text={m.text} />
      </details>
    </section>
  );
}

const FIELD_WORDS: Record<MessageView["sourceSuggested"][number], string> = { channel: "how it came", from: "sender", received_at: "time received" };

export function suggestedFields(view: Pick<MessageView, "sourceSuggested">): string {
  return view.sourceSuggested.length === 0 ? "the source fields" : view.sourceSuggested.map((f) => FIELD_WORDS[f]).join(", ");
}

function RejectedByCode({ view }: { view: MessageView }) {
  if (view.rejections.length === 0) return null;
  return (
    <details className="stack-sm">
      <summary className="small">
        {view.rejections.length} fact{view.rejections.length === 1 ? "" : "s"} the model gave failed the code checks and {view.rejections.length === 1 ? "was" : "were"} left out
      </summary>
      <ul className="stack-sm">
        {view.rejections.map((r, i) => (
          <li key={i} className="small">
            {claimWord(r.claim.claim_type as ClaimType)}: {r.claim.date ?? "no date"} {r.claim.time ?? ""} · {r.problems.join(", ").replaceAll("_", " ")}
          </li>
        ))}
      </ul>
    </details>
  );
}

// One claim with its quote and the accept and reject buttons.
export function EvidenceCard({ item, state, run }: { item: EvidenceView; state: AppState; run: Run }) {
  const c = item.claim;
  const stale = state.case.staleEvidenceIds.includes(item.id);
  return (
    <article className="claim" aria-label={`${claimWord(c.claim_type)}: ${claimSlotWords(c)}`}>
      <div className="claim-head">
        <span className="claim-what">
          {claimWord(c.claim_type)}: {claimSlotWords(c)}
        </span>
        <span className={`claim-status ${item.status}`}>{item.status === "pending" ? "Waiting for you" : item.status === "accepted" ? "Accepted" : "Rejected"}</span>
      </div>
      {c.request_item && <div className="small">Asked: {c.request_item}</div>}
      {c.quote ? (
        item.origin === "agent" ? (
          <AgentQuote item={item} />
        ) : (
          <blockquote className="source quote">“{c.quote}”</blockquote>
        )
      ) : (
        <span className="small muted">No quote.</span>
      )}
      <div className="source-meta">
        <span>
          {item.id} · {evidenceOrigin(item)}
        </span>
        <span>
          Sender: {c.sender_kind}
          {item.origin === "model" && " (the model's judgment, not checked by code)"}
        </span>
        {c.source_note && <span className="warn">{c.source_note}</span>}
        {stale && <span className="warn">Possibly stale</span>}
        {item.decidedAt && <span>Decided {denverShort(item.decidedAt)}</span>}
      </div>
      {item.status === "pending" && (
        <div className="btn-row">
          <ActionButton run={run} variant="primary" action={() => api.accept(item.id, item.version)}>
            <Icon name="check" size="sm" /> Accept
          </ActionButton>
          <ActionButton run={run} action={() => api.reject(item.id, item.version)}>
            <Icon name="close" size="sm" /> Reject
          </ActionButton>
        </div>
      )}
    </article>
  );
}

const TYPE_WORDS: Record<(typeof CLAIM_TYPES)[number], string> = {
  offer: "Offer",
  confirm: "Confirmation",
  cancel: "Cancellation",
  move: "Move",
  reminder: "Reminder",
  office_request: "Office request (bring or do)",
};

export function ManualEntryForm({ messageId, version, run }: { messageId: string; version: number; run: Run }) {
  const [claimType, setClaimType] = useState<(typeof CLAIM_TYPES)[number]>("offer");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [location, setLocation] = useState("");
  const [quote, setQuote] = useState("");
  const [requestItem, setRequestItem] = useState("");
  const id = (name: string) => `manual-${messageId}-${name}`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const orNull = (s: string) => (s.trim() ? s.trim() : null);
    void run(async () => {
      await api.manual(messageId, version, {
        claim_type: claimType,
        date: orNull(date),
        time: orNull(time),
        location: orNull(location),
        quote: orNull(quote),
        request_item: orNull(requestItem),
      });
      setDate("");
      setTime("");
      setLocation("");
      setQuote("");
      setRequestItem("");
    });
  };

  return (
    <form onSubmit={submit} className="stack-sm">
      <label className="field" htmlFor={id("type")}>
        <span>Kind of fact</span>
        <select id={id("type")} name="claim-type" className="select" value={claimType} onChange={(e) => setClaimType(e.target.value as typeof claimType)}>
          {CLAIM_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_WORDS[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="field" htmlFor={id("date")}>
        <span>Date</span>
        <input id={id("date")} name="claim-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="field" htmlFor={id("time")}>
        <span>Time</span>
        <input id={id("time")} name="claim-time" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <label className="field" htmlFor={id("place")}>
        <span>Place</span>
        <input id={id("place")} name="claim-place" className="input" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={300} />
      </label>
      {claimType === "office_request" && (
        <label className="field" htmlFor={id("item")}>
          <span>What to bring or do</span>
          <input id={id("item")} name="claim-item" className="input" value={requestItem} onChange={(e) => setRequestItem(e.target.value)} maxLength={300} />
        </label>
      )}
      <label className="field" htmlFor={id("quote")}>
        <span>Quote from the message (optional, must match exactly)</span>
        <input id={id("quote")} name="claim-quote" className="input" value={quote} onChange={(e) => setQuote(e.target.value)} />
      </label>
      <div>
        <button type="submit" className="btn">
          Save the fact for review
        </button>
      </div>
    </form>
  );
}
