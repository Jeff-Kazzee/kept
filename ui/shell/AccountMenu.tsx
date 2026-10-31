// The account button at the bottom of the sidebar and its menu (0015, S3
// and S4): the avatar, a name and one line under it. The menu lists the
// registry's account items for the mode: Settings, Usage (hosted), the
// theme switch and Sign out (hosted). On the hosted site it also says who
// is signed in and the balance, as 0014's top bar menu did.
import { useId } from "react";
import { Icon } from "../components/Icon.tsx";
import { useMenu } from "../components/Menu.tsx";
import type { SignedInSession } from "../hosted/session.ts";
import { ThemeSetting } from "../pages/shared.tsx";
import { itemsFor, type Mode, type Person, type View } from "./shell.ts";

const NOTES: Partial<Record<string, string>> = {
  settings: "Time zone, theme and Delete case",
  usage: "What each step cost, and how to get more",
};

export function Avatar({ who }: { who: Person }) {
  return (
    <span className="person-avatar" aria-hidden="true">
      {who.initials ?? <Icon name="user" size="sm" />}
    </span>
  );
}

export function AccountMenu({
  mode,
  who,
  session,
  compact,
  onOpen,
  onSignOut,
  onAddPasskey,
}: {
  mode: Mode;
  who: Person;
  session: SignedInSession | null;
  // The sidebar is a rail: the button shows the avatar only.
  compact: boolean;
  onOpen: (view: View) => void;
  onSignOut: () => void;
  // 0020, B9: an email account can add a passkey here.
  onAddPasskey?: (() => void) | undefined;
}) {
  const menu = useMenu();
  const id = useId();
  return (
    <div className="attach account">
      <button
        ref={menu.buttonRef}
        type="button"
        className="account-btn"
        data-account-button=""
        aria-expanded={menu.open}
        aria-controls={id}
        title={compact ? `${who.name} · ${who.line}` : undefined}
        onClick={() => menu.setOpen((o) => !o)}
      >
        <Avatar who={who} />
        <span className="person-text side-label">
          <span className="person-name">{who.name}</span>
          <span className="person-line">{who.line}</span>
        </span>
        <span className="side-label person-more">
          <Icon name="more" size="sm" />
        </span>
        {/* 0019: the name is the visible words and then what the button
            opens, so voice control can say what it sees. Folded to the
            rail, the words are for screen readers only. */}
        <span className="sr-only">{compact ? `${who.name}, ${who.line}, account menu` : ", account menu"}</span>
      </button>
      <div ref={menu.menuRef} id={id} className="menu account-menu" hidden={!menu.open}>
        {session && (
          <>
            <p className="menu-label">Signed in</p>
            <p className="menu-note">
              <strong>{who.name}</strong>
              {session.account.kind !== "judge" && session.account.email && session.account.name && (
                <>
                  <br />
                  <span className="small muted">{session.account.email}</span>
                </>
              )}
            </p>
            <p className="menu-note small">
              Balance <strong>{session.balance}</strong>
            </p>
            {session.account.pool && (
              <p className="menu-note small muted">
                This workspace stays on this browser while you are signed in. Signing out ends it: a new sign-in with the shared judge pass starts a fresh one.
              </p>
            )}
          </>
        )}
        {onAddPasskey && (
          <button type="button" className="menu-item" onClick={() => menu.choose(onAddPasskey)}>
            <Icon name="key" />
            <span>
              Add a passkey
              <small>Sign in with your device instead of a password</small>
            </span>
          </button>
        )}
        {itemsFor(mode, "account").map((item) => {
          if (item.id === "theme") {
            return (
              <div key={item.id} className="menu-theme">
                <ThemeSetting compact />
              </div>
            );
          }
          const view = item.view;
          return (
            <button key={item.id} type="button" className="menu-item" onClick={() => menu.choose(() => (view ? onOpen(view) : onSignOut()))}>
              <Icon name={item.icon} />
              <span>
                {item.label}
                {NOTES[item.id] && <small>{NOTES[item.id]}</small>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
