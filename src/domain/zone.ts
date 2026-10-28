// Time zone math for the case (0009, J5). The person or their agent sets
// the case's time zone. Every time the app shows or resolves uses it:
// display strings, slot and calendar clash math, relative days in the
// agent's checks, the received time on import and chat send times. No zone
// is built in. A case with no zone set uses UTC until the page sends the
// browser's zone or someone sets one. Runs in the browser and in Node, so
// it must not import Node modules.

export const DEFAULT_TIME_ZONE = "UTC";

// An IANA name such as America/Denver, Asia/Tokyo, Europe/London or UTC.
// Offsets such as +05:00 are refused, because they do not follow daylight
// time.
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

// The zone's canonical name, or null when it is not a time zone this
// runtime knows.
export function canonicalZone(name: unknown): string | null {
  if (typeof name !== "string" || name.length > 64 || !ZONE_NAME.test(name)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export const isTimeZone = (name: unknown): name is string => canonicalZone(name) !== null;

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(utcMs: number, zone: string): Parts {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  const parts = f.formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

// The zone's offset from UTC at an instant, in ms.
function offsetMs(utcMs: number, zone: string): number {
  const p = partsIn(utcMs, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

// The zone to compute in: `zone` when it is known, otherwise `fallback`.
export const knownZoneOr = (zone: string | null | undefined, fallback: string): string => (zone && isTimeZone(zone) ? zone : fallback);

// The UTC instant of a wall-clock time in a zone, found in two steps from
// the zone's offset near that time.
export function wallClockToUtc(date: string, time: string, zone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(guess, zone);
  return guess - offsetMs(first, zone);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function wallClockOf(utcMs: number, zone: string): string {
  const p = partsIn(utcMs, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// The local date and time of an instant in a zone.
export function localDateTime(utcMs: number, zone: string): { date: string; time: string } {
  const s = wallClockOf(utcMs, zone);
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

// An instant written with the zone's offset at that instant, such as
// 2026-11-05T10:00:00.000-07:00. Times on both sides of a daylight change
// carry their own offsets.
export function zonedIso(iso: string, zone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const p = partsIn(ms, zone);
  const offsetMin = Math.round(offsetMs(ms, zone) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(new Date(ms).getUTCMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// The local date of an instant in a zone, YYYY-MM-DD.
export const localDate = (iso: string, zone: string): string => zonedIso(iso, zone).slice(0, 10);
