// App settings and their projection (0009, J5). One `settings` stream
// holds them, so every setting write states one expected version,
// `settingsVersion`. Sprint 8 writes the time zone. Other settings add their
// own event kinds to the same stream, and this projection skips kinds it
// does not know, so the version still counts them. Settings are not case
// data: Delete case keeps them.
import { DEFAULT_TIME_ZONE, canonicalZone } from "../domain/zone.ts";
import type { EventStore, StoredEvent } from "../store/event-log.ts";

export const SETTINGS_STREAM = "settings";

// Who set the time zone. "browser" is the page sending the browser's zone
// on first load. "default" means no one set it yet.
export type TimezoneSource = "you" | "agent" | "browser" | "default";

export type TimezoneValue = { timezone: string; source: Exclude<TimezoneSource, "default"> };

export type SettingsEvent =
  // `previous` is the zone before this one, or null when none was set, so
  // undo can put it back.
  | { type: "timezone_set"; data: TimezoneValue & { previous: TimezoneValue | null } }
  | { type: "timezone_cleared"; data: Record<string, never> };

export type TimezoneSettings = { settingsVersion: number; timezone: string; timezoneSource: TimezoneSource };

export function projectSettings(events: StoredEvent[]): { version: number; timezone: TimezoneValue | null } {
  let version = 0;
  let timezone: TimezoneValue | null = null;
  for (const e of events) {
    if (e.streamId !== SETTINGS_STREAM) continue;
    version = e.version;
    const event = { type: e.type, data: e.data } as SettingsEvent;
    if (event.type === "timezone_set") {
      // A zone this runtime no longer knows is skipped, so the case falls
      // back to the zone before it.
      const zone = canonicalZone(event.data.timezone);
      if (zone) timezone = { timezone: zone, source: event.data.source };
    } else if (event.type === "timezone_cleared") {
      timezone = null;
    }
  }
  return { version, timezone };
}

// The case's time zone, read from the store each time.
export function caseTimeZone(store: EventStore): string {
  return projectSettings(store.readStream(SETTINGS_STREAM)).timezone?.timezone ?? DEFAULT_TIME_ZONE;
}

export function timezoneSettings(store: EventStore): TimezoneSettings {
  const { version, timezone } = projectSettings(store.readStream(SETTINGS_STREAM));
  return { settingsVersion: version, timezone: timezone?.timezone ?? DEFAULT_TIME_ZONE, timezoneSource: timezone?.source ?? "default" };
}
