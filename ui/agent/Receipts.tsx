// The agent's actions in a turn as compact receipts: "Accepted 2 facts from
// Lantern Hill Clinic · Undo". Facts the agent decided about one message
// form one receipt. Every other action is its own receipt with the
// sentence code wrote for it. Undo reverses every entry of the receipt.
import { useState } from "react";
import type { AppState } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import type { ActivityEntry } from "../contract.ts";
import { canUndo, useAgent } from "./AgentContext.tsx";

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
      groups.push({ key: e.id, text: e.summary, entries: [e], messageId: null });
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
    g.text = claimsReceiptText(accepted, g.entries.length - accepted, message.message.from);
  }
  return groups;
}

export function Receipts({ entries, state, skipMessages }: { entries: ActivityEntry[]; state: AppState; skipMessages?: ReadonlySet<string> }) {
  const groups = groupReceipts(entries, state).filter((g) => g.messageId === null || !skipMessages?.has(g.messageId));
  if (groups.length === 0) return null;
  return (
    <ul className="receipts" aria-label="What the assistant did">
      {groups.map((g) => (
        <li key={g.key}>
          <Receipt text={g.text} entries={g.entries} />
        </li>
      ))}
    </ul>
  );
}

// One receipt line. Shows Undo while any of its entries can be undone,
// "Undone" once all are, and the plain reason when Undo was refused.
export function Receipt({ text, entries, quiet = false }: { text: string; entries: ActivityEntry[]; quiet?: boolean }) {
  const undone = entries.length > 0 && entries.every((e) => e.undone);
  return (
    <div className={`receipt${undone ? " is-undone" : ""}${quiet ? " is-quiet" : ""}`}>
      <span className="receipt-mark" aria-hidden="true">
        <Icon name={undone ? "undo" : "check"} size="sm" />
      </span>
      <span className="receipt-text">
        {text}
        {undone && <span className="muted"> · Undone</span>}
      </span>
      <UndoButton entries={entries} label={`Undo: ${text}`} />
      <BlockedReason entries={entries} />
    </div>
  );
}

// Undo for one or more entries, shown while any of them can be undone.
export function UndoButton({ entries, label }: { entries: ActivityEntry[]; label: string }) {
  const { undo } = useAgent();
  const [busy, setBusy] = useState(false);
  const open = entries.filter(canUndo);
  if (open.length === 0) return null;
  return (
    <button
      type="button"
      className="link-btn"
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label={label}
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
