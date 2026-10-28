// The sprint 8, 9, 10 and 11 contract as the page uses it: activity and
// undo, the chat's action event, settings, the time zone, model sign-in
// and Google. Sprint 8 serves activity, undo and the time zone, and sprint
// 10 the provider, model and sign-in. Google comes with sprint 11. Until
// then a development build fakes only `/api/google`
// (ui/dev/fakeBackend.ts), and a production build says it is not
// available yet. Runs in the browser and in Node.
import type { ActivityActor, ActivityEntry, ActivityTarget, ActivityView } from "../src/activity/types.ts";
import type { ChatEvent, ChatMessage } from "../src/agent/types.ts";

// Sprint 8's types, used as they are: the activity log, and the chat
// message with its actions and the action event.
export type { ActivityActor, ActivityEntry, ActivityTarget, ChatEvent, ChatMessage };
export type ActivityLog = ActivityView;

export type Provider = "meta" | "chatgpt";

export type ModelOption = { id: string; label: string; costHint: "lower" | "higher" | null };

// What GET /api/settings answers (0009 and 0010). One settingsVersion
// covers the time zone and the provider part, and every settings and
// sign-in write states it.
export type Settings = {
  settingsVersion: number;
  // The model of the current provider, and the models it offers. Empty
  // with no provider.
  model: string;
  models: ModelOption[];
  // Set when the chosen model failed something the app needs. Shown under
  // the model choice.
  modelNotice: string | null;
  timezone: string;
  timezoneSource: "you" | "agent" | "browser" | "default";
  provider: Provider | null;
  meta: { keySet: boolean; source: "you" | "server" | null };
  chatgpt: { signedIn: boolean; name: string | null; email: string | null; planUsage: boolean };
};

// The zone the app uses until settings say otherwise, the server's own
// default (0009, A12). Loading the demo sets America/Denver.
export const DEFAULT_ZONE = "UTC";

export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: 0,
  model: "",
  models: [],
  modelNotice: null,
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
