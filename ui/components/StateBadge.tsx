// A slot state as a badge: a colored dot and the state in words, so the
// color is never the only signal.
import type { SlotState } from "../../src/domain/claim.ts";

const WORDS: Record<SlotState, string> = {
  offered: "Offered",
  requested: "Requested",
  confirmed: "Confirmed",
  change_proposed: "Confirmed, change proposed",
  canceled: "Canceled",
  declined: "Declined",
};

export function StateBadge({ state }: { state: SlotState }) {
  return <span className={`badge badge-${state}`}>{WORDS[state]}</span>;
}
