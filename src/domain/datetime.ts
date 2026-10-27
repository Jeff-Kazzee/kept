// Date and time checks done in code. The model returns dates as YYYY-MM-DD
// and times as 24-hour HH:MM. Code rejects anything else. A non-null date or
// time must be stated in the claim's quote, and a date and time must come
// from the same mention, so values from two different offers cannot be
// mixed. Code never repairs or guesses a value.

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

// One mention of a point in time in a quote, such as "Tuesday, November 10
// at 2:00 PM". Dates, weekdays and times that sit next to each other belong
// to the same mention.
export type Mention = {
  monthDay: string | null; // "MM-DD"
  year: number | null;
  weekday: number | null;
  time: string | null; // "HH:MM", stated with AM, PM, noon or in 24-hour form
  ambiguousTimes: string[]; // both readings of a bare "2:00"
};

type Token = { start: number; end: number } & (
  | { kind: "date"; monthDay: string; year: number | null }
  | { kind: "weekday"; weekday: number }
  | { kind: "time"; time: string | null; ambiguous: string[] }
);

const pad = (n: number) => String(n).padStart(2, "0");

function tokenize(quote: string): Token[] {
  const text = quote.toLowerCase();
  const tokens: Token[] = [];
  const at = (m: RegExpMatchArray) => ({ start: m.index!, end: m.index! + m[0].length });

  const monthNames = Object.keys(MONTHS).join("|");
  for (const m of text.matchAll(new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, "g"))) {
    const day = Number(m[2]);
    if (day < 1 || day > 31) continue;
    tokens.push({ ...at(m), kind: "date", monthDay: `${pad(MONTHS[m[1]!]!)}-${pad(day)}`, year: m[3] ? Number(m[3]) : null });
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    tokens.push({ ...at(m), kind: "date", monthDay: `${pad(month)}-${pad(day)}`, year });
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    tokens.push({ ...at(m), kind: "date", monthDay: `${m[2]}-${m[3]}`, year: Number(m[1]) });
  }

  const weekdayNames = Object.keys(WEEKDAYS).join("|");
  for (const m of text.matchAll(new RegExp(`\\b(${weekdayNames})\\b\\.?`, "g"))) {
    tokens.push({ ...at(m), kind: "weekday", weekday: WEEKDAYS[m[1]!]! });
  }

  // Times with a meridiem: "2:00 PM", "9:15am", "1 p.m.".
  for (const m of text.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s?m\b\.?/g)) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) continue;
    const hour = m[3] === "p" ? (h % 12) + 12 : h % 12;
    tokens.push({ ...at(m), kind: "time", time: `${pad(hour)}:${m[2] ?? "00"}`, ambiguous: [] });
  }
  for (const m of text.matchAll(/\bnoon\b/g)) tokens.push({ ...at(m), kind: "time", time: "12:00", ambiguous: [] });
  for (const m of text.matchAll(/\bmidnight\b/g)) tokens.push({ ...at(m), kind: "time", time: "00:00", ambiguous: [] });

  // Times without a meridiem. "14:00" is clear. "2:00" could be 02:00 or
  // 14:00, so both readings are kept as ambiguous.
  for (const m of text.matchAll(/\b(\d{1,2}):([0-5]\d)\b/g)) {
    const h = Number(m[1]);
    if (h > 23) continue;
    const span = at(m);
    if (h === 0 || h >= 13 || (m[1]!.length === 2 && m[1]!.startsWith("0"))) {
      tokens.push({ ...span, kind: "time", time: `${pad(h)}:${m[2]}`, ambiguous: [] });
    } else if (h === 12) {
      tokens.push({ ...span, kind: "time", time: null, ambiguous: [`12:${m[2]}`, `00:${m[2]}`] });
    } else {
      tokens.push({ ...span, kind: "time", time: null, ambiguous: [`${pad(h)}:${m[2]}`, `${pad(h + 12)}:${m[2]}`] });
    }
  }

  // Keep the first token at each position and drop tokens inside an earlier
  // one, such as the "2:00" inside "2:00 PM".
  tokens.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Token[] = [];
  for (const t of tokens) {
    const last = kept.at(-1);
    if (last && t.start < last.end) continue;
    kept.push(t);
  }
  return kept;
}

const ADJACENT = /^[\s,()]*$/;
const CONNECTIVE = /^[\s,]*(?:on|for)?[\s,]*$/i;
const NEAR_TIME = /^[^.!?;]{0,15}$/;

export function parseMentions(quote: string): Mention[] {
  const mentions: Mention[] = [];
  let current = null as Mention | null;
  let prevEnd = 0;
  const start = (): Mention => {
    const m: Mention = { monthDay: null, year: null, weekday: null, time: null, ambiguousTimes: [] };
    mentions.push(m);
    return m;
  };
  const hasTime = (m: Mention) => m.time !== null || m.ambiguousTimes.length > 0;

  for (const t of tokenize(quote)) {
    const gap = quote.slice(prevEnd, t.start);
    const c: Mention | null = current;
    if (t.kind === "weekday") {
      const joins: boolean =
        c !== null &&
        c.weekday === null &&
        ((c.monthDay !== null && ADJACENT.test(gap)) || (c.monthDay === null && hasTime(c) && CONNECTIVE.test(gap)));
      current = joins && c ? c : start();
      current.weekday = t.weekday;
    } else if (t.kind === "date") {
      const joins: boolean =
        c !== null &&
        c.monthDay === null &&
        ((c.weekday !== null && ADJACENT.test(gap)) || (c.weekday === null && hasTime(c) && CONNECTIVE.test(gap)));
      current = joins && c ? c : start();
      current.monthDay = t.monthDay;
      current.year = t.year;
    } else {
      const joins: boolean = c !== null && !hasTime(c) && (c.monthDay !== null || c.weekday !== null) && NEAR_TIME.test(gap);
      current = joins && c ? c : start();
      current.time = t.time;
      current.ambiguousTimes = t.ambiguous;
    }
    prevEnd = t.end;
  }
  return mentions;
}

// A date stated only as a weekday, such as "Monday", may resolve to a date
// from the day the message arrived up to this many days later.
export const WEEKDAY_WINDOW_DAYS = 14;

export type SlotIssue =
  | "invalid_date"
  | "invalid_time"
  | "invalid_event_time"
  | "date_not_in_quote"
  | "weekday_mismatch"
  | "date_year_mismatch"
  | "date_outside_window"
  | "time_not_in_quote"
  | "ambiguous_time"
  | "event_time_not_in_quote";

const dayNumber = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

// Format rules only. Used for manual entries, where the user is the source.
export function checkSlotFormats(input: { date: string | null; time: string | null; event_time: string | null }): SlotIssue[] {
  const issues: SlotIssue[] = [];
  if (input.date !== null && !isValidDate(input.date)) issues.push("invalid_date");
  if (input.time !== null && !isValidTime(input.time)) issues.push("invalid_time");
  if (input.event_time !== null && !isValidEventTime(input.event_time)) issues.push("invalid_event_time");
  return issues;
}

// Checks a claim's date, time and event time against format rules and
// against the mentions in its quote. `receivedAt` is the message's ISO
// arrival time. Its first ten characters are the local arrival date.
export function checkSlotValues(input: {
  date: string | null;
  time: string | null;
  event_time: string | null;
  quote: string;
  receivedAt: string;
}): SlotIssue[] {
  const issues = checkSlotFormats(input);
  const mentions = parseMentions(input.quote);
  const receivedDate = input.receivedAt.slice(0, 10);
  const receivedYear = Number(receivedDate.slice(0, 4));

  // The mentions that state the claim's date. The time must come from one
  // of them.
  let dateMentions: Mention[] = mentions;
  if (input.date !== null && isValidDate(input.date)) {
    const monthDay = input.date.slice(5);
    const year = Number(input.date.slice(0, 4));
    const weekday = weekdayOf(input.date);
    const explicit = mentions.filter((m) => m.monthDay === monthDay);
    if (explicit.length > 0) {
      const weekdayOk = explicit.filter((m) => m.weekday === null || m.weekday === weekday);
      const yearOk = weekdayOk.filter((m) =>
        m.year !== null ? m.year === year : year === receivedYear || year === receivedYear + 1,
      );
      if (weekdayOk.length === 0) issues.push("weekday_mismatch");
      else if (yearOk.length === 0) issues.push("date_year_mismatch");
      // When the date fails, the time is still checked against every mention.
      dateMentions = yearOk.length > 0 ? yearOk : mentions;
    } else {
      const byWeekday = mentions.filter((m) => m.monthDay === null && m.weekday === weekday);
      const offset = dayNumber(input.date) - dayNumber(receivedDate);
      if (byWeekday.length === 0) issues.push("date_not_in_quote");
      else if (!isValidDate(receivedDate) || offset < 0 || offset > WEEKDAY_WINDOW_DAYS) issues.push("date_outside_window");
      dateMentions = issues.length === 0 ? byWeekday : mentions;
    }
  }

  if (input.time !== null && isValidTime(input.time)) {
    if (!dateMentions.some((m) => m.time === input.time)) {
      issues.push(dateMentions.some((m) => m.ambiguousTimes.includes(input.time!)) ? "ambiguous_time" : "time_not_in_quote");
    }
  }

  if (input.event_time !== null && isValidEventTime(input.event_time)) {
    const date = input.event_time.slice(0, 10);
    const time = input.event_time.length > 10 ? input.event_time.slice(11, 16) : null;
    const stated = mentions.filter(
      (m) => m.monthDay === date.slice(5) && (m.year === null || m.year === Number(date.slice(0, 4))),
    );
    if (stated.length === 0 || (time !== null && !stated.some((m) => m.time === time))) {
      issues.push("event_time_not_in_quote");
    }
  }
  return issues;
}
