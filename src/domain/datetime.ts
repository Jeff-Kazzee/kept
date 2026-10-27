// Date and time checks done in code. The model returns dates as YYYY-MM-DD
// and times as 24-hour HH:MM. Code rejects anything else, and rejects values
// that contradict the dates and times written in the claim's quote. It never
// repairs or guesses a value.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EVENT_TIME_RE = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

export function isValidDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function isValidEventTime(value: string): boolean {
  if (!EVENT_TIME_RE.test(value)) return false;
  return isValidDate(value.slice(0, 10));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// 0 is Sunday.
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, wed: 3, thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

export type QuoteMentions = {
  monthDays: Set<string>; // "MM-DD"
  years: Set<number>;
  weekdays: Set<number>;
  times: Set<string>; // "HH:MM", stated with AM, PM, noon or in 24-hour form
  ambiguousTimes: Set<string>; // both readings of a bare "2:00"
};

const pad = (n: number) => String(n).padStart(2, "0");

export function mentionsIn(quote: string): QuoteMentions {
  const out: QuoteMentions = {
    monthDays: new Set(),
    years: new Set(),
    weekdays: new Set(),
    times: new Set(),
    ambiguousTimes: new Set(),
  };
  const text = quote.toLowerCase();

  const monthNames = Object.keys(MONTHS).join("|");
  for (const m of text.matchAll(new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "g"))) {
    const month = MONTHS[m[1]!]!;
    const day = Number(m[2]);
    if (day >= 1 && day <= 31) out.monthDays.add(`${pad(month)}-${pad(day)}`);
    if (m[3]) out.years.add(Number(m[3]));
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) out.monthDays.add(`${pad(month)}-${pad(day)}`);
    if (m[3]) out.years.add(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]));
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    out.monthDays.add(`${m[2]}-${m[3]}`);
    out.years.add(Number(m[1]));
  }

  const weekdayNames = Object.keys(WEEKDAYS).join("|");
  for (const m of text.matchAll(new RegExp(`\\b(${weekdayNames})\\b\\.?`, "g"))) {
    out.weekdays.add(WEEKDAYS[m[1]!]!);
  }

  // Times with a meridiem: "2:00 PM", "9:15am", "1 p.m.".
  const withMeridiem = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s?m\b\.?/g;
  const covered: Array<[number, number]> = [];
  for (const m of text.matchAll(withMeridiem)) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) continue;
    const min = m[2] ?? "00";
    const hour = m[3] === "p" ? (h % 12) + 12 : h % 12;
    out.times.add(`${pad(hour)}:${min}`);
    covered.push([m.index, m.index + m[0].length]);
  }
  if (/\bnoon\b/.test(text)) out.times.add("12:00");
  if (/\bmidnight\b/.test(text)) out.times.add("00:00");

  // Times without a meridiem. "14:00" is clear. "2:00" could be 02:00 or
  // 14:00, so both readings are marked ambiguous.
  for (const m of text.matchAll(/\b(\d{1,2}):([0-5]\d)\b/g)) {
    if (covered.some(([s, e]) => m.index >= s && m.index < e)) continue;
    const h = Number(m[1]);
    if (h > 23) continue;
    if (h === 0 || h >= 13 || (m[1]!.length === 2 && m[1]!.startsWith("0"))) {
      out.times.add(`${pad(h)}:${m[2]}`);
    } else if (h === 12) {
      out.ambiguousTimes.add(`12:${m[2]}`);
      out.ambiguousTimes.add(`00:${m[2]}`);
    } else {
      out.ambiguousTimes.add(`${pad(h)}:${m[2]}`);
      out.ambiguousTimes.add(`${pad(h + 12)}:${m[2]}`);
    }
  }
  return out;
}

export type SlotIssue =
  | "invalid_date"
  | "invalid_time"
  | "invalid_event_time"
  | "date_not_in_quote"
  | "weekday_mismatch"
  | "year_not_in_quote"
  | "time_not_in_quote"
  | "ambiguous_time";

// Checks a claim's date, time and event time against format rules and
// against the dates and times its quote states. A quote with no date or
// time words gives nothing to compare, so only the format rules apply.
export function checkSlotValues(input: {
  date: string | null;
  time: string | null;
  event_time: string | null;
  quote: string;
}): SlotIssue[] {
  const issues: SlotIssue[] = [];
  const mentions = mentionsIn(input.quote);

  if (input.date !== null) {
    if (!isValidDate(input.date)) {
      issues.push("invalid_date");
    } else {
      const monthDay = input.date.slice(5);
      if (mentions.monthDays.size > 0 && !mentions.monthDays.has(monthDay)) issues.push("date_not_in_quote");
      if (mentions.weekdays.size > 0 && !mentions.weekdays.has(weekdayOf(input.date))) issues.push("weekday_mismatch");
      if (mentions.years.size > 0 && !mentions.years.has(Number(input.date.slice(0, 4)))) issues.push("year_not_in_quote");
    }
  }

  if (input.time !== null) {
    if (!isValidTime(input.time)) {
      issues.push("invalid_time");
    } else if (!mentions.times.has(input.time)) {
      if (mentions.ambiguousTimes.has(input.time)) issues.push("ambiguous_time");
      else if (mentions.times.size > 0 || mentions.ambiguousTimes.size > 0) issues.push("time_not_in_quote");
    }
  }

  if (input.event_time !== null && !isValidEventTime(input.event_time)) issues.push("invalid_event_time");
  return issues;
}
