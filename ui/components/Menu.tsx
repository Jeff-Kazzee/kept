// A small menu that opens from a button, above it. It closes on Escape
// (focus goes back to the button), on a click outside and after a choice.
// Opening it moves focus to its first item.
import { useEffect, useRef, useState } from "react";

export function useMenu() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus());
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  const choose = (act: () => void) => {
    setOpen(false);
    act();
  };
  return { open, setOpen, buttonRef, menuRef, choose };
}
