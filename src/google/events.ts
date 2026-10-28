// The person's Google Calendar events for the case's clash checks (0012).
// The case view is built without waiting for the network, so it reads the
// events the app last fetched. A fetch covers MAX_WINDOW_DAYS days from the
// earliest appointment in the case (or today), and calendar_list stores what
// it read. The app's own events are left out, so an appointment never
// clashes with its own event. A disconnect clears the events.
import type { IcsEvent } from "../domain/ics.ts";
import { MAX_WINDOW_DAYS, toIcsEvents, type CalendarEvent, type GoogleCalendar } from "./calendar.ts";

export const GOOGLE_CALENDAR_NAME = "Google Calendar";

const addDays = (date: string, days: number) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

export class GoogleCalendarEvents {
  readonly #calendar: GoogleCalendar;
  #events: IcsEvent[] | null = null;

  constructor(calendar: GoogleCalendar) {
    this.#calendar = calendar;
  }

  // What the clash checks read, or null before the first fetch.
  snapshot(): { name: string; events: IcsEvent[] } | null {
    return this.#events ? { name: GOOGLE_CALENDAR_NAME, events: this.#events } : null;
  }

  // Stores events read for a window, without the app's own.
  store(events: CalendarEvent[]): void {
    this.#events = toIcsEvents(events.filter((e) => e.slotKey === null));
  }

  clear(): void {
    this.#events = null;
  }

  // Fetches the window that starts at the earliest of `dates` (YYYY-MM-DD),
  // or at `today` when there are none, and stores it.
  async refresh(dates: string[], today: string): Promise<void> {
    const from = [...dates, today].sort()[0]!;
    this.store(await this.#calendar.list({ from, to: addDays(from, MAX_WINDOW_DAYS - 1) }));
  }
}
