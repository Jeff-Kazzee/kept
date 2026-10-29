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
// The most windows kept. The oldest read goes first, except a window a chat
// turn read in the last PIN_MS, so a turn never loses a window it read
// (fix round 1, R1). HARD_MAX_WINDOWS bounds them all.
const MAX_WINDOWS = 4;
const PIN_MS = 5 * 60_000;
const HARD_MAX_WINDOWS = 16;

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

// The reads of one chat turn, by window. A read still running is shared. A
// failed read stays failed for the rest of the turn. A read that worked is
// read again only when its window is no longer kept or no longer fresh.
export type CalendarReads = Map<string, { read: Promise<void>; state: "pending" | "ok" | "failed" }>;

const windowKey = (w: { from: string; to: string }, zone: string) => `${w.from}/${w.to}/${zone}`;

// Whether a newer window holds the day an event starts on. A timed event's
// instant is compared with the window's bounds. An all-day event is a date,
// compared with the window's dates in its own zone (fix round 1, R4).
const holds = (w: Window, e: CalendarEvent) => {
  if (e.start.time === null) return w.from <= e.start.date && e.start.date <= w.to;
  const t = Date.parse(`${e.start.date}T${e.start.time}:00Z`);
  return t >= w.startMs && t < w.endMs;
};

export class GoogleCalendarEvents {
  readonly #calendar: GoogleCalendar;
  readonly #now: () => number;
  #state: { account: string; windows: Window[] } | null = null;
  #generation = 0;
  #last: { window: Window } | null = null;
  #error: { code: string; at: number } | null = null;
  #background: Promise<void> | null = null;
  // One read per window at a time, shared by refresh, ensure and touch
  // (fix round 1, R2).
  readonly #inflight = new Map<string, Promise<void>>();
  // Windows a chat turn read, kept until the time given.
  readonly #pins = new Map<string, number>();
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
        if (newest.slice(0, i).some((n) => holds(n, e))) continue;
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
    this.#pins.clear();
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
    const kept = this.#windows() ?? [];
    if (kept.some((w) => w.zone === zone && covers(w) && now - w.readAt < FRESH_MS)) return;
    const primary = GoogleCalendarEvents.caseWindow(scope.dates, scope.today);
    const window = covers(primary) ? primary : { from: date, to: addDays(date, MAX_WINDOW_DAYS - 1) };
    const key = windowKey(window, zone);
    const earlier = scope.reads?.get(key);
    if (earlier && earlier.state !== "ok") return earlier.read;
    const entry: { read: Promise<void>; state: "pending" | "ok" | "failed" } = { read: Promise.resolve(), state: "pending" };
    // A clash check's window is pinned, so the checks after it in the same
    // turn or call still find it.
    entry.read = this.#read(window, true).then(
      () => void (entry.state = "ok"),
      (err) => {
        entry.state = "failed";
        throw err;
      },
    );
    scope.reads?.set(key, entry);
    return entry.read;
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

  // One read of a window at a time: a caller that asks while it runs gets
  // the same read. `pin` keeps the window for PIN_MS.
  #read(window: { from: string; to: string }, pin = false): Promise<void> {
    const zone = this.#calendar.timeZone;
    const key = `${this.#generation}|${this.#calendar.accountKey()}|${windowKey(window, zone)}`;
    if (pin) this.#pins.set(windowKey(window, zone), this.#now() + PIN_MS);
    const running = this.#inflight.get(key);
    if (running) return running;
    const read = this.#fetch(window).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, read);
    return read;
  }

  async #fetch(window: { from: string; to: string }): Promise<void> {
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
    const now = this.#now();
    const stored: Window = {
      ...window,
      zone,
      startMs: wallClockToUtc(window.from, "00:00", zone),
      endMs: wallClockToUtc(addDays(window.to, 1), "00:00", zone),
      readAt: now,
      events,
    };
    const kept = (this.#state?.account === account ? this.#state.windows : []).filter((w) => !(w.from === window.from && w.to === window.to && w.zone === zone));
    this.#state = { account, windows: this.#keep([...kept, stored], now) };
    this.#last = { window: stored };
    this.#error = null;
    this.#version += 1;
  }

  // The windows to keep, oldest first: every pinned one, and the newest
  // others up to MAX_WINDOWS, never more than HARD_MAX_WINDOWS.
  #keep(windows: Window[], now: number): Window[] {
    for (const [k, until] of this.#pins) if (until <= now) this.#pins.delete(k);
    const pinned = (w: Window) => this.#pins.has(windowKey(w, w.zone));
    const sorted = [...windows].sort((a, b) => a.readAt - b.readAt);
    const others = sorted.filter((w) => !pinned(w)).slice(-MAX_WINDOWS);
    return sorted.filter((w) => pinned(w) || others.includes(w)).slice(-HARD_MAX_WINDOWS);
  }
}
