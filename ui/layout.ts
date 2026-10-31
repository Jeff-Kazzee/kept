// Layout helpers for the shell: which layout the window has, and finding a
// fact chip again to give focus back to it.
import { useCallback, useSyncExternalStore } from "react";

// The schedule is a column (or a rail) beside the chat from this width up,
// and a sheet below it (styles.css uses the same breakpoints). The sidebar
// is 248 px or a rail from this width up (0015).
export const LAPTOP = "(min-width: 1024px)";

// The sidebar is a rail from this width up, and a drawer below it (0015).
export const TABLET_UP = "(min-width: 768px)";

// 0019, round 3: the layout a server-rendered page was rendered in, set
// before the render on both sides from the boot data, so hydration reads
// the same answers. A phone is rendered as a phone (the browser's mobile
// hint), so its first paint carries no hidden schedule to hydrate.
let renderedView: "phone" | "laptop" = "laptop";
export const setRenderedView = (v: "phone" | "laptop" | undefined) => void (renderedView = v ?? "laptop");
export const renderedAs = () => renderedView;

// 0019, P30: the server renders a laptop, so `serverValue` is what a
// media query reads there and while the page hydrates. React then renders
// again with the device's own answer.
export function useMedia(query: string, serverValue = false): boolean {
  const subscribe = useCallback(
    (change: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", change);
      return () => list.removeEventListener("change", change);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => serverValue);
}

// Moves focus to an element once it can take it. A sheet or the drawer
// that just opened refuses focus for a frame or two while it slides in, so
// this tries again each frame, up to about half a second (0015).
export function focusSoon(target: () => HTMLElement | null, frames = 30): void {
  const attempt = (left: number) =>
    requestAnimationFrame(() => {
      const el = target();
      el?.focus({ preventScroll: true });
      // 0019: also while the target is not there yet, as a sheet that
      // mounts on its first open (P19).
      if ((!el || document.activeElement !== el) && left > 0) attempt(left - 1);
    });
  attempt(frames);
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
