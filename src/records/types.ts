// Agent proposals were removed in sprint 8 (0009, J1): agents act, and the
// person undoes. The server no longer has proposals. This file stays only
// so the sprint 7B UI, which sprint 9 replaces, still builds. Delete it with
// ui/case/ProposalCard.tsx. Runs in the browser, so it must not import Node
// modules.
import type { ClaimType } from "../domain/claim.ts";
import { slotLabel } from "../slots/labels.ts";

// A change an agent proposed, before sprint 8.
export type ProposedChange =
  | {
      kind: "new_appointment";
      date: string;
      time: string;
      location: string | null;
      status: "offered" | "confirmed";
      statement: string;
    }
  | {
      kind: "user_report";
      claim_type: ClaimType;
      date: string | null;
      time: string | null;
      location: string | null;
      request_item: string | null;
      statement: string;
    }
  | { kind: "detail_edit"; appointment_id: string; location: string; statement: string }
  | { kind: "archive"; appointment_id: string; statement: string };

const REPORT_WORDS: Record<ClaimType, string> = {
  offer: "The office offered",
  confirm: "The office confirmed",
  cancel: "The office canceled",
  move: "The office moved the appointment to",
  reminder: "The office sent a reminder for",
  office_request: "The office asked you to bring or do something",
};

// "2026-11-16T13:00" as "Monday 11/16 1:00 PM".
function keyLabel(key: string): string {
  const [date, time] = key.split("T");
  return slotLabel(date!, time ?? null);
}

// What confirming the change would record, in plain words built by code
// from the kind, the claim type, dates and times. Places, items and the
// agent's statement are agent text, so they are not part of these words.
// The UI shows them in labeled untrusted fields.
export function describeChange(change: ProposedChange): string {
  switch (change.kind) {
    case "new_appointment":
      return `Add an appointment on ${slotLabel(change.date, change.time)}, ${change.status === "offered" ? "offered by the office" : "confirmed by the office"}.`;
    case "user_report": {
      const words = REPORT_WORDS[change.claim_type];
      if (change.claim_type === "office_request") return change.date === null ? `${words}.` : `${words} for ${slotLabel(change.date, change.time)}.`;
      return `${words} ${slotLabel(change.date!, change.time)}.`;
    }
    case "detail_edit":
      return `Correct the place of ${keyLabel(change.appointment_id)}.`;
    case "archive":
      return `Archive ${keyLabel(change.appointment_id)}. It leaves the default list. Undo brings it back.`;
  }
}
