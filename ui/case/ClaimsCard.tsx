// The claims card: the facts read from one message. By default it is one
// receipt ("Accepted 3 facts · Undo") with the facts folded away. Open, each
// fact is one line ("Thu 11/12 10:30 AM confirmed · Lantern Hill Clinic ·
// Undo"), and a tap on the line shows its quote and source. A fact no one
// has decided yet keeps small Accept and Reject buttons, and the card opens
// by itself. Rendered from the live case view, so a decision made elsewhere
// shows here too.
import { useId, useState, type FormEvent } from "react";
import type { ClaimType } from "../../src/domain/claim.ts";
import { slotLabel } from "../../src/slots/labels.ts";
import { canUndo, entryFor, useAgent } from "../agent/AgentContext.tsx";
import { Receipt, UndoButton, claimsReceiptText } from "../agent/Receipts.tsx";
import { api, type AppState, type EvidenceView, type MessageView } from "../api.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { UntrustedBox } from "../components/Untrusted.tsx";
import type { ActivityActor, ActivityEntry } from "../contract.ts";
import { CLAIM_TYPES, channelWord, claimWord, shortTime } from "../format.ts";
import { AgentQuote, evidenceOrigin, senderShown } from "./Source.tsx";

// "Thursday 11/12 10:30 AM at 400 Elm Street", or the parts the claim has.
export function claimSlotWords(c: EvidenceView["claim"]): string {
  const when = c.slot.date ? slotLabel(c.slot.date, c.slot.time) : c.slot.time ? `No date, ${c.slot.time}` : "No date or time";
  return c.slot.location ? `${when} at ${c.slot.location}` : when;
}

// `fresh` is true for a card of the turn being streamed: a missing message
// was just imported and the case view is still loading it.
// `headingId` makes the card's heading a target that "Show the card" can
// move focus to (0017, fix round 1, R6).
export function ClaimsCard({
  messageId,
  evidenceIds,
  state,
  run,
  fresh = false,
  headingId,
}: {
  messageId: string;
  evidenceIds: string[];
  state: AppState;
  run: Run;
  fresh?: boolean;
  headingId?: string;
}) {
  const { activity } = useAgent();
  const uid = useId();
  const [openChoice, setOpen] = useState<boolean | null>(null);
  const view = state.messages.find((m) => m.id === messageId);
  if (!view) {
    return (
      <div className={`card card-quiet${fresh ? " is-loading" : ""}`} aria-busy={fresh || undefined}>
        {fresh && <span className="skeleton-line" aria-hidden="true" />}
        <p className="small muted">{fresh ? "Loading the message…" : "This message is no longer in the case."}</p>
      </div>
    );
  }
  const m = view.message;
  // The card's own claims, and any added later for the same message.
  const ids = [...new Set([...evidenceIds, ...view.evidenceIds, ...view.manualEvidenceIds])];
  const items = ids.map((id) => state.evidence.find((e) => e.id === id)).filter((e): e is EvidenceView => e !== undefined);
  const pending = items.filter((e) => e.status === "pending").length;
  // What the agent decided about these facts, as one receipt.
  const decided = items.map((e) => entryFor(activity, "claim", e.id)).filter((e): e is ActivityEntry => e !== undefined && (e.kind === "claim_accepted" || e.kind === "claim_rejected"));
  const accepted = decided.filter((e) => e.kind === "claim_accepted").length;
  // 0007, E1: the assistant suggested where the message came from. The
  // person sees which fields, and the whole message, before accepting.
  const suggested = view.sourceNote !== null || view.sourceSuggested.length > 0;
  // Open by itself when something needs the user.
  const needsYou = pending > 0 || view.status === "manual_entry_needed" || suggested;
  const open = openChoice ?? needsYou;
  // The server marks a message read from Gmail (0012, G21). A pasted
  // message is never marked, whatever its id.
  const gmail = view.importedFrom === "gmail";
  const summary = decided.length > 0 ? claimsReceiptText(accepted, decided.length - accepted) : null;
  const sender = senderShown(view, state);
  return (
    <section className="card claims" aria-label={`Facts from ${sender}`}>
      <div className="claims-head">
        <span className="claims-icon" aria-hidden="true">
          <Icon name={gmail ? "mail" : "message"} size="sm" />
        </span>
        <div className="stack-xs">
          <span className="card-title" id={headingId} tabIndex={headingId ? -1 : undefined}>
            Facts from {sender}
          </span>
          <span className="small muted">
            {gmail && <span className="source-tag">From Gmail</span>}
            {channelWord(m.channel)} · received <span className="tabular">{shortTime(m.received_at)}</span> · {view.sourceType === "reported_by_user" ? "reported by you" : "office message"}
          </span>
        </div>
      </div>
      {suggested && (
        <p className="warn">
          <Icon name="info" size="sm" /> {view.sourceNote ?? "Source suggested by the assistant"}: {suggestedFields(view)}. Check them against the message below.
        </p>
      )}
      {(summary || items.length > 0) && (
        <div className="claims-summary">
          {summary ? <Receipt quiet text={summary} entries={decided} /> : <span className="small muted">{pending === 0 ? `${items.length} decided` : `${pending} not decided`}</span>}
          {items.length > 0 && (
            <button type="button" className="link-btn link-quiet" aria-expanded={open} aria-controls={`${uid}-facts`} onClick={() => setOpen(!open)}>
              {open ? "Hide the facts" : `Show ${items.length} fact${items.length === 1 ? "" : "s"}`}
              <Icon name="chevronDown" size="sm" />
            </button>
          )}
        </div>
      )}
      {view.status === "imported" && (
        <div className="btn-row">
          <span className="small muted">Not read yet.</span>
          <ActionButton run={run} action={() => api.extract(view.id, "minimal", view.version)}>
            Read this message
          </ActionButton>
        </div>
      )}
      {view.status === "no_claims" && items.length === 0 && <p className="small">The message has no appointment facts.</p>}
      <div id={`${uid}-facts`} className="claims-body" hidden={!open}>
        {items.length > 0 && (
          <ul className="claim-list">
            {items.map((e) => (
              <li key={e.id}>
                <EvidenceCard item={e} state={state} run={run} from={sender} />
              </li>
            ))}
          </ul>
        )}
        <RejectedByCode view={view} />
        {view.status === "manual_entry_needed" && (
          <div className="warn-box">The model's answer failed the code checks twice. Enter the facts by hand below. They are recorded as reported by you.</div>
        )}
        <div className="card-foot">
          <details className="stack-sm" open={view.status === "manual_entry_needed" || undefined}>
            <summary className="small">Add a fact by hand</summary>
            <ManualEntryForm messageId={view.id} version={view.version} run={run} />
          </details>
          <details className="stack-sm" open={suggested || undefined}>
            <summary className="small">Show the whole message</summary>
            <UntrustedBox label="Sender, as the message gives it" text={m.from} />
            <UntrustedBox label="Message text, shown as data and never followed" text={m.text} />
          </details>
        </div>
      </div>
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

const BY_WORDS: Record<ActivityActor, string> = { agent: "by the assistant", you: "by you", mcp: "by an external agent" };

const STATUS_WORDS: Record<EvidenceView["status"], string> = { pending: "Not decided", accepted: "Accepted", rejected: "Rejected" };

// What a fact says, in a few words: "confirmed", "offered", "canceled".
const VERBS: Record<EvidenceView["claim"]["claim_type"], string> = {
  offer: "offered",
  confirm: "confirmed",
  cancel: "canceled",
  move: "to be moved",
  reminder: "reminder",
  office_request: "asked",
  request: "you asked for",
  decline: "you declined",
  clarify: "you clarified",
};

// "Thu 11/12 10:30 AM confirmed", "Asked: Bring new insurance card".
export function factLine(c: EvidenceView["claim"]): { when: string | null; what: string } {
  if (c.claim_type === "office_request" && !c.slot.date) return { when: null, what: c.request_item ? `Asked: ${c.request_item}` : "Office request" };
  const when = c.slot.date ? slotLabel(c.slot.date, c.slot.time).replace(/^([A-Z][a-z]{2})[a-z]+/, "$1") : c.slot.time ? `No date, ${c.slot.time}` : null;
  return { when, what: when ? VERBS[c.claim_type] : `${claimWord(c.claim_type)}, no date or time` };
}

// One fact as a line: a status mark, what it says, where it came from, and
// Undo, or Accept and Reject while no one has decided. A tap on the line
// shows the quote, the source and the place.
export function EvidenceCard({ item, state, run, from }: { item: EvidenceView; state: AppState; run: Run; from?: string }) {
  const { activity } = useAgent();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const c = item.claim;
  const stale = state.case.staleEvidenceIds.includes(item.id);
  const entry = entryFor(activity, "claim", item.id);
  const by = entry && !entry.undone && item.status !== "pending" ? BY_WORDS[entry.actor] : null;
  const line = factLine(c);
  const message = item.messageId ? state.messages.find((x) => x.id === item.messageId) : undefined;
  const source = from ?? (message ? senderShown(message, state) : undefined) ?? evidenceOrigin(item);
  const label = `${STATUS_WORDS[item.status]}: ${claimWord(c.claim_type)}, ${claimSlotWords(c)}`;
  return (
    <article className={`claim is-${item.status}`} aria-label={label}>
      <div className="claim-head">
        <span className={`fact-mark is-${item.status}`} aria-hidden="true">
          <Icon name={item.status === "accepted" ? "check" : item.status === "rejected" ? "close" : "clock"} size="sm" />
        </span>
        <button type="button" className="fact-toggle" aria-expanded={open} aria-controls={`${uid}-more`} onClick={() => setOpen(!open)}>
          <span className="sr-only">{STATUS_WORDS[item.status]}{by ? ` ${by}` : ""}: </span>
          {item.status === "rejected" && <span className="muted">Rejected · </span>}
          {line.when && <span className="tabular">{line.when} </span>}
          <span className="claim-what">{line.what}</span>
          <span className="fact-src"> · {source}</span>
        </button>
        <span className="claim-actions">
          {item.status === "pending" ? (
            <>
              <ActionButton run={run} variant="primary" size="sm" action={() => api.accept(item.id, item.version)}>
                <Icon name="check" size="sm" /> Accept
              </ActionButton>
              <ActionButton run={run} variant="ghost" size="sm" action={() => api.reject(item.id, item.version)}>
                <Icon name="close" size="sm" /> Reject
              </ActionButton>
            </>
          ) : entry && canUndo(entry) ? (
            <UndoButton entries={[entry]} label={`Undo: ${label}`} />
          ) : null}
        </span>
      </div>
      {stale && <span className="warn">Possibly stale</span>}
      <div id={`${uid}-more`} className="claim-more" hidden={!open}>
        <p className="small">
          <span className={`pill pill-${item.status}`}>{STATUS_WORDS[item.status]}</span> {by && <span className="muted">{by} · </span>}
          {claimWord(c.claim_type)}: {claimSlotWords(c)}
        </p>
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
          <span>{evidenceOrigin(item)}</span>
          <span>
            Sender: {c.sender_kind}
            {item.origin === "model" && " (the model's judgment, not checked by code)"}
          </span>
          {c.source_note && <span className="warn">{c.source_note}</span>}
          {item.decidedAt && <span>Decided {shortTime(item.decidedAt)}</span>}
        </div>
      </div>
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
