// The app shell's model (0015): the view the work area shows, the one
// registry of sidebar items, and who the account button names. Components
// read the registry for the mode instead of branching on the mode
// themselves.
import { ApiError } from "../api.ts";
import type { IconName } from "../components/Icon.tsx";
import type { GoogleStatus } from "../contract.ts";
import type { SignedInSession } from "../hosted/session.ts";

export type Mode = "local" | "hosted";

// What the work area shows: the case (the chat and the schedule panel), or
// one of the sidebar's pages in its place.
export type View = "case" | "connections" | "access" | "settings" | "usage";

export type SidebarItem = {
  id: "case" | "connections" | "access" | "settings" | "usage" | "theme" | "signout";
  label: string;
  icon: IconName;
  // "nav" items are the sidebar's list. "account" items are in the account
  // menu at the bottom.
  place: "nav" | "account";
  // The view the item opens. Theme and Sign out act where they are.
  view: View | null;
  modes: readonly Mode[];
};

const BOTH: readonly Mode[] = ["local", "hosted"];

export const SIDEBAR: readonly SidebarItem[] = [
  { id: "case", label: "Case", icon: "chat", place: "nav", view: "case", modes: BOTH },
  { id: "connections", label: "Connections", icon: "google", place: "nav", view: "connections", modes: BOTH },
  // The MCP server runs in local mode only (0014, A4).
  { id: "access", label: "Agent access", icon: "robot", place: "nav", view: "access", modes: ["local"] },
  { id: "settings", label: "Settings", icon: "settings", place: "account", view: "settings", modes: BOTH },
  { id: "usage", label: "Usage", icon: "activity", place: "account", view: "usage", modes: ["hosted"] },
  { id: "theme", label: "Theme", icon: "moon", place: "account", view: null, modes: BOTH },
  { id: "signout", label: "Sign out", icon: "close", place: "account", view: null, modes: ["hosted"] },
];

export const itemsFor = (mode: Mode, place: SidebarItem["place"]) => SIDEBAR.filter((i) => i.place === place && i.modes.includes(mode));

// A view this mode has. Opening any other view shows the case.
export const viewIn = (mode: Mode, view: View): View => (SIDEBAR.some((i) => i.view === view && i.modes.includes(mode)) ? view : "case");

// The work area's heading for each view.
export const VIEW_TITLES: Record<View, string> = {
  case: "Your case",
  connections: "Connections",
  access: "Agent access",
  settings: "Settings",
  usage: "Usage",
};

// Which parts of the shell are modal and which are inert (S5, S7, R1).
// Below a laptop the schedule is a sheet: at the side on a tablet, at the
// bottom on a phone, a modal dialog while open (review 2, B4). On a phone
// the sidebar is a modal drawer the same way. While either is open every
// other part is inert, the toasts included, so the keyboard stays inside.
// A sidebar page covers the case, which is inert under it.
export type ShellFlags = { laptop: boolean; phone: boolean; sheetOpen: boolean; drawerOpen: boolean; railed: boolean; view: View };

export function shellModes(f: ShellFlags) {
  const pageOpen = f.view !== "case";
  const sheetModal = !f.laptop && f.sheetOpen && !pageOpen;
  const drawerModal = f.phone && f.drawerOpen;
  const panelShown = f.laptop ? !f.railed : f.sheetOpen;
  const modal = sheetModal || drawerModal;
  return {
    pageOpen,
    sheetModal,
    drawerModal,
    inert: {
      sidebar: sheetModal || (f.phone && !f.drawerOpen),
      topbar: modal,
      chat: modal || pageOpen,
      rail: pageOpen,
      panel: (!f.laptop && !panelShown) || pageOpen || drawerModal,
      page: drawerModal,
      toasts: modal,
    },
  };
}

// What the page's openers do (S8): the composer's model pill and the setup
// notice open Connections, and Open Usage opens Usage. The shell passes
// its openView, so a test can pass a recorder.
export const openersFor = (openView: (view: View) => void) => ({
  openConnections: () => openView("connections"),
  openUsage: () => openView("usage"),
});

// Where a toast's button goes (S8): Connections for the setup sentence
// when no provider is ready (J12), Usage when the credit ran out (0014).
export type ToastLink = "connections" | "usage";

// A partly done action links as its cause does (0018, fix round 1, R2).
export const setupLink = (e: unknown): ToastLink | undefined => {
  const err = e instanceof Error && e.name === "PartlyDoneError" ? e.cause : e;
  return err instanceof ApiError ? (err.body.error === "provider_not_ready" ? "connections" : err.body.error === "credits_exhausted" ? "usage" : undefined) : undefined;
};

// Up to two letters: the first and last word of a name, else of the part
// of an email before the @. Null when there is neither.
export function initials(name: string | null | undefined, email: string | null | undefined): string | null {
  const from = (s: string) => {
    const words = s.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (words.length === 0) return null;
    const first = Array.from(words[0]!)[0]!;
    const last = words.length > 1 ? Array.from(words[words.length - 1]!)[0]! : "";
    return (first + last).toLocaleUpperCase();
  };
  return (name?.trim() ? from(name) : null) ?? (email?.trim() ? from(email.split("@")[0]!) : null);
}

// What the account button shows: the avatar's letters (null for the
// person icon), a name and one line under it.
export type Person = { initials: string | null; name: string; line: string };

export function person(hosted: SignedInSession | null, google: GoogleStatus | null): Person {
  if (hosted) {
    const a = hosted.account;
    // A judge account is named for what it is, never by its code.
    if (a.kind === "judge") return { initials: null, name: "Judge access", line: `Balance ${hosted.balance}` };
    return { initials: initials(a.name, a.email), name: a.name ?? a.email ?? "Your account", line: `Balance ${hosted.balance}` };
  }
  // Local mode has no account. A connected Google account lends its letters.
  const email = google?.connected ? google.email : null;
  return { initials: initials(null, email), name: "You", line: "This computer" };
}

// The folded sidebar, kept per browser. Storage can be off, so every
// access is guarded.
const FOLD_KEY = "appointments-sidebar";

export function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "folded";
  } catch {
    return false;
  }
}

export function saveFolded(folded: boolean): void {
  try {
    if (folded) localStorage.setItem(FOLD_KEY, "folded");
    else localStorage.removeItem(FOLD_KEY);
  } catch {
    // The choice then lasts until the page reloads.
  }
}
