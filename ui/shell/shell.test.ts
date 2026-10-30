// 0015: the sidebar registry by mode, the view each item opens, and who the
// account button names.
import { describe, expect, it } from "vitest";
import { GOOGLE_OFF } from "../contract.ts";
import type { SignedInSession } from "../hosted/session.ts";
import { SIDEBAR, VIEW_TITLES, initials, itemsFor, person, viewIn } from "./shell.ts";

const hosted = (account: SignedInSession["account"]): SignedInSession => ({ mode: "hosted", signedIn: true, account, balanceMicros: 4_870_000, balance: "$4.87", expiresAt: 0, passwordMin: 10 });

describe("the sidebar registry", () => {
  it("local mode lists Case, Connections and Agent access, and its account menu has no Usage and no Sign out", () => {
    expect(itemsFor("local", "nav").map((i) => i.id)).toEqual(["case", "connections", "access"]);
    expect(itemsFor("local", "account").map((i) => i.id)).toEqual(["settings", "theme"]);
  });

  it("hosted mode has Usage and Sign out, and no Agent access, because MCP runs locally only", () => {
    expect(itemsFor("hosted", "nav").map((i) => i.id)).toEqual(["case", "connections"]);
    expect(itemsFor("hosted", "account").map((i) => i.id)).toEqual(["settings", "usage", "theme", "signout"]);
  });

  it("each item opens its own view, and Theme and Sign out act in place", () => {
    for (const item of SIDEBAR) {
      if (item.id === "theme" || item.id === "signout") expect(item.view).toBeNull();
      else expect(item.view).toBe(item.id);
    }
    for (const item of SIDEBAR) if (item.view) expect(VIEW_TITLES[item.view]).toBeTruthy();
  });

  it("a view the mode does not have falls back to the case", () => {
    expect(viewIn("local", "usage")).toBe("case");
    expect(viewIn("hosted", "access")).toBe("case");
    expect(viewIn("hosted", "usage")).toBe("usage");
    expect(viewIn("local", "access")).toBe("access");
  });
});

describe("initials", () => {
  it("come from the first and last word of a name", () => {
    expect(initials("Dana Reyes", "x@example.com")).toBe("DR");
    expect(initials("Dana Q. Reyes", null)).toBe("DR");
    expect(initials("dana", null)).toBe("D");
  });

  it("come from the email when there is no name", () => {
    expect(initials(null, "dana.reyes@example.com")).toBe("DR");
    expect(initials("  ", "dana@example.com")).toBe("D");
  });

  it("are null with neither", () => {
    expect(initials(null, null)).toBeNull();
    expect(initials("", "")).toBeNull();
    expect(initials("...", null)).toBeNull();
  });
});

describe("the account button", () => {
  it("local mode shows You and This computer, with a person icon until Google is connected", () => {
    expect(person(null, null)).toEqual({ initials: null, name: "You", line: "This computer" });
    expect(person(null, { ...GOOGLE_OFF, configured: true, connected: true, email: "dana.reyes@example.com" })).toEqual({ initials: "DR", name: "You", line: "This computer" });
    // A disconnected account's last email lends nothing.
    expect(person(null, { ...GOOGLE_OFF, configured: true, connected: false, email: "dana.reyes@example.com" }).initials).toBeNull();
  });

  it("a hosted email account shows its name, initials and balance", () => {
    expect(person(hosted({ kind: "user", name: "Dana Demo", email: "dana@example.com" }), null)).toEqual({ initials: "DD", name: "Dana Demo", line: "Balance $4.87" });
    expect(person(hosted({ kind: "user", name: null, email: "dana@example.com" }), null).name).toBe("dana@example.com");
  });

  it("a judge account shows Judge access and never a code", () => {
    const p = person(hosted({ kind: "judge", name: null, email: null }), null);
    expect(p).toEqual({ initials: null, name: "Judge access", line: "Balance $4.87" });
  });
});
