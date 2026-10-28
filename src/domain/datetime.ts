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
  times: string[]; // "HH:MM", stated with AM, PM, noon or in 24-hour form
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
// "on" or "for" itself, not only a space or a comma.
const LEADS = /^[\s,]*(?:on|for)[\s,]*$/i;

// Groups tokens into mentions. A weekday and a date written next to each
// other form one mention. A time belongs to the latest mention, however far
// away it is, until a new date or weekday starts another mention. So in
// "November 12 at 9:00 AM or 10:30 AM" both times belong to November 12,
// and in "Tuesday at 2:00 PM or Thursday at 10:30 AM" 10:30 belongs only to
// Thursday. A time before any date starts a mention that a following date
// joins when only "on" or "for" sits between them.
//
// SP12.5, the time written before its date: a weekday and a date written
// next to each other stay one mention when a time came before them, so
// "At 9:15 AM on Friday 11/13" is one mention. And a time that comes after
// a date, with only "on" or "for" between it and the next weekday or date,
// starts that next mention instead of joining the one before, so in "Friday
// 11/13 at 9:15 AM or at 1:00 PM on Monday 11/16" 1:00 PM belongs to Monday.
export function parseMentions(quote: string): Mention[] {
  const mentions: Mention[] = [];
  let current = null as Mention | null;
  let prevEnd = 0;
  const start = (): Mention => {
    const m: Mention = { monthDay: null, year: null, weekday: null, times: [], ambiguousTimes: [] };
    mentions.push(m);
    return m;
  };
  const hasTime = (m: Mention) => m.times.length > 0 || m.ambiguousTimes.length > 0;

  const tokens = tokenize(quote);
  let prevKind: Token["kind"] | null = null;
  for (const [i, t] of tokens.entries()) {
    const gap = quote.slice(prevEnd, t.start);
    const c: Mention | null = current;
    if (t.kind === "weekday") {
      const joins: boolean =
        c !== null &&
        c.weekday === null &&
        ((c.monthDay !== null && (!hasTime(c) || prevKind === "date") && ADJACENT.test(gap)) ||
          (c.monthDay === null && hasTime(c) && CONNECTIVE.test(gap)));
      current = joins && c ? c : start();
      current.weekday = t.weekday;
    } else if (t.kind === "date") {
      const joins: boolean =
        c !== null &&
        c.monthDay === null &&
        ((c.weekday !== null && (!hasTime(c) || prevKind === "weekday") && ADJACENT.test(gap)) ||
          (c.weekday === null && hasTime(c) && CONNECTIVE.test(gap)));
      current = joins && c ? c : start();
      current.monthDay = t.monthDay;
      current.year = t.year;
    } else {
      const next = tokens[i + 1];
      const leadsNext = next !== undefined && next.kind !== "time" && LEADS.test(quote.slice(t.end, next.start));
      const dated = c !== null && (c.monthDay !== null || c.weekday !== null);
      current = c === null || (dated && leadsNext) ? start() : c;
      if (t.time !== null) current.times.push(t.time);
      current.ambiguousTimes.push(...t.ambiguous);
    }
    prevKind = t.kind;
    prevEnd = t.end;
  }
  return mentions;
}

// A date stated only as a weekday, such as "Monday", may resolve to a date
// from the day the message arrived up to this many days later.
export const WEEKDAY_WINDOW_DAYS = 14;

const addDays = (date: string, days: number): string => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

// The dates a claim's date may mean when its quote names only a weekday,
// such as "Monday". Every date inside the weekday window that falls on that
// weekday is a candidate. Returns null when the quote states the month and
// day, or does not name the claim's weekday. More than one candidate means
// code cannot tell which date was meant, so the app asks instead of choosing.
export function weekdayOnlyCandidates(date: string, quote: string, receivedAt: string): string[] | null {
  if (!isValidDate(date)) return null;
  const mentions = parseMentions(quote);
  if (mentions.some((m) => m.monthDay === date.slice(5))) return null;
  const weekday = weekdayOf(date);
  if (!mentions.some((m) => m.monthDay === null && m.weekday === weekday)) return null;
  const received = receivedAt.slice(0, 10);
  if (!isValidDate(received)) return null;
  const candidates: string[] = [];
  for (let offset = 0; offset <= WEEKDAY_WINDOW_DAYS; offset++) {
    const d = addDays(received, offset);
    if (weekdayOf(d) === weekday) candidates.push(d);
  }
  return candidates;
}

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

// The year a yearless month and day may resolve to. It is the year the
// message arrived. The next year is also allowed when that month and day
// had already passed on arrival, so "January 5" received on 2026-12-20 can
// mean 2027-01-05.
function yearAllowed(year: number, monthDay: string, receivedDate: string): boolean {
  const receivedYear = Number(receivedDate.slice(0, 4));
  if (year === receivedYear) return true;
  return year === receivedYear + 1 && monthDay < receivedDate.slice(5);
}

type DateMatch = { mentions: Mention[]; issue: SlotIssue | null };

// The mentions that state `date` as a month and day, held to the weekday and
// year rules.
function explicitMentions(date: string, mentions: Mention[], receivedDate: string): DateMatch | null {
  const monthDay = date.slice(5);
  const explicit = mentions.filter((m) => m.monthDay === monthDay);
  if (explicit.length === 0) return null;
  const year = Number(date.slice(0, 4));
  const weekday = weekdayOf(date);
  const weekdayOk = explicit.filter((m) => m.weekday === null || m.weekday === weekday);
  const yearOk = weekdayOk.filter((m) => (m.year !== null ? m.year === year : yearAllowed(year, monthDay, receivedDate)));
  if (weekdayOk.length === 0) return { mentions: [], issue: "weekday_mismatch" };
  if (yearOk.length === 0) return { mentions: [], issue: "date_year_mismatch" };
  return { mentions: yearOk, issue: null };
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

  // The mentions that state the claim's date. The time must come from one
  // of them. When the date fails, the time is still checked against every
  // mention.
  let dateMentions: Mention[] = mentions;
  if (input.date !== null && isValidDate(input.date)) {
    const explicit = explicitMentions(input.date, mentions, receivedDate);
    if (explicit !== null) {
      if (explicit.issue) issues.push(explicit.issue);
      else dateMentions = explicit.mentions;
    } else {
      const byWeekday = mentions.filter((m) => m.monthDay === null && m.weekday === weekdayOf(input.date!));
      const offset = dayNumber(input.date) - dayNumber(receivedDate);
      if (byWeekday.length === 0) issues.push("date_not_in_quote");
      else if (!isValidDate(receivedDate) || offset < 0 || offset > WEEKDAY_WINDOW_DAYS) issues.push("date_outside_window");
      else dateMentions = byWeekday;
    }
  }

  if (input.time !== null && isValidTime(input.time)) {
    if (!dateMentions.some((m) => m.times.includes(input.time!))) {
      issues.push(dateMentions.some((m) => m.ambiguousTimes.includes(input.time!)) ? "ambiguous_time" : "time_not_in_quote");
    }
  }

  // An event time must name a month and day in the quote, under the same
  // weekday and year rules as a claim date. A weekday alone is not enough,
  // because an event time is usually in the past.
  if (input.event_time !== null && isValidEventTime(input.event_time)) {
    const time = input.event_time.length > 10 ? input.event_time.slice(11, 16) : null;
    const explicit = explicitMentions(input.event_time.slice(0, 10), mentions, receivedDate);
    if (explicit === null || explicit.issue !== null || (time !== null && !explicit.mentions.some((m) => m.times.includes(time)))) {
      issues.push("event_time_not_in_quote");
    }
  }
  return issues;
}
