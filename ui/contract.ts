// The sprint 8, 9 and 10 contract as the page uses it: activity and undo,
// the chat's action event, settings, the time zone and model sign-in. The
// back-end routes come with sprints 8 and 10. Until then a development
// build fakes them (ui/dev/fakeBackend.ts), and a production build says
// what is not available yet. Runs in the browser and in Node.
import type { ChatEvent as BaseChatEvent, ChatMessage as BaseChatMessage } from "../src/agent/types.ts";

export type ActivityActor = "agent" | "you" | "mcp";

export type ActivityTarget = { type: "message" | "claim" | "slot" | "question" | "draft" | "note"; id: string };

export type ActivityEntry = {
  id: string;
  at: string; // ISO with offset
  actor: ActivityActor; // "mcp" is an external agent over MCP
  kind: string; // "claim_accepted", "question_answered", "timezone_set" and so on
  summary: string; // a plain sentence written by code
  target: ActivityTarget | null;
  undoable: boolean;
  undone: boolean;
  undoneAt?: string;
};

export type ActivityLog = { activityVersion: number; entries: ActivityEntry[] };

// The chat message gains the ids of the activity entries done in its turn.
export type ChatMessage = BaseChatMessage & { actions?: string[] };

export type ChatEvent = BaseChatEvent | { event: "action"; data: { turnId: string; entry: ActivityEntry } };

export type Provider = "meta" | "chatgpt";

export type ModelOption = { id: string; label: string; costHint: "lower" | "higher" | null };

export type Settings = {
  settingsVersion: number;
  // The model of the current provider, and the models it offers.
  model: string;
  models: ModelOption[];
  timezone: string;
  timezoneSource: "you" | "agent" | "browser" | "default";
  provider: Provider | null;
  meta: { keySet: boolean; source: "you" | "server" | null };
  chatgpt: { signedIn: boolean; name: string | null; email: string | null; planUsage: boolean };
};

// The zone the app uses until settings say otherwise. The demo's messages
// come from a clinic in America/Denver.
export const DEFAULT_ZONE = "America/Denver";

export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: 0,
  model: "",
  models: [],
  timezone: DEFAULT_ZONE,
  timezoneSource: "default",
  provider: null,
  meta: { keySet: false, source: null },
  chatgpt: { signedIn: false, name: null, email: null, planUsage: false },
};

// Google, through the fourth writer's routes: Gmail read-only search for
// appointment emails, and Google Calendar events for clashes and the
// appointments the agent adds.
// `version` moves with every connect and disconnect. A disconnect states the
// version it was shown at (Muse round 1, finding 7).
export type GoogleStatus = { version: number; connected: boolean; email: string | null; gmail: boolean; calendar: boolean; calendarId: string | null };

export const GOOGLE_OFF: GoogleStatus = { version: 0, connected: false, email: null, gmail: false, calendar: false, calendarId: null };

// Activity kinds the page reads meaning from. The rest it shows by their
// sentence only. Assumed names until the back ends settle them (0011).
export const CALENDAR_KINDS = { added: "calendar_event_added", updated: "calendar_event_updated", removed: "calendar_event_removed" } as const;
export const GMAIL_IMPORTED = "gmail_message_imported";

// Every zone this browser knows, for the searchable list.
export function knownZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [DEFAULT_ZONE, "UTC"];
  }
}

// An IANA zone name this browser can format with.
export function validZone(zone: string): boolean {
  if (zone.trim() === "" || zone !== zone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return knownZones().includes(zone) || zone === "UTC";
  } catch {
    return false;
  }
}

// The zone of this device, or null when the browser does not say.
export function deviceZone(): string | null {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z && validZone(z) ? z : null;
  } catch {
    return null;
  }
}
