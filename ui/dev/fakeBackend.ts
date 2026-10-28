// A development fake of the one route that does not exist yet:
// `/api/google` (sprint 11), with the Gmail and Google Calendar entries the
// scripted agent writes. Only a development build (or a check build made
// with APP_UI_FAKES=1) has it, next to the scripted chat.
// `createHybridBackend` puts it beside the real routes: settings, the time
// zone, the provider, model and sign-in (sprints 8 and 10), activity and
// undo are all the server's (0011, U47).
//
// It holds no token: Google connect signs in a synthetic account. It keeps
// its state in this tab's sessionStorage, so the connect redirect and a
// reload keep it. Undo of a Google Calendar event works, because the
// events are fake too.
import { ApiError } from "../api.ts";
import type { AgentBackend } from "../agentApi.ts";
import { CALENDAR_KINDS, GOOGLE_OFF, type ActivityEntry, type ActivityLog, type GoogleStatus } from "../contract.ts";

// Also the marker test/bundle.test.ts looks for.
export const FAKES_MARKER = "appointments-dev-fakes";
const KEY = FAKES_MARKER;

type Saved = {
  google: GoogleStatus;
  // The Google Calendar events the scripted agent added, by slot key.
  events: string[];
  log: ActivityLog;
  seq: number;
  // What each undoable entry needs to reverse it.
  undo: Record<string, { event?: { slotKey: string; added: boolean } }>;
};

export type FakeBackend = Pick<AgentBackend, "google" | "googleConnect" | "googleDisconnect" | "activity" | "undo"> & {
  kind: "fake";
  // The scripted agent records what it did. Returns the entry.
  record(entry: Omit<ActivityEntry, "id" | "at" | "undone">, undo?: Saved["undo"][string]): ActivityEntry;
  googleNow(): GoogleStatus;
  // The scripted agent adds an appointment to Google Calendar.
  agentAddEvent(slotKey: string, summary: string): ActivityEntry | null;
  agentRemoveEvent(slotKey: string, summary: string): ActivityEntry | null;
  hasEvent(slotKey: string): boolean;
  // Delete case erases the case's activity.
  clearActivity(): void;
  reset(): void;
};

const fresh = (): Saved => ({ google: { ...GOOGLE_OFF }, events: [], log: { activityVersion: 0, entries: [] }, seq: 0, undo: {} });

const refuse = (status: number, error: string, message: string) => new ApiError(status, { error, message });

export function createFakeBackend({ storage = null, now = () => new Date().toISOString() }: { storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null; now?: () => string } = {}): FakeBackend {
  let s: Saved;
  try {
    s = (JSON.parse(storage?.getItem(KEY) ?? "null") as Saved | null) ?? fresh();
  } catch {
    s = fresh();
  }
  const save = () => {
    try {
      storage?.setItem(KEY, JSON.stringify(s));
    } catch {
      // Storage off. The fake lasts until the tab reloads.
    }
  };
  const record: FakeBackend["record"] = (entry, undo) => {
    const full: ActivityEntry = { ...entry, id: `act-${++s.seq}`, at: now(), undone: false };
    s.log = { activityVersion: s.log.activityVersion + 1, entries: [full, ...s.log.entries] };
    if (undo) s.undo[full.id] = undo;
    save();
    return full;
  };

  return {
    kind: "fake",
    googleNow: () => s.google,
    record,
    agentAddEvent(slotKey, summary) {
      if (!s.google.calendar || s.events.includes(slotKey)) return null;
      s.events.push(slotKey);
      return record({ actor: "agent", kind: CALENDAR_KINDS.added, summary, target: { type: "slot", id: slotKey }, undoable: true }, { event: { slotKey, added: true } });
    },
    agentRemoveEvent(slotKey, summary) {
      if (!s.events.includes(slotKey)) return null;
      s.events = s.events.filter((k) => k !== slotKey);
      return record({ actor: "agent", kind: CALENDAR_KINDS.removed, summary, target: { type: "slot", id: slotKey }, undoable: true }, { event: { slotKey, added: false } });
    },
    hasEvent: (slotKey) => s.events.includes(slotKey),
    clearActivity() {
      s.log = { activityVersion: s.log.activityVersion + 1, entries: [] };
      s.undo = {};
      s.events = [];
      save();
    },
    reset() {
      s = fresh();
      storage?.removeItem(KEY);
    },
    async google() {
      return structuredClone(s.google);
    },
    async googleConnect(expectedVersion) {
      if (expectedVersion !== s.google.version) throw refuse(409, "stale_edit", "The Google connection changed since it was shown.");
      // A synthetic account. The real route answers Google's sign-in page.
      // The page came from ?mockchat=1, so the callback keeps it.
      s.google = { version: s.google.version + 1, connected: true, email: "sample.person@example.com", gmail: true, calendar: true, calendarId: "primary" };
      save();
      return { authorizeUrl: "/?mockchat=1&connected=google" };
    },
    async googleDisconnect(expectedVersion) {
      if (expectedVersion !== s.google.version) throw refuse(409, "stale_edit", "The Google connection changed since it was shown.");
      s.google = { ...GOOGLE_OFF, version: s.google.version + 1 };
      save();
      return {};
    },
    async activity() {
      return structuredClone(s.log);
    },
    async undo(id, expectedVersion) {
      if (expectedVersion !== s.log.activityVersion) throw refuse(409, "stale_edit", "The activity changed since it was shown.");
      const entry = s.log.entries.find((e) => e.id === id);
      if (!entry) throw refuse(404, "not_found", "That action is no longer in the activity.");
      if (entry.undone || !entry.undoable) throw refuse(409, "undo_blocked", "This action cannot be undone.");
      const how = s.undo[id]?.event;
      if (!how) throw refuse(409, "undo_blocked", "This action cannot be undone.");
      // A later change to the same event depends on this one.
      const later = s.log.entries.slice(0, s.log.entries.indexOf(entry)).find((e) => e.target?.type === "slot" && e.target.id === how.slotKey && e.kind.startsWith("calendar_event_") && !e.undone);
      if (later) throw refuse(409, "undo_blocked", "A later Google Calendar change to this appointment depends on this one. Undo that change first.");
      s.events = how.added ? s.events.filter((k) => k !== how.slotKey) : [...s.events.filter((k) => k !== how.slotKey), how.slotKey];
      const at = now();
      s.log = { activityVersion: s.log.activityVersion + 1, entries: s.log.entries.map((e) => (e.id === id ? { ...e, undone: true, undoneAt: at } : e)) };
      save();
      return {};
    },
  };
}

// The real routes, with the fake only for Google (0011, U47). The activity
// is the real log with the fake's Gmail and Google Calendar entries merged
// in by time. A fake entry's id starts with "act-", so undo goes to the fake
// for those and to the server for the rest, each with its own version.
export function createHybridBackend(real: AgentBackend, fake: FakeBackend): AgentBackend {
  const isFake = (id: string) => id.startsWith("act-");
  return {
    ...real,
    kind: "fake",
    async activity() {
      const [r, f] = await Promise.all([real.activity(), fake.activity()]);
      if (!r) return f;
      const entries = [...r.entries, ...(f?.entries ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      return { activityVersion: r.activityVersion, entries };
    },
    async undo(id, version) {
      if (isFake(id)) return fake.undo(id, (await fake.activity())!.activityVersion);
      return real.undo(id, version);
    },
    google: () => fake.google(),
    googleConnect: (v) => fake.googleConnect(v),
    googleDisconnect: (v) => fake.googleDisconnect(v),
  };
}
