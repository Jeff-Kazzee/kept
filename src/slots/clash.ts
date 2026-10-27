// Calendar clash detection against the events of a loaded .ics file. Times
// in the case are wall-clock times in America/Denver. Calendar times with a
// TZID, or with no zone, are wall-clock times in that zone. UTC times are
// converted. An appointment slot has no stated end, so it is assumed to last
// ASSUMED_SLOT_MINUTES. A slot clashes with an event when the two intervals
// intersect. Recurring events count only their first instance, because the
// .ics reader does not expand RRULE.
import type { IcsEvent, IcsTime } from "../domain/ics.ts";

export const CASE_TIME_ZONE = "America/Denver";
export const ASSUMED_SLOT_MINUTES = 60;

export type Clash = {
  uid: string | null;
  summary: string;
  start: IcsTime;
  end: IcsTime | null;
  recurring: boolean;
};

const MINUTE = 60_000;

function offsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}

function knownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// The UTC instant of a wall-clock time in a time zone. An unknown zone name
// is read as the case zone.
export function wallClockToUtc(date: string, time: string, timeZone: string = CASE_TIME_ZONE): number {
  const zone = knownZone(timeZone) ? timeZone : CASE_TIME_ZONE;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(guess, zone);
  return guess - offsetMs(first, zone);
}

function icsInstant(t: IcsTime): number {
  if (t.time === null) return wallClockToUtc(t.date, "00:00");
  if (t.utc) {
    const [y, m, d] = t.date.split("-").map(Number) as [number, number, number];
    const [h, mi] = t.time.split(":").map(Number) as [number, number];
    return Date.UTC(y, m - 1, d, h, mi);
  }
  return wallClockToUtc(t.date, t.time, t.tzid ?? CASE_TIME_ZONE);
}

const nextDate = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

// An all-day event with no end lasts until local midnight of the next
// date, as in RFC 5545. That day is 23 or 25 hours long when daylight time
// starts or ends. A timed event with no end has no length.
function eventInterval(ev: IcsEvent): [number, number] {
  const start = icsInstant(ev.start);
  if (ev.end) return [start, icsInstant(ev.end)];
  return [start, ev.start.time === null ? wallClockToUtc(nextDate(ev.start.date), "00:00") : start];
}

export function findClashes(date: string, time: string, events: IcsEvent[]): Clash[] {
  const start = wallClockToUtc(date, time);
  const end = start + ASSUMED_SLOT_MINUTES * MINUTE;
  return events
    .filter((ev) => {
      const [evStart, evEnd] = eventInterval(ev);
      if (evEnd <= evStart) return start <= evStart && evStart < end;
      return start < evEnd && evStart < end;
    })
    .map((ev) => ({ uid: ev.uid, summary: ev.summary, start: ev.start, end: ev.end, recurring: ev.recurring }));
}
