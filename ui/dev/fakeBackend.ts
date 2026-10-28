// A development fake of the routes sprints 8 and 10 bring: settings, the
// time zone, the model provider, sign-in, activity and undo. Only a
// development build (or a check build made with APP_UI_FAKES=1) has it,
// next to the scripted chat. It calls no server for these routes and holds
// no key or token: saving a Meta key keeps only "a key is set", and
// ChatGPT sign-in is a synthetic account.
//
// It keeps its state in this tab's sessionStorage, so the sign-in
// redirect and a reload keep it. Undo of a time zone change and of a
// Google Calendar event works (the events are fake too). Undo of an
// archive goes through the real route. The fake cannot reverse a fact
// the scripted agent accepted, because the server has no route for that
// yet, so it answers undo_blocked and says so.
import { ApiError, api } from "../api.ts";
import type { AgentBackend } from "../agentApi.ts";
import { CALENDAR_KINDS, DEFAULT_SETTINGS, GOOGLE_OFF, validZone, type ActivityEntry, type ActivityLog, type GoogleStatus, type ModelOption, type Provider, type Settings } from "../contract.ts";

// Also the marker test/bundle.test.ts looks for.
export const FAKES_MARKER = "appointments-dev-fakes";
const KEY = FAKES_MARKER;

// The models each provider offers in the fake. Meta's are the two the
// app supports. The ChatGPT list stands in for the models of a signed-in
// connection and is synthetic.
export const FAKE_MODELS: Record<Provider, ModelOption[]> = {
  meta: [
    { id: "muse-spark-1.3", label: "Muse Spark 1.3", costHint: "lower" },
    { id: "muse-wonder", label: "Muse Wonder", costHint: "higher" },
  ],
  chatgpt: [
    { id: "chatgpt-standard", label: "Standard (sample connection)", costHint: "lower" },
    { id: "chatgpt-thinking", label: "Thinking (sample connection)", costHint: "higher" },
  ],
};

type Saved = {
  settings: Settings;
  google: GoogleStatus;
  // The Google Calendar events the scripted agent added, by slot key.
  events: string[];
  log: ActivityLog;
  seq: number;
  // What each undoable entry needs to reverse it.
  undo: Record<string, { zone?: { before: string; source: Settings["timezoneSource"] }; archive?: { slotKey: string }; event?: { slotKey: string; added: boolean } }>;
};

export type FakeBackend = AgentBackend & {
  // The scripted agent records what it did. Returns the entry.
  record(entry: Omit<ActivityEntry, "id" | "at" | "undone">, undo?: Saved["undo"][string]): ActivityEntry;
  // set_timezone as the agent does it, with its activity entry.
  agentSetTimezone(zone: string, summary: string): ActivityEntry | null;
  current(): Settings;
  googleNow(): GoogleStatus;
  // The scripted agent adds an appointment to Google Calendar.
  agentAddEvent(slotKey: string, summary: string): ActivityEntry | null;
  agentRemoveEvent(slotKey: string, summary: string): ActivityEntry | null;
  hasEvent(slotKey: string): boolean;
  // Delete case erases the case's activity. Settings stay.
  clearActivity(): void;
  reset(): void;
};

const fresh = (): Saved => ({ settings: structuredClone(DEFAULT_SETTINGS), google: { ...GOOGLE_OFF }, events: [], log: { activityVersion: 0, entries: [] }, seq: 0, undo: {} });

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
  // The model list follows the provider, and its first model is the
  // default.
  const bumpSettings = (change: Partial<Settings>) => {
    const next = { ...s.settings, ...change };
    const models = next.provider ? FAKE_MODELS[next.provider] : [];
    const model = models.some((m) => m.id === next.model) ? next.model : (models[0]?.id ?? "");
    s.settings = { ...next, models, model, settingsVersion: s.settings.settingsVersion + 1 };
  };
  const checkSettings = (expectedVersion: number) => {
    if (expectedVersion !== s.settings.settingsVersion) throw refuse(409, "stale_edit", "The settings changed since they were shown.");
  };
  const record: FakeBackend["record"] = (entry, undo) => {
    const full: ActivityEntry = { ...entry, id: `act-${++s.seq}`, at: now(), undone: false };
    s.log = { activityVersion: s.log.activityVersion + 1, entries: [full, ...s.log.entries] };
    if (undo) s.undo[full.id] = undo;
    save();
    return full;
  };
  const setZone = (zone: string, source: Settings["timezoneSource"], actor: ActivityEntry["actor"] | null, summary?: string) => {
    if (!validZone(zone)) throw refuse(400, "invalid_timezone", "That is not a time zone name this app knows.");
    const before = { before: s.settings.timezone, source: s.settings.timezoneSource };
    bumpSettings({ timezone: zone, timezoneSource: source });
    save();
    if (actor === null) return null;
    return record({ actor, kind: "timezone_set", summary: summary ?? `Set the time zone to ${zone}.`, target: null, undoable: true }, { zone: before });
  };
  const fakeChat = { name: "Sample Person", email: "sample.person@example.com" };

  return {
    kind: "fake",
    current: () => s.settings,
    googleNow: () => s.google,
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
    reset() {
      s = fresh();
      storage?.removeItem(KEY);
    },
    record,
    clearActivity() {
      s.log = { activityVersion: s.log.activityVersion + 1, entries: [] };
      s.undo = {};
      s.events = [];
      save();
    },
    agentSetTimezone: (zone, summary) => (s.settings.timezone === zone ? null : setZone(zone, "agent", "agent", summary)),
    async settings() {
      return structuredClone(s.settings);
    },
    async setTimezone(zone, expectedVersion, from = "you") {
      checkSettings(expectedVersion);
      // The browser's own zone on first load is not an action anyone takes.
      setZone(zone, from, from === "browser" ? null : "you");
      return structuredClone(s.settings);
    },
    async setProvider(provider, expectedVersion) {
      checkSettings(expectedVersion);
      if (provider === "meta" && !s.settings.meta.keySet) throw refuse(409, "provider_not_ready", "Add a Meta Model API key first.");
      if (provider === "chatgpt" && !s.settings.chatgpt.signedIn) throw refuse(409, "provider_not_ready", "Sign in with ChatGPT first.");
      bumpSettings({ provider });
      save();
      return structuredClone(s.settings);
    },
    async setModel(model, expectedVersion) {
      checkSettings(expectedVersion);
      if (!s.settings.models.some((m) => m.id === model)) throw refuse(400, "invalid_model", "That model is not offered by this provider.");
      bumpSettings({ model });
      save();
      return structuredClone(s.settings);
    },
    async google() {
      return structuredClone(s.google);
    },
    async googleConnect() {
      // A synthetic account. The real route answers Google's sign-in page.
      s.google = { connected: true, email: "sample.person@example.com", gmail: true, calendar: true, calendarId: "primary" };
      save();
      return { authorizeUrl: "/?mockchat=1&connected=google" };
    },
    async googleDisconnect() {
      s.google = { ...GOOGLE_OFF };
      save();
      return {};
    },
    async saveMetaKey(key) {
      // Only that a key is set. The key itself is dropped here.
      if (key.trim().length < 8) throw refuse(400, "invalid_key", "That key looks too short.");
      bumpSettings({ meta: { keySet: true, source: "you" }, provider: s.settings.provider ?? "meta" });
      save();
      return {};
    },
    async removeMetaKey() {
      bumpSettings({ meta: { keySet: false, source: null }, provider: s.settings.provider === "meta" ? (s.settings.chatgpt.signedIn ? "chatgpt" : null) : s.settings.provider });
      save();
      return {};
    },
    async chatgptStart() {
      // The real route answers the provider's sign-in page. The fake signs
      // in a synthetic account and sends the page back as the callback does.
      bumpSettings({ chatgpt: { signedIn: true, ...fakeChat, planUsage: true }, provider: s.settings.provider ?? "chatgpt" });
      save();
      // The page came from ?mockchat=1, so the callback keeps it.
      return { authorizeUrl: "/?mockchat=1&signedIn=chatgpt" };
    },
    async chatgptSignOut() {
      bumpSettings({ chatgpt: { signedIn: false, name: null, email: null, planUsage: false }, provider: s.settings.provider === "chatgpt" ? (s.settings.meta.keySet ? "meta" : null) : s.settings.provider });
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
      const how = s.undo[id];
      if (how?.zone) {
        // A later zone change depends on this one: undo that first.
        // Entries are newest first, so later ones come before this one.
        const later = s.log.entries.slice(0, s.log.entries.indexOf(entry)).find((e) => e.kind === "timezone_set" && !e.undone);
        if (later) throw refuse(409, "undo_blocked", "A later time zone change depends on this one. Undo that change first.");
        bumpSettings({ timezone: how.zone.before, timezoneSource: how.zone.source });
      } else if (how?.event) {
        // Undo of an add takes the event off. Undo of a removal puts it back.
        // A later change to the same event depends on this one.
        const key = how.event.slotKey;
        const later = s.log.entries.slice(0, s.log.entries.indexOf(entry)).find((e) => e.target?.type === "slot" && e.target.id === key && e.kind.startsWith("calendar_event_") && !e.undone);
        if (later) throw refuse(409, "undo_blocked", "A later Google Calendar change to this appointment depends on this one. Undo that change first.");
        s.events = how.event.added ? s.events.filter((k) => k !== key) : [...s.events.filter((k) => k !== key), key];
      } else if (how?.archive) {
        const record = (await api.state()).records.find((r) => r.id === how.archive!.slotKey);
        const version = record?.history.filter((h) => h.type === "record_archived" && !h.undone).at(-1)?.version;
        if (!record || version === undefined) throw refuse(409, "undo_blocked", "The appointment is no longer archived.");
        await api.undo(record.id, version, record.version);
      } else {
        throw refuse(409, "undo_blocked", "The scripted demo cannot undo an accepted or rejected fact yet. The app's own Undo for facts comes with the agent back end.");
      }
      const at = now();
      s.log = {
        activityVersion: s.log.activityVersion + 1,
        entries: s.log.entries.map((e) => (e.id === id ? { ...e, undone: true, undoneAt: at } : e)),
      };
      save();
      return {};
    },
  };
}
