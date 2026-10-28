// Layout helpers for the shell: which layout the window has, and finding a
// fact chip again to give focus back to it.
import { useEffect, useState } from "react";

// The schedule is a column (or a rail) beside the chat from this width up,
// and a sheet below it (styles.css uses the same breakpoints).
export const LAPTOP = "(min-width: 1024px)";

export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

// The chip that opened the schedule, by its message id and slot key, not
// by its element: the thread re-renders, and a streamed turn's chip gets
// its stored message id when the turn is saved (review 2, B6).
export type ChipRef = { messageId: string; slotKey: string };

export function chipRef(el: HTMLElement | undefined, slotKey: string): ChipRef | null {
  return el ? { messageId: el.dataset.chipMessage ?? "", slotKey } : null;
}

// Selectors to try in order: the same chip, then the last chip for the same
// slot (a stored message replaced the streamed one).
export function chipSelectors(ref: ChipRef): string[] {
  const slot = `[data-chip-slot="${CSS_ESCAPE(ref.slotKey)}"]`;
  return [`.fact-chip${slot}[data-chip-message="${CSS_ESCAPE(ref.messageId)}"]:not(:disabled)`, `.fact-chip${slot}:not(:disabled)`];
}

// Slot keys and message ids are plain ("2026-11-16T13:00", "cm12"). Quotes
// and backslashes are escaped all the same.
const CSS_ESCAPE = (s: string) => s.replace(/["\\]/g, "\\$&");

export function findChip(root: ParentNode, ref: ChipRef): HTMLElement | null {
  const [same, anySlot] = chipSelectors(ref);
  const exact = root.querySelector<HTMLElement>(same!);
  if (exact) return exact;
  const all = root.querySelectorAll<HTMLElement>(anySlot!);
  return all.length > 0 ? all[all.length - 1]! : null;
}
