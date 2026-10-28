// Calendar clash detection against the events of a loaded .ics file. Times
// in the case are wall-clock times in the case's time zone, which the
// person or their agent sets (0009, J5). Calendar times with a TZID are
// wall-clock times in that zone, and times with no zone are in the case's
// zone. UTC times are converted. An appointment slot has no stated end, so
// it is assumed to last ASSUMED_SLOT_MINUTES. A slot clashes with an event
// when the two intervals intersect. Recurring events count only their
// first instance, because the .ics reader does not expand RRULE.
import type { IcsEvent, IcsTime } from "../domain/ics.ts";
import { knownZoneOr, wallClockToUtc } from "../domain/zone.ts";

export const ASSUMED_SLOT_MINUTES = 60;

export type Clash = {
  uid: string | null;
  summary: string;
  start: IcsTime;
  end: IcsTime | null;
  recurring: boolean;
};

const MINUTE = 60_000;

// The instant of a calendar time. A TZID this runtime does not know is read
// in the case's zone.
export function icsInstant(t: IcsTime, caseZone: string): number {
  if (t.time === null) return wallClockToUtc(t.date, "00:00", caseZone);
  if (t.utc) {
    const [y, m, d] = t.date.split("-").map(Number) as [number, number, number];
    const [h, mi] = t.time.split(":").map(Number) as [number, number];
    return Date.UTC(y, m - 1, d, h, mi);
  }
  return wallClockToUtc(t.date, t.time, knownZoneOr(t.tzid, caseZone));
}

const nextDate = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

// An all-day event with no end lasts until local midnight of the next
// date, as in RFC 5545. That day is 23 or 25 hours long when daylight time
// starts or ends in the case's zone. A timed event with no end has no
// length.
function eventInterval(ev: IcsEvent, zone: string): [number, number] {
  const start = icsInstant(ev.start, zone);
  if (ev.end) return [start, icsInstant(ev.end, zone)];
  return [start, ev.start.time === null ? wallClockToUtc(nextDate(ev.start.date), "00:00", zone) : start];
}

// The events that clash with a slot at `date` and `time` in `zone`, the
// case's time zone.
export function findClashes(date: string, time: string, events: IcsEvent[], zone: string): Clash[] {
  const start = wallClockToUtc(date, time, zone);
  const end = start + ASSUMED_SLOT_MINUTES * MINUTE;
  return events
    .filter((ev) => {
      const [evStart, evEnd] = eventInterval(ev, zone);
      if (evEnd <= evStart) return start <= evStart && evStart < end;
      return start < evEnd && evStart < end;
    })
    .map((ev) => ({ uid: ev.uid, summary: ev.summary, start: ev.start, end: ev.end, recurring: ev.recurring }));
}
