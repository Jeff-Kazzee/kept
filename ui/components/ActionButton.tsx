// A button that runs an action and stays disabled until it finishes, so a
// double tap does not send the same write twice.
import { useState, type ReactNode } from "react";

export type Run = (action: () => Promise<unknown>) => Promise<void>;

export function ActionButton({
  run,
  action,
  children,
  variant,
  disabled = false,
  label,
  block = false,
}: {
  run: Run;
  action: () => Promise<unknown>;
  children: ReactNode;
  variant?: "primary" | "danger" | "ghost";
  disabled?: boolean;
  label?: string;
  block?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const className = ["btn", variant ? `btn-${variant}` : "", block ? "btn-block" : ""].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-label={label}
      onClick={async () => {
        setBusy(true);
        try {
          await run(action);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}
