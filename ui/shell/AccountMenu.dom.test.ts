// 0015, S3, and review round 1 (R3): the account menu at the bottom of the
// sidebar, opened and clicked. Hosted mode has Settings, Usage, the theme
// and Sign out. Local mode has Settings and the theme only.
import { createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { installTestDom, mount, type TestDocument } from "../test-dom.ts";
import type { SignedInSession } from "../hosted/session.ts";
import { AccountMenu } from "./AccountMenu.tsx";
import { person, type View } from "./shell.ts";

let doc: TestDocument;
beforeAll(() => {
  doc = installTestDom();
});

const session: SignedInSession = {
  mode: "hosted",
  signedIn: true,
  account: { kind: "user", email: "dana@example.com", name: "Dana Demo" },
  balanceMicros: 4_870_000,
  balance: "$4.87",
  expiresAt: 0,
  passwordMin: 10,
};

async function menu(mode: "local" | "hosted", s: SignedInSession | null, onAddPasskey?: () => void) {
  const opened: View[] = [];
  let signedOut = 0;
  const ui = await mount(createElement(AccountMenu, { mode, who: person(s, null), session: s, compact: false, onOpen: (v: View) => opened.push(v), onSignOut: () => signedOut++, onAddPasskey }));
  const account = ui.find("[data-account-button]");
  const list = ui.find(".account-menu");
  const open = async () => {
    await ui.click(account);
    expect(list.shown).toBe(true);
    expect(account.getAttribute("aria-expanded")).toBe("true");
  };
  const items = () => list.querySelectorAll(".menu-item").map((b) => b.textContent);
  return { ui, account, list, open, items, opened, signedOut: () => signedOut };
}

describe("the account menu, opened", () => {
  it("0020, B9: an email account can add a passkey from the menu", async () => {
    let added = 0;
    const m = await menu("hosted", session, () => added++);
    await m.open();
    expect(m.items()[0]).toBe("Add a passkeySign in with your device instead of a password");
    await m.ui.click(m.ui.button("Add a passkey"));
    expect(added).toBe(1);
    expect(m.list.shown).toBe(false);
    const judge = await menu("hosted", { ...session, account: { kind: "judge", email: null, name: null } });
    await judge.open();
    expect(judge.items().some((t) => t?.startsWith("Add a passkey"))).toBe(false);
  });

  it("hosted: starts closed, opens, names the account and balance, and Settings, Usage and Sign out each do their part", async () => {
    const m = await menu("hosted", session);
    expect(m.account.getAttribute("aria-label")).toBe("Account: Dana Demo, Balance $4.87");
    expect(m.account.querySelector(".person-avatar")!.textContent).toBe("DD");
    expect(m.list.shown).toBe(false);
    await m.open();
    expect(m.list.textContent).toContain("dana@example.com");
    expect(m.list.textContent).toContain("Balance $4.87");
    expect(m.items()).toEqual(["SettingsTime zone, theme and Delete case", "UsageWhat each step cost, and how to get more", "Sign out"]);
    await m.ui.click(m.ui.button("Settings"));
    expect(m.opened).toEqual(["settings"]);
    expect(m.list.shown).toBe(false);
    await m.open();
    await m.ui.click(m.ui.button("Usage"));
    expect(m.opened).toEqual(["settings", "usage"]);
    await m.open();
    await m.ui.click(m.ui.button("Sign out"));
    expect(m.signedOut()).toBe(1);
    expect(m.list.shown).toBe(false);
    await m.ui.unmount();
  });

  it("local: Settings and the theme, no Usage, no Sign out and no balance", async () => {
    const m = await menu("local", null);
    expect(m.account.getAttribute("aria-label")).toBe("Account: You, This computer");
    await m.open();
    expect(m.items()).toEqual(["SettingsTime zone, theme and Delete case"]);
    expect(m.list.textContent).not.toMatch(/Usage|Sign out|Balance/);
    expect(m.list.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    await m.ui.click(m.ui.button("Settings"));
    expect(m.opened).toEqual(["settings"]);
    expect(m.signedOut()).toBe(0);
    await m.ui.unmount();
  });

  it("the theme switch in the menu sets the theme and keeps the menu open", async () => {
    const m = await menu("local", null);
    await m.open();
    await m.ui.click(m.list.querySelector('input[value="light"]')!);
    expect(doc.documentElement.dataset.theme).toBe("light");
    expect(m.list.shown).toBe(true);
    await m.ui.unmount();
  });

  it("Escape closes the menu and gives focus back to the account button", async () => {
    const m = await menu("hosted", session);
    await m.open();
    await m.ui.key(doc.body, "Escape");
    expect(m.list.shown).toBe(false);
    expect(doc.activeElement).toBe(m.account);
    await m.ui.unmount();
  });

  it("a judge account is named Judge access, never by a code", async () => {
    const judge: SignedInSession = { ...session, account: { kind: "judge", email: null, name: null } };
    const m = await menu("hosted", judge);
    expect(m.account.getAttribute("aria-label")).toBe("Account: Judge access, Balance $4.87");
    await m.open();
    expect(m.list.textContent).toContain("Judge access");
    await m.ui.unmount();
  });
});
