// "Try the demo" (J5, SP12.3): the person loads the demo calendar, and
// because the demo's clinic is in America/Denver the assistant sets the
// case to the demo's zone, an action the person can undo. The calendar
// route and the chat eval both load a calendar through this function, so
// the eval sets up the case as the page does and its recorded chat answers
// replay in the app.
import { loadCaseProfile, readFixtureText } from "../fixtures/load.ts";
import { timezoneSettings } from "../settings/events.ts";
import type { EventStore } from "../store/event-log.ts";
import { YOU, type CaseActions } from "./service.ts";

export const DEMO_CALENDAR_NAME = "dana.ics";
export const demoCalendarText = () => readFixtureText(`calendar/${DEMO_CALENDAR_NAME}`);

// Loads a calendar as the person. The demo calendar also sets the demo's
// zone, unless the case already uses it by choice.
export function loadCalendarAsPerson(actions: CaseActions, store: EventStore, name: string, text: string, expectedVersion: number): void {
  actions.loadCalendar(YOU, name, text, expectedVersion);
  if (text !== demoCalendarText()) return;
  const demoZone = loadCaseProfile().time_zone;
  const current = timezoneSettings(store);
  if (current.timezone === demoZone && current.timezoneSource !== "default") return;
  actions.setTimezone({ actor: "agent" }, demoZone, current.settingsVersion);
}
