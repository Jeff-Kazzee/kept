// What the agent did and the settings, shared by the chat receipts, the
// claims rows, the Activity tab and Settings. The shell reads both with the
// case, and every undo re-reads them.
import { createContext, useContext } from "react";
import type { AgentBackend } from "../agentApi.ts";
import { CALENDAR_KINDS, DEFAULT_SETTINGS, GMAIL_IMPORTED, GOOGLE_OFF, type ActivityEntry, type ActivityLog, type GoogleStatus, type Settings } from "../contract.ts";

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
  // The reason Undo was refused, by entry id, until the next undo.
  blocked: Readonly<Record<string, string>>;
  reload: () => Promise<void>;
  // Opens the Settings tab, for the composer's model indicator.
  openSettings: () => void;
  // Says what went wrong in a plain sentence (a toast).
  report: (e: unknown) => void;
};

const noop = async () => {};

// What the page has before the shell reads anything, and what tests start
// from: no settings, activity or Google routes.
export const DEFAULT_AGENT: AgentState = {
  backend: {
    kind: "real",
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
    googleDisconnect: noop,
  },
  settingsAvailable: false,
  settings: DEFAULT_SETTINGS,
  activity: null,
  google: null,
  undo: noop,
  blocked: {},
  reload: noop,
  openSettings: () => {},
  report: () => {},
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
export function onGoogleCalendar(log: ActivityLog | null, slotKey: string): boolean {
  const last = log?.entries.find((e) => CALENDAR.has(e.kind) && e.target?.type === "slot" && e.target.id === slotKey && !e.undone);
  return last !== undefined && last.kind !== CALENDAR_KINDS.removed;
}

// True when the assistant imported this message from Gmail.
export const fromGmail = (log: ActivityLog | null, messageId: string) => log?.entries.some((e) => e.kind === GMAIL_IMPORTED && e.target?.type === "message" && e.target.id === messageId) ?? false;
