// The toasts: a sentence, and for the setup sentence or spent credit a
// button to Connections or Usage (0015, S8). Inert while the drawer or the
// schedule sheet is a modal, so the keyboard stays inside it.
import { Icon } from "../components/Icon.tsx";
import type { ToastLink, View } from "./shell.ts";

export type Toast = { id: number; kind: "error" | "info"; text: string; link?: ToastLink };

export function Toasts({ toasts, inert, onDismiss, onOpen }: { toasts: Toast[]; inert: boolean; onDismiss: (id: number) => void; onOpen: (view: View) => void }) {
  return (
    <div className="toasts" aria-live="polite" inert={inert}>
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <Icon name={t.kind === "error" ? "alert" : "info"} />
          <p>{t.text}</p>
          {t.link && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                onDismiss(t.id);
                onOpen(t.link!);
              }}
            >
              {t.link === "usage" ? "Open Usage" : "Open Connections"}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            <Icon name="close" size="sm" />
          </button>
        </div>
      ))}
    </div>
  );
}
