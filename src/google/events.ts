// The person's Google Calendar events for the case's clash checks (0012).
// The case view is built without waiting for the network, so it reads the
// events the app last fetched. Only `refresh` writes them, for its window
// of MAX_WINDOW_DAYS days from the earliest of today and the case's
// appointments. calendar_list is a pure read (review round 3, finding 5).
// The app's own events are left out, so an appointment never clashes with
// its own event.
//
// Review round 3, finding 6: the events belong to one account and calendar,
// and to one generation. `clear`, which a disconnect and the start of a
// connect call, starts a new generation, so a fetch still in flight from
// before is dropped when it ends. The snapshot is also dropped as soon as
// the connection names another account or calendar, so a failed first
// fetch after a reconnect never leaves the old account's events.
import type { IcsEvent } from "../domain/ics.ts";
import { MAX_WINDOW_DAYS, toIcsEvents, type CalendarEvent, type GoogleCalendar } from "./calendar.ts";

export const GOOGLE_CALENDAR_NAME = "Google Calendar";

const addDays = (date: string, days: number) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

export class GoogleCalendarEvents {
  readonly #calendar: GoogleCalendar;
  #snapshot: { account: string; events: IcsEvent[] } | null = null;
  #generation = 0;

  constructor(calendar: GoogleCalendar) {
    this.#calendar = calendar;
  }

  // What the clash checks read, or null before the first fetch and when
  // the connection now names another account or calendar.
  snapshot(): { name: string; events: IcsEvent[] } | null {
    const s = this.#snapshot;
    if (!s || this.#calendar.accountKey() !== s.account) return null;
    return { name: GOOGLE_CALENDAR_NAME, events: s.events };
  }

  clear(): void {
    this.#generation += 1;
    this.#snapshot = null;
  }

  // Fetches the window that starts at the earliest of `dates` (YYYY-MM-DD),
  // or at `today` when there are none, and stores it, unless a clear or a
  // change of account came while it ran.
  async refresh(dates: string[], today: string): Promise<void> {
    const generation = this.#generation;
    const account = this.#calendar.accountKey();
    if (account === null) return this.clear();
    const from = [...dates, today].sort()[0]!;
    const events: CalendarEvent[] = await this.#calendar.list({ from, to: addDays(from, MAX_WINDOW_DAYS - 1) });
    if (generation !== this.#generation || this.#calendar.accountKey() !== account) return;
    this.#snapshot = { account, events: toIcsEvents(events.filter((e) => e.slotKey === null)) };
  }
}
