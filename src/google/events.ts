// The person's Google Calendar events for the case's clash checks (0012).
// The case view is built without waiting for the network, so it reads the
// events the app last fetched. Only `refresh` and `ensure` write them.
// calendar_list is a pure read (review round 3, finding 5). The app's own
// events are left out, so an appointment never clashes with its own event.
//
// Sprint 13C, H1 (0016): the events are kept per window of at most
// MAX_WINDOW_DAYS days, each with the time it was read. The case window
// starts at the earliest of today and the case's appointments. A clash
// check first calls `ensure` for its date: when no window read in the last
// FRESH_MS covers the date, it reads the case window when that covers the
// date, else a window that starts at the date. A newer window replaces the
// events an older one held for the same days. Each read is shared by every
// check of one chat turn (`reads`), so a turn reads a window at most once.
//
// Review round 3, finding 6: the events belong to one account and calendar,
// and to one generation. `clear`, which a disconnect and the start of a
// connect call, starts a new generation, so a fetch still in flight from
// before is dropped when it ends. The snapshot is also dropped as soon as
// the connection names another account or calendar, so a failed first
// fetch after a reconnect never leaves the old account's events.
import type { IcsEvent } from "../domain/ics.ts";
import { wallClockToUtc } from "../domain/zone.ts";
import { MAX_WINDOW_DAYS, toIcsEvents, type CalendarEvent, type GoogleCalendar } from "./calendar.ts";
import { GoogleError } from "./http.ts";

export const GOOGLE_CALENDAR_NAME = "Google Calendar";
// How old a read may be before a clash check reads Google again.
export const FRESH_MS = 60_000;
// The most windows kept. The oldest read goes first.
const MAX_WINDOWS = 4;

const addDays = (date: string, days: number) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

type Window = { from: string; to: string; zone: string; startMs: number; endMs: number; readAt: number; events: CalendarEvent[] };

// The last read, for Connections (H2). Counts the person's own events only.
export type CalendarReadStatus = {
  readAt: string | null;
  events: number;
  from: string | null;
  to: string | null;
  days: number;
  error: { code: string; at: string } | null;
};

// The reads of one chat turn, by window. A failed read stays failed for
// the rest of the turn.
export type CalendarReads = Map<string, Promise<void>>;

const startOf = (e: CalendarEvent) => Date.parse(`${e.start.date}T${e.start.time ?? "00:00"}:00Z`);

export class GoogleCalendarEvents {
  readonly #calendar: GoogleCalendar;
  readonly #now: () => number;
  #state: { account: string; windows: Window[] } | null = null;
  #generation = 0;
  #last: { window: Window } | null = null;
  #error: { code: string; at: number } | null = null;
  #background: Promise<void> | null = null;
  // Moves with every stored read, so the page reloads the case (H1).
  #version = 0;

  constructor(calendar: GoogleCalendar, options: { now?: () => number } = {}) {
    this.#calendar = calendar;
    this.#now = options.now ?? Date.now;
  }

  #windows(): Window[] | null {
    const s = this.#state;
    if (!s || this.#calendar.accountKey() !== s.account) return null;
    return s.windows;
  }

  // What the clash checks read, or null before the first fetch and when
  // the connection now names another account or calendar. For each day,
  // the newest window that covers it holds its events.
  snapshot(): { name: string; events: IcsEvent[] } | null {
    const windows = this.#windows();
    if (!windows) return null;
    const newest = [...windows].sort((a, b) => b.readAt - a.readAt);
    const seen = new Set<string>();
    const out: CalendarEvent[] = [];
    newest.forEach((w, i) => {
      for (const e of w.events) {
        if (seen.has(e.id)) continue;
        const t = startOf(e);
        if (newest.slice(0, i).some((n) => t >= n.startMs && t < n.endMs)) continue;
        seen.add(e.id);
        out.push(e);
      }
    });
    return { name: GOOGLE_CALENDAR_NAME, events: toIcsEvents(out.filter((e) => e.slotKey === null)) };
  }

  // Moves with every stored read and every clear.
  version(): number {
    return this.#version;
  }

  clear(): void {
    this.#generation += 1;
    this.#version += 1;
    this.#state = null;
    this.#last = null;
    this.#error = null;
  }

  // Without a calendar connection: drops what is stored, once.
  #drop(): void {
    if (this.#state || this.#last || this.#error) this.clear();
  }

  // The last read and the last failure since it, for Connections.
  status(): CalendarReadStatus {
    const w = this.#windows() ? this.#last?.window : undefined;
    const error = this.#error && (!w || this.#error.at >= w.readAt) ? { code: this.#error.code, at: new Date(this.#error.at).toISOString() } : null;
    return {
      readAt: w ? new Date(w.readAt).toISOString() : null,
      events: w ? w.events.filter((e) => e.slotKey === null).length : 0,
      from: w?.from ?? null,
      to: w?.to ?? null,
      days: MAX_WINDOW_DAYS,
      error,
    };
  }

  // The case window: MAX_WINDOW_DAYS days from the earliest of `dates`
  // (YYYY-MM-DD) and `today`.
  static caseWindow(dates: string[], today: string): { from: string; to: string } {
    const from = [...dates, today].sort()[0]!;
    return { from, to: addDays(from, MAX_WINDOW_DAYS - 1) };
  }

  // Reads the case window and stores it, unless a clear or a change of
  // account came while it ran.
  async refresh(dates: string[], today: string): Promise<void> {
    await this.#read(GoogleCalendarEvents.caseWindow(dates, today));
  }

  // Makes sure a window read in the last FRESH_MS covers `date`, reading
  // one when none does. Throws the GoogleError of a failed read. Does
  // nothing without a calendar connection.
  async ensure(date: string, scope: { dates: string[]; today: string; reads?: CalendarReads }): Promise<void> {
    if (this.#calendar.accountKey() === null) return this.#drop();
    const zone = this.#calendar.timeZone;
    const now = this.#now();
    const covers = (w: { from: string; to: string }) => w.from <= date && date <= w.to;
    if ((this.#windows() ?? []).some((w) => w.zone === zone && covers(w) && now - w.readAt < FRESH_MS)) return;
    const primary = GoogleCalendarEvents.caseWindow(scope.dates, scope.today);
    const window = covers(primary) ? primary : { from: date, to: addDays(date, MAX_WINDOW_DAYS - 1) };
    const key = `${window.from}/${window.to}/${zone}`;
    const earlier = scope.reads?.get(key);
    if (earlier) return earlier;
    const read = this.#read(window);
    scope.reads?.set(key, read);
    return read;
  }

  // Reads the case window in the background when its last read is older
  // than FRESH_MS and no read failed in that time. One at a time. For the
  // schedule panel's clash checks, which read the case view: the page's
  // poll calls it, and `version` tells the page to reload.
  touch(scope: () => { dates: string[]; today: string }): void {
    if (this.#background || this.#calendar.accountKey() === null) return;
    const now = this.#now();
    if (this.#error && now - this.#error.at < FRESH_MS) return;
    const zone = this.#calendar.timeZone;
    const { dates, today } = scope();
    const primary = GoogleCalendarEvents.caseWindow(dates, today);
    if ((this.#windows() ?? []).some((w) => w.zone === zone && w.from === primary.from && w.to === primary.to && now - w.readAt < FRESH_MS)) return;
    this.#background = this.#read(primary)
      .catch(() => {})
      .finally(() => (this.#background = null));
  }

  async #read(window: { from: string; to: string }): Promise<void> {
    const generation = this.#generation;
    const account = this.#calendar.accountKey();
    if (account === null) return this.#drop();
    const zone = this.#calendar.timeZone;
    let events: CalendarEvent[];
    try {
      events = await this.#calendar.list(window);
    } catch (err) {
      if (generation === this.#generation) this.#error = { code: err instanceof GoogleError ? err.code : "google_unavailable", at: this.#now() };
      throw err;
    }
    if (generation !== this.#generation || this.#calendar.accountKey() !== account) return;
    const stored: Window = {
      ...window,
      zone,
      startMs: wallClockToUtc(window.from, "00:00", zone),
      endMs: wallClockToUtc(addDays(window.to, 1), "00:00", zone),
      readAt: this.#now(),
      events,
    };
    const kept = (this.#state?.account === account ? this.#state.windows : []).filter((w) => !(w.from === window.from && w.to === window.to));
    this.#state = { account, windows: [...kept, stored].sort((a, b) => a.readAt - b.readAt).slice(-MAX_WINDOWS) };
    this.#last = { window: stored };
    this.#error = null;
    this.#version += 1;
  }
}
