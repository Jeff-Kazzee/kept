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
// events an older one held for the same days.
//
// Fix round 2 (N1, N2): each chat turn, or each MCP call, has a
// CalendarTurn. It holds every window the turn read or found fresh, so none
// of them is evicted while the turn runs, and it allows at most
// TURN_READ_BUDGET reads of Google. A date that would need a read past the
// budget is answered as unread (google_read_limit), never as free.
// calendar_list goes through the same turn, so a window listed twice in a
// turn is read once.
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
// The most windows kept that no running turn holds. The oldest read goes
// first. A window a running turn holds is never dropped: the turns' read
// budgets bound them.
const MAX_WINDOWS = 4;
// Google reads one turn may start (proposed in 0016).
export const TURN_READ_BUDGET = 8;
// A turn that was never released stops holding its windows after this.
const TURN_MAX_MS = 15 * 60_000;

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

// The calendar reads of one chat turn or MCP call. A read still running is
// shared. A failed read stays failed for the rest of the turn. A read that
// worked is read again only when its window is no longer kept or no longer
// fresh. `held` names the windows the turn read or found fresh.
export class CalendarTurn {
  readonly budget: number;
  // Set on the clock of the events the first time the turn holds a window.
  startedAt: number | null = null;
  reads = 0;
  readonly windows = new Map<string, { read: Promise<void>; state: "pending" | "ok" | "failed" }>();
  readonly lists = new Map<string, Promise<CalendarEvent[]>>();
  readonly held = new Set<string>();
  constructor(budget = TURN_READ_BUDGET) {
    this.budget = budget;
  }
  // Counts one read, or throws google_read_limit past the budget.
  spend(): void {
    if (this.reads >= this.budget) throw new GoogleError("google_read_limit");
    this.reads += 1;
  }
}

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
  // The turns running now. Their windows are never evicted.
  readonly #turns = new Set<CalendarTurn>();
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
    this.#turns.clear();
  }

  // Without a calendar connection: drops what is stored, once.
  #drop(): void {
    if (this.#state || this.#last || this.#error) this.clear();
  }

  // For each stored window, when it was read and the slots whose own event
  // it found live, so the page can say an event was removed in Google
  // Calendar (0017, fix round 1). Empty without a calendar connection.
  ownSeen(): Array<{ from: string; to: string; readAt: string; slots: string[] }> {
    return (this.#windows() ?? []).map((w) => ({
      from: w.from,
      to: w.to,
      readAt: new Date(w.readAt).toISOString(),
      slots: [...new Set(w.events.flatMap((e) => (e.slotKey === null ? [] : [e.slotKey])))],
    }));
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

  // The turn is done: its windows may be evicted again.
  release(turn: CalendarTurn): void {
    this.#turns.delete(turn);
  }

  #hold(turn: CalendarTurn | undefined, key: string): void {
    if (!turn) return;
    turn.held.add(key);
    turn.startedAt ??= this.#now();
    this.#turns.add(turn);
  }

  // Makes sure a window read in the last FRESH_MS covers `date`, reading
  // one when none does, and holds that window for the turn (fix round 2,
  // R1). Throws the GoogleError of a failed read, google_read_limit past
  // the turn's budget, and google_stale when the connection changed while
  // it read. Does nothing without a calendar connection.
  async ensure(date: string, scope: { dates: string[]; today: string; turn?: CalendarTurn }): Promise<void> {
    if (this.#calendar.accountKey() === null) return this.#drop();
    const { turn } = scope;
    const zone = this.#calendar.timeZone;
    const now = this.#now();
    const covers = (w: { from: string; to: string }) => w.from <= date && date <= w.to;
    const fresh = (this.#windows() ?? []).find((w) => w.zone === zone && covers(w) && now - w.readAt < FRESH_MS);
    if (fresh) return this.#hold(turn, windowKey(fresh, zone));
    const primary = GoogleCalendarEvents.caseWindow(scope.dates, scope.today);
    const window = covers(primary) ? primary : { from: date, to: addDays(date, MAX_WINDOW_DAYS - 1) };
    const key = windowKey(window, zone);
    const earlier = turn?.windows.get(key);
    if (earlier && earlier.state !== "ok") return earlier.read;
    turn?.spend();
    this.#hold(turn, key);
    const entry: { read: Promise<void>; state: "pending" | "ok" | "failed" } = { read: Promise.resolve(), state: "pending" };
    entry.read = this.#read(window).then(
      () => void (entry.state = "ok"),
      (err) => {
        entry.state = "failed";
        throw err;
      },
    );
    turn?.windows.set(key, entry);
    return entry.read;
  }

  // calendar_list's read: Google's events in a window, stored nowhere
  // (review round 3, finding 5). A turn reads each window once and counts
  // it against its budget (fix round 2, N2).
  list(window: { from: string; to: string }, turn?: CalendarTurn): Promise<CalendarEvent[]> {
    if (!turn) return this.#calendar.list(window);
    const key = windowKey(window, this.#calendar.timeZone);
    const earlier = turn.lists.get(key);
    if (earlier) return earlier;
    turn.spend();
    const read = this.#calendar.list(window);
    turn.lists.set(key, read);
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

  // One read of a window at a time: a caller that asks while it runs gets
  // the same read.
  #read(window: { from: string; to: string }): Promise<void> {
    const zone = this.#calendar.timeZone;
    const key = `${this.#generation}|${this.#calendar.accountKey()}|${windowKey(window, zone)}`;
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
    // Fix round 2, N5: a read the connection outlived is not a success.
    // Nothing is stored, and the caller treats the date as unread.
    if (generation !== this.#generation || this.#calendar.accountKey() !== account) throw new GoogleError("google_stale");
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

  // The windows to keep, oldest first: every one a running turn holds, and
  // the newest others up to MAX_WINDOWS.
  #keep(windows: Window[], now: number): Window[] {
    for (const t of this.#turns) if (t.startedAt !== null && now - t.startedAt > TURN_MAX_MS) this.#turns.delete(t);
    const held = (w: Window) => [...this.#turns].some((t) => t.held.has(windowKey(w, w.zone)));
    const sorted = [...windows].sort((a, b) => a.readAt - b.readAt);
    const others = sorted.filter((w) => !held(w)).slice(-MAX_WINDOWS);
    return sorted.filter((w) => held(w) || others.includes(w));
  }
}
