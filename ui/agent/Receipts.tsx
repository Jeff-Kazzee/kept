// The agent's actions in a turn as compact receipts: "Accepted 2 facts from
// Lantern Hill Clinic · Undo". Facts the agent decided about one message
// form one receipt. Every other action is its own receipt with the
// sentence code wrote for it. Undo reverses every entry of the receipt.
// 0019, P5: a turn's receipts sit as rows of one quiet group under its
// words. With three or more, a one-line summary folds them, and each row
// keeps its own Undo when opened.
import { useEffect, useId, useRef, useState } from "react";
import type { AppState } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import type { ActivityEntry } from "../contract.ts";
import { entryText } from "../../src/activity/types.ts";
import { senderShown } from "../case/Source.tsx";
import { canUndo, removedInGoogle, useAgent } from "./AgentContext.tsx";

export type ReceiptGroup = { key: string; text: string; entries: ActivityEntry[]; messageId: string | null };

const CLAIM_KINDS = new Set(["claim_accepted", "claim_rejected"]);

const facts = (n: number) => `${n} fact${n === 1 ? "" : "s"}`;

// "Accepted 2 facts from Lantern Hill Clinic", "Accepted 1 fact and
// rejected 1 from Lantern Hill Clinic".
// Without a sender, as on the card that already names it: "Accepted 2 facts".
export function claimsReceiptText(accepted: number, rejected: number, from?: string): string {
  const tail = from ? ` from ${from}` : "";
  if (accepted > 0 && rejected > 0) return `Accepted ${facts(accepted)} and rejected ${rejected}${tail}`;
  return accepted > 0 ? `Accepted ${facts(accepted)}${tail}` : `Rejected ${facts(rejected)}${tail}`;
}

// Groups a turn's entries into receipts, in the order they happened.
export function groupReceipts(entries: ActivityEntry[], state: Pick<AppState, "evidence" | "messages">): ReceiptGroup[] {
  const groups: ReceiptGroup[] = [];
  const byMessage = new Map<string, ReceiptGroup>();
  for (const e of entries) {
    const evidence = CLAIM_KINDS.has(e.kind) && e.target?.type === "claim" ? state.evidence.find((x) => x.id === e.target!.id) : undefined;
    const messageId = evidence?.messageId ?? null;
    const message = messageId ? state.messages.find((m) => m.id === messageId) : undefined;
    if (!evidence || !message) {
      groups.push({ key: e.id, text: entryText(e), entries: [e], messageId: null });
      continue;
    }
    let g = byMessage.get(message.id);
    if (!g) {
      g = { key: `claims-${message.id}-${e.id}`, text: "", entries: [], messageId: message.id };
      byMessage.set(message.id, g);
      groups.push(g);
    }
    g.entries.push(e);
    const accepted = g.entries.filter((x) => x.kind === "claim_accepted").length;
    g.text = claimsReceiptText(accepted, g.entries.length - accepted, senderShown(message, state));
  }
  return groups;
}

// The folded group's one line: "3 actions · Accepted 2 facts from Lantern
// Hill Clinic, and 2 more". Written by code from the receipts' own words.
export const FOLD_AT = 3;
// Round 2, finding 8: it counts actions, the entries, not the rows a
// claims receipt merges them into.
export function groupSummary(groups: Array<Pick<ReceiptGroup, "text" | "entries">>): string {
  const entries = groups.flatMap((g) => g.entries);
  const undone = entries.filter((e) => e.undone).length;
  const first = groups[0]?.text ?? "";
  const more = groups.length - 1;
  const tail = undone > 0 ? ` · ${undone} undone` : "";
  return `${entries.length} action${entries.length === 1 ? "" : "s"} · ${first}${more > 0 ? `, and ${more} more` : ""}${tail}`;
}

export function Receipts({ entries, state, skipMessages }: { entries: ActivityEntry[]; state: AppState; skipMessages?: ReadonlySet<string> }) {
  const { activity, google, blocked, blockedAt } = useAgent();
  const uid = useId();
  const groups = groupReceipts(entries, state).filter((g) => g.messageId === null || !skipMessages?.has(g.messageId));
  // A refused Undo opens the group, so its reason is in view. Round 2,
  // finding 3: each new refusal opens it again, even after the person
  // closed it, and brings the reason into view.
  // Muse round 2, finding 5: keyed on when each refusal came, so the same
  // refusal again, with the same words, opens the group again too.
  const refusals = groups
    .flatMap((g) => g.entries)
    .filter((e) => blocked[e.id])
    .map((e) => `${e.id}:${blockedAt[e.id] ?? 0}`)
    .join("|");
  const [openChoice, setOpen] = useState<boolean | null>(null);
  const [seen, setSeen] = useState(refusals);
  if (refusals !== seen) {
    setSeen(refusals);
    if (refusals !== "") setOpen(true);
  }
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (refusals === "") return;
    const frame = requestAnimationFrame(() => box.current?.querySelector(".receipt-blocked")?.scrollIntoView?.({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [refusals]);
  if (groups.length === 0) return null;
  const folds = groups.length >= FOLD_AT;
  const open = !folds || (openChoice ?? refusals !== "");
  return (
    <div ref={box} className={`receipt-group${folds ? " is-folding" : ""}`}>
      {folds && (
        <button type="button" className="receipt-summary" aria-expanded={open} aria-controls={`${uid}-rows`} onClick={() => setOpen(!open)}>
          <span className="receipt-mark" aria-hidden="true">
            <Icon name="check" size="sm" />
          </span>
          <span className="receipt-text">{groupSummary(groups)}</span>
          <Icon name="chevronDown" size="sm" />
        </button>
      )}
      <ul id={`${uid}-rows`} className="receipts" aria-label="What the assistant did" hidden={!open}>
        {groups.map((g) => (
          <li key={g.key}>
            <Receipt text={g.text} entries={g.entries} gone={g.entries.length === 1 && removedInGoogle(activity, google?.calendarOwn, g.entries[0]!)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// One receipt line. Shows Undo while any of its entries can be undone,
// "Undone" once all are, and the plain reason when Undo was refused.
// `gone`: the Google Calendar event it added is already removed in Google
// Calendar, so it says so and offers no Undo (0018, H5).
export function Receipt({ text, entries, quiet = false, gone = false }: { text: string; entries: ActivityEntry[]; quiet?: boolean; gone?: boolean }) {
  const undone = entries.length > 0 && entries.every((e) => e.undone);
  return (
    <div className={`receipt${undone || gone ? " is-undone" : ""}${quiet ? " is-quiet" : ""}`}>
      <span className="receipt-mark" aria-hidden="true">
        <Icon name={undone ? "undo" : gone ? "google" : "check"} size="sm" />
      </span>
      <span className="receipt-text">
        {text}
        {undone && <span className="muted"> · Undone</span>}
        {gone && !undone && <span className="muted"> · Since removed in Google Calendar</span>}
      </span>
      {!gone && <UndoButton entries={entries} label={`Undo: ${text}`} />}
      <BlockedReason entries={entries} />
    </div>
  );
}

// Undo for one or more entries, shown while any of them can be undone.
export function UndoButton({ entries, label }: { entries: ActivityEntry[]; label: string }) {
  const { undo, undoBusy } = useAgent();
  const [busy, setBusy] = useState(false);
  const open = entries.filter(canUndo);
  if (open.length === 0) return null;
  return (
    <button
      type="button"
      className="link-btn"
      disabled={busy || undoBusy}
      aria-busy={busy || undefined}
      aria-label={label}
      title={undoBusy && !busy ? "Undo waits until the assistant finishes" : undefined}
      onClick={async () => {
        setBusy(true);
        try {
          await undo(open.map((e) => e.id));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="undo" size="sm" /> Undo
    </button>
  );
}

// Why Undo was refused, in the server's words.
export function BlockedReason({ entries }: { entries: ActivityEntry[] }) {
  const { blocked } = useAgent();
  const reason = entries.map((e) => blocked[e.id]).find(Boolean);
  return reason ? (
    <p className="receipt-blocked" role="status">
      {reason}
    </p>
  ) : null;
}
