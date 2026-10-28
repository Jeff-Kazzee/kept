// A small "i" button that shows a short explanation beside a heading, so a
// panel does not carry paragraphs of fine print. Escape or a click outside
// closes it. The same words are in Settings, About this app.
import { useId, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import { useMenu } from "./Menu.tsx";

export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const tip = useMenu();
  const id = useId();
  return (
    <span className="infotip">
      <button ref={tip.buttonRef} type="button" className="infotip-btn" aria-label={label} aria-expanded={tip.open} aria-controls={id} onClick={() => tip.setOpen((o) => !o)}>
        <Icon name="info" size="sm" />
      </button>
      <div ref={tip.menuRef} id={id} role="note" className="infotip-body" hidden={!tip.open}>
        {children}
      </div>
    </span>
  );
}
