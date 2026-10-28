// Setting writes. The projection is in events.ts.
import { canonicalZone } from "../domain/zone.ts";
import { InvalidRequestError } from "../intake/service.ts";
import type { EventStore, StoredEvent } from "../store/event-log.ts";
import { SETTINGS_STREAM, projectSettings, type SettingsEvent, type TimezoneValue } from "./events.ts";

const describe = (_streamId: string, events: StoredEvent[]) => ({ settingsVersion: projectSettings(events).version });

// Sets the time zone at the expected settings version. The name must be an
// IANA zone this runtime knows. Returns the previous value for undo.
export function setTimezone(store: EventStore, name: string, source: TimezoneValue["source"], expectedVersion: number): { previous: TimezoneValue | null; value: TimezoneValue } {
  const zone = canonicalZone(name);
  if (zone === null) throw new InvalidRequestError(`${String(name).slice(0, 64)} is not a time zone name. Use an IANA name such as Europe/London or Asia/Tokyo.`);
  return store.transaction(() => {
    store.assertVersion(SETTINGS_STREAM, expectedVersion, describe);
    const previous = projectSettings(store.readStream(SETTINGS_STREAM)).timezone;
    const value: TimezoneValue = { timezone: zone, source };
    const event: SettingsEvent = { type: "timezone_set", data: { ...value, previous } };
    store.append(SETTINGS_STREAM, expectedVersion, [event], describe);
    return { previous, value };
  });
}

// Puts back a zone from before, or clears it, at the current version. For
// undo, inside its transaction.
export function restoreTimezone(store: EventStore, previous: TimezoneValue | null): void {
  const version = store.streamVersion(SETTINGS_STREAM);
  const current = projectSettings(store.readStream(SETTINGS_STREAM)).timezone;
  const event: SettingsEvent = previous ? { type: "timezone_set", data: { ...previous, previous: current } } : { type: "timezone_cleared", data: {} };
  store.append(SETTINGS_STREAM, version, [event], describe);
}
