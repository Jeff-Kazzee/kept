// What the agent did and the settings, shared by the chat receipts, the
// claims rows, the Activity tab and the sidebar pages. The shell reads both with the
// case, and every undo re-reads them.
import { createContext, useContext } from "react";
import type { AgentBackend } from "../agentApi.ts";
import { CALENDAR_KINDS, DEFAULT_SETTINGS, GOOGLE_OFF, type ActivityEntry, type ActivityLog, type CalendarOwnSeen, type GoogleStatus, type Settings } from "../contract.ts";
import type { SignedInSession } from "../hosted/session.ts";

export type AgentState = {
  backend: AgentBackend;
  // False until the server has the settings route (sprint 8 and 10).
  settingsAvailable: boolean;
  settings: Settings;
  // Null until the server has the activity route (sprint 8).
  activity: ActivityLog | null;
  // Null until the server has the Google route.
  google: GoogleStatus | null;
  // Undoes entries newest first, each with the activity version it was
  // shown at. A refusal shows its plain reason beside the entry.
  undo: (ids: string[]) => Promise<void>;
  // True while a turn streams or an undo runs. Undo buttons wait.
  undoBusy: boolean;
  // The reason Undo was refused, by entry id, until the next undo.
  blocked: Readonly<Record<string, string>>;
  // Muse round 2, finding 5: when each refusal came, as a count that only
  // grows, so a repeat of the same refusal is still news.
  blockedAt: Readonly<Record<string, number>>;
  reload: () => Promise<void>;
  // Opens Connections (0015), for the composer's model indicator and the
  // setup notice.
  openConnections: () => void;
  // Says what went wrong in a plain sentence (a toast).
  report: (e: unknown) => void;
  // A plain note from the server, such as the sign-out notice (a toast).
  notify: (text: string) => void;
  // The hosted site's session (0014). Null in local mode.
  hosted: SignedInSession | null;
  // Opens Usage, on the hosted site.
  openUsage: () => void;
  // The session ended, or the account was deleted: back to sign-in.
  signedOut: () => void;
};

const noop = async () => {};

// What the page has before the shell reads anything, and what tests start
// from: no settings, activity or Google routes.
export const DEFAULT_AGENT: AgentState = {
  backend: {
    settings: async () => null,
    setTimezone: noop,
    setProvider: noop,
    setModel: noop,
    saveMetaKey: noop,
    removeMetaKey: noop,
    chatgptStart: async () => ({ authorizeUrl: "/" }),
    chatgptSignOut: noop,
    activity: async () => null,
    undo: noop,
    google: async () => null,
    googleConnect: async () => ({ authorizeUrl: "/" }),
    googleDisconnect: async () => ({ ...GOOGLE_OFF, revoked: false }),
    googleCalendarRefresh: async () => ({ events: 0 }),
  },
  settingsAvailable: false,
  settings: DEFAULT_SETTINGS,
  activity: null,
  google: null,
  undo: noop,
  undoBusy: false,
  blocked: {},
  blockedAt: {},
  reload: noop,
  openConnections: () => {},
  report: () => {},
  notify: () => {},
  hosted: null,
  openUsage: () => {},
  signedOut: () => {},
};

export const AgentContext = createContext<AgentState>(DEFAULT_AGENT);

export const useAgent = () => useContext(AgentContext);

// The entries of a list of ids, in the order given, skipping unknown ids.
export function entriesById(log: ActivityLog | null, ids: readonly string[]): ActivityEntry[] {
  if (!log) return [];
  const byId = new Map(log.entries.map((e) => [e.id, e]));
  return ids.map((id) => byId.get(id)).filter((e): e is ActivityEntry => e !== undefined);
}

// The latest entry about one target, such as the accept of one claim.
export function entryFor(log: ActivityLog | null, type: NonNullable<ActivityEntry["target"]>["type"], id: string): ActivityEntry | undefined {
  return log?.entries.find((e) => e.target?.type === type && e.target.id === id);
}

export const canUndo = (e: ActivityEntry) => e.undoable && !e.undone;

export const ACTOR_WORDS: Record<ActivityEntry["actor"], string> = {
  agent: "Assistant",
  you: "You",
  mcp: "External agent (MCP)",
};

export const googleOrOff = (g: GoogleStatus | null) => g ?? GOOGLE_OFF;

const CALENDAR = new Set<string>(Object.values(CALENDAR_KINDS));

// True when the assistant's latest Google Calendar action on a slot that is
// still in effect added or updated its event.
// Where the appointment's own event stands at Google (0017, fix round 1):
// "on" while the app's last write added or updated it, "removed" when a
// read of the calendar made after that write covers the date and no longer
// finds the event, so the person removed it in Google Calendar. Null when
// the app has no event for it.
export function googleEventState(log: ActivityLog | null, seen: CalendarOwnSeen[] | undefined, slot: { key: string; date: string }): "on" | "removed" | null {
  if (!onGoogleCalendar(log, slot.key)) return null;
  const entries = log?.entries.filter((e) => CALENDAR.has(e.kind) && e.target?.type === "slot" && e.target.id === slot.key) ?? [];
  const since = Math.max(...entries.flatMap((e) => [Date.parse(e.at), e.undoneAt ? Date.parse(e.undoneAt) : NaN]).filter(Number.isFinite));
  const covering = (seen ?? []).filter((w) => w.from <= slot.date && slot.date <= w.to && Date.parse(w.readAt) > since);
  const newest = covering.sort((a, b) => Date.parse(b.readAt) - Date.parse(a.readAt))[0];
  return newest && !newest.slots.includes(slot.key) ? "removed" : "on";
}

// 0018, H5: true when this entry added or updated the app's event, it is
// the slot's latest Google Calendar action in effect, and the same read
// that shows "Removed in Google Calendar" no longer finds the event. Its
// Undo has nothing left to reverse.
export function removedInGoogle(log: ActivityLog | null, seen: CalendarOwnSeen[] | undefined, entry: ActivityEntry): boolean {
  if ((entry.kind !== CALENDAR_KINDS.added && entry.kind !== CALENDAR_KINDS.updated) || entry.undone || entry.target?.type !== "slot") return false;
  const key = entry.target.id;
  const last = log?.entries.find((e) => CALENDAR.has(e.kind) && e.target?.type === "slot" && e.target.id === key && !e.undone);
  return last?.id === entry.id && googleEventState(log, seen, { key, date: key.slice(0, 10) }) === "removed";
}

export function onGoogleCalendar(log: ActivityLog | null, slotKey: string): boolean {
  const last = log?.entries.find((e) => CALENDAR.has(e.kind) && e.target?.type === "slot" && e.target.id === slotKey && !e.undone);
  return last !== undefined && last.kind !== CALENDAR_KINDS.removed;
}
