// The left sidebar (0015): the mark and the app name, the registry's nav
// items for the mode, and the account button at the bottom. It is 248 px
// on a laptop and folds to a 64 px rail, is the rail on a tablet, and a
// modal drawer on a phone. A div, not an aside, because the drawer is a
// dialog (SP12.7).
import type { RefObject } from "react";
import { Mark } from "../components/Art.tsx";
import { Icon } from "../components/Icon.tsx";
import type { SignedInSession } from "../hosted/session.ts";
import { AccountMenu } from "./AccountMenu.tsx";
import { itemsFor, type Mode, type Person, type View } from "./shell.ts";

export type SideLayout = "full" | "rail" | "drawer";

export function Sidebar({
  mode,
  layout,
  view,
  who,
  session,
  waiting,
  drawerOpen,
  inert,
  folded,
  closeRef,
  onFold,
  onClose,
  onOpen,
  onSignOut,
}: {
  mode: Mode;
  layout: SideLayout;
  view: View;
  who: Person;
  session: SignedInSession | null;
  // How many things wait for the person, shown on Case.
  waiting: number;
  drawerOpen: boolean;
  inert: boolean;
  // On a laptop: folded to the rail. Null where the sidebar cannot fold.
  folded: boolean | null;
  closeRef: RefObject<HTMLButtonElement | null>;
  onFold: () => void;
  onClose: () => void;
  onOpen: (view: View) => void;
  onSignOut: () => void;
}) {
  const compact = layout === "rail";
  const modal = layout === "drawer" && drawerOpen;
  return (
    <div id="sidebar" className="sidebar" role={modal ? "dialog" : undefined} aria-modal={modal || undefined} aria-label={modal ? "Menu" : undefined} inert={inert}>
      <div className="side-head">
        {!(compact && folded !== null) && (
          <span className="brand-mark" aria-hidden="true">
            <Mark size={20} />
          </span>
        )}
        <span className="side-name side-label">Appointment assistant</span>
        {folded !== null && (
          <button
            type="button"
            className="btn btn-ghost btn-icon side-fold"
            aria-expanded={!folded}
            aria-controls="sidebar-nav"
            aria-label={folded ? "Open the sidebar" : "Fold the sidebar"}
            title={folded ? "Open the sidebar" : "Fold the sidebar"}
            onClick={onFold}
          >
            <Icon name="sidebar" />
          </button>
        )}
        {layout === "drawer" && (
          <button ref={closeRef} type="button" className="btn btn-ghost btn-icon side-close" aria-label="Close the menu" onClick={onClose}>
            <Icon name="close" />
          </button>
        )}
      </div>
      <nav id="sidebar-nav" className="side-nav" aria-label="Main">
        {itemsFor(mode, "nav").map((item) => (
          <button
            key={item.id}
            type="button"
            className="side-item"
            aria-current={view === item.view ? "page" : undefined}
            aria-label={compact ? `${item.label}${item.id === "case" && waiting > 0 ? `, ${waiting} waiting for you` : ""}` : undefined}
            title={compact ? item.label : undefined}
            onClick={() => onOpen(item.view!)}
          >
            <Icon name={item.icon} />
            <span className="side-label">{item.label}</span>
            {item.id === "case" && waiting > 0 && (
              <span className="count" aria-label={`${waiting} waiting for you`}>
                {waiting}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="side-foot">
        <AccountMenu mode={mode} who={who} session={session} compact={compact} onOpen={onOpen} onSignOut={onSignOut} />
      </div>
    </div>
  );
}
