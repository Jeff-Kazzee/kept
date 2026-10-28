// The account menu in the hosted site's top bar (0014, design item 6):
// who is signed in, the balance, Usage and Sign out.
import { useId } from "react";
import { Icon } from "../components/Icon.tsx";
import { useMenu } from "../components/Menu.tsx";
import { accountLabel, type SignedInSession } from "./session.ts";

export function AccountMenu({ session, onUsage, onSignOut }: { session: SignedInSession; onUsage: () => void; onSignOut: () => void }) {
  const menu = useMenu();
  const id = useId();
  const who = accountLabel(session.account);
  return (
    <div className="attach account">
      <button
        ref={menu.buttonRef}
        type="button"
        className="btn btn-ghost account-btn"
        aria-expanded={menu.open}
        aria-controls={id}
        aria-label={`Account: ${who}. Balance ${session.balance}`}
        onClick={() => menu.setOpen((o) => !o)}
      >
        <Icon name="user" size="sm" />
        <span className="account-balance">{session.balance}</span>
      </button>
      <div ref={menu.menuRef} id={id} className="menu menu-down" hidden={!menu.open}>
        <p className="menu-label">Signed in</p>
        <p className="menu-note">
          <strong>{who}</strong>
          {session.account.kind === "google" && session.account.email && session.account.name && (
            <>
              <br />
              <span className="small muted">{session.account.email}</span>
            </>
          )}
        </p>
        <p className="menu-note small">
          Balance <strong>{session.balance}</strong>
        </p>
        <button type="button" className="menu-item" onClick={() => menu.choose(onUsage)}>
          <Icon name="activity" />
          <span>
            Usage and credit
            <small>What each step cost, and how to get more</small>
          </span>
        </button>
        <button type="button" className="menu-item" onClick={() => menu.choose(onSignOut)}>
          <Icon name="close" />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
}
