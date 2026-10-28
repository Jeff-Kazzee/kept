// Dates and times in the agent's text, made readable for the grounding
// check (0007, finding 4). The shared parser in src/domain/datetime.ts reads
// month names, numeric dates, weekdays and clock times. Model text can say
// the same thing in other ways, so this rewrites them first:
//   - compatibility forms and hidden characters, any decimal digits,
//     markdown emphasis and code markers
//   - spelled hours and clock words: "one in the afternoon", "half past
//     one", "one thirty pm", "1 o'clock"
//   - spelled and numeric ordinals next to a month, and day-month order:
//     "the sixteenth of November", "16 November"
//   - relative days from the turn's date: today, tonight, tomorrow,
//     yesterday, this, next or last <weekday>
// A day written alone ("the 16th") is left for the grounding check, which
// resolves it against the facts. Anything else that looks like a date or a
// time and is still not readable is reported, and the check fails closed.
import { weekdayOf } from "../domain/datetime.ts";
import { normalizeForScope } from "../domain/scope.ts";

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = "sunday|monday|tuesday|wednesday|thursday|friday|saturday";

const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const ORDINAL_UNITS = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth"];

// "one" to "thirty-one", and "first" to "thirty-first".
const NUMBER_WORDS = new Map<string, number>();
const ORDINAL_WORDS = new Map<string, number>();
for (let n = 1; n <= 31; n++) {
  const tens = n >= 30 ? "thirty" : n >= 20 ? "twenty" : null;
  const unit = n % 10;
  if (n < 20) {
    NUMBER_WORDS.set(UNITS[n]!, n);
    ORDINAL_WORDS.set(ORDINAL_UNITS[n]!, n);
  } else if (unit === 0) {
    NUMBER_WORDS.set(tens!, n);
    ORDINAL_WORDS.set(`${tens!.slice(0, -1)}ieth`, n);
  } else {
    for (const sep of ["-", " "]) {
      NUMBER_WORDS.set(`${tens}${sep}${UNITS[unit]}`, n);
      ORDINAL_WORDS.set(`${tens}${sep}${ORDINAL_UNITS[unit]}`, n);
    }
  }
}
const byLength = (words: Iterable<string>) => [...words].sort((a, b) => b.length - a.length).join("|");
const NUM = `(?:\\d{1,2}|${byLength(NUMBER_WORDS.keys())})`;
const ORD = `(?:\\d{1,2}(?:st|nd|rd|th)|${byLength(ORDINAL_WORDS.keys())})`;
const MINUTE_WORDS: Record<string, string> = { fifteen: "15", thirty: "30", "forty-five": "45", "forty five": "45", "o five": "05", "oh five": "05" };
const MIN = `(?:${Object.keys(MINUTE_WORDS).join("|")})`;

const num = (s: string): number => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS.get(s) ?? NaN);
const ord = (s: string): number => (/^\d/.test(s) ? Number(s.replace(/\D/g, "")) : ORDINAL_WORDS.get(s) ?? NaN);
const pad = (n: number) => String(n).padStart(2, "0");

// Any decimal digit as its ASCII digit. Decimal digits come in runs of ten
// from zero, so a digit's value is its distance from the start of its run.
export function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (d) => {
    const cp = d.codePointAt(0)!;
    if (cp >= 0x30 && cp <= 0x39) return d;
    let start = cp;
    while (start > cp - 9 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    return String((cp - start) % 10);
  });
}

const addDays = (date: string, days: number): string => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const written = (date: string) => `${WEEKDAYS[weekdayOf(date)]} ${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;

function clock(h: number, m: string, meridiem: "am" | "pm" | null): string {
  if (!(h >= 1 && h <= 12)) return `${h}:${m}${meridiem ? ` ${meridiem}` : ""}`;
  return meridiem ? `${h}:${m} ${meridiem}` : `${h}:${m}`;
}

export type Canonical = { text: string; unreadable: string[] };

// `today` is the turn's date in America/Denver, YYYY-MM-DD, for relative
// days. Without it, relative days stay unreadable.
export function canonicalDates(input: string, today: string | null): Canonical {
  let t = asciiDigits(normalizeForScope(input));
  t = t.replace(/[*_`~]+/g, "").replace(/^#+\s*/gm, "");
  t = t.toLowerCase().replace(/[’‘]/g, "'");
  t = t.replace(/\b([ap])\.\s?m\b\.?/g, "$1m");

  // Clock words.
  t = t.replace(new RegExp(`\\bhalf past (${NUM})\\b`, "g"), (_m, h: string) => clock(num(h), "30", null));
  t = t.replace(new RegExp(`\\bquarter past (${NUM})\\b`, "g"), (_m, h: string) => clock(num(h), "15", null));
  t = t.replace(new RegExp(`\\bquarter to (${NUM})\\b`, "g"), (_m, h: string) => clock(num(h) === 1 ? 12 : num(h) - 1, "45", null));
  t = t.replace(new RegExp(`(?<![:/.\\d])\\b(${NUM}) (${MIN})(?=\\s*(?:am|pm|in the (?:morning|afternoon|evening)|at night)\\b)`, "g"), (_m, h: string, mm: string) => clock(num(h), MINUTE_WORDS[mm]!, null));
  t = t.replace(new RegExp(`(?<![:/.\\d])\\b(${NUM}) o'?clock\\b`, "g"), (_m, h: string) => clock(num(h), "00", null));
  t = t.replace(new RegExp(`(?<![:/.\\d])\\b(${NUM})(?=\\s*(?:am|pm)\\b)`, "g"), (_m, h: string) => String(num(h)));
  t = t.replace(new RegExp(`(?<![:/.\\d])\\b(${NUM})(?::(\\d{2}))? (?:in the morning)\\b`, "g"), (_m, h: string, mm?: string) => clock(num(h), mm ?? "00", "am"));
  t = t.replace(new RegExp(`(?<![:/.\\d])\\b(${NUM})(?::(\\d{2}))? (?:in the (?:afternoon|evening)|at night)\\b`, "g"), (_m, h: string, mm?: string) => clock(num(h), mm ?? "00", "pm"));
  t = t.replace(new RegExp(`\\b(at|by|until|from|around|after|before) (${byLength(NUMBER_WORDS.keys())})\\b(?!\\s+(?:of|claims?|times?|slots?|messages?|appointments?|items?|things?|minutes?|hours?|days?))`, "g"), (_m, w: string, h: string) => `${w} ${num(h)}`);

  // Days next to a month: "november the 16th", "the sixteenth of november",
  // "16 november 2026".
  t = t.replace(new RegExp(`\\b(${MONTHS})\\.? (?:the )?(${ORD})\\b`, "g"), (_m, mo: string, d: string) => `${mo} ${ord(d)}`);
  t = t.replace(new RegExp(`\\b(?:the )?(${ORD}|\\d{1,2}) (?:of )?(${MONTHS})\\b\\.?(?:,? (\\d{4})\\b)?`, "g"), (_m, d: string, mo: string, y?: string) =>
    `${mo} ${/^\d+$/.test(d) ? Number(d) : ord(d)}${y ? `, ${y}` : ""}`,
  );
  t = t.replace(new RegExp(`\\bon the (${byLength(ORDINAL_WORDS.keys())})\\b`, "g"), (_m, d: string) => `on the ${ord(d)}th`);

  // Relative days.
  if (today) {
    t = t.replace(/\b(today|tonight)\b/g, () => written(today));
    t = t.replace(/\btomorrow\b/g, () => written(addDays(today, 1)));
    t = t.replace(/\byesterday\b/g, () => written(addDays(today, -1)));
    t = t.replace(new RegExp(`\\b(this|coming|next|last) (${WEEKDAY_RE})\\b`, "g"), (_m, which: string, day: string) => {
      const target = WEEKDAYS.indexOf(day);
      const now = weekdayOf(today);
      if (which === "last") return written(addDays(today, -(((now - target + 6) % 7) + 1)));
      const ahead = (target - now + 7) % 7;
      // "this" and "coming" may mean today. "next" never does.
      return written(addDays(today, which === "next" && ahead === 0 ? 7 : ahead));
    });
  }
  return { text: t, unreadable: unreadable(t) };
}

// What the shared parser reads, so it can be set aside before the search
// for date-like text it cannot read.
const READ = [
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4}\\b)?`, "g"),
  /\b\d{1,2}\/\d{1,2}(?:\/(?:\d{4}|\d{2}))?\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  new RegExp(`\\b(?:${WEEKDAY_RE}|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)\\b\\.?`, "g"),
  /\b\d{1,2}(?::[0-5]\d)?\s*[ap]\.?\s?m\b\.?/g,
  /\b(?:noon|midnight)\b/g,
  /\b\d{1,2}:[0-5]\d\b/g,
];

// A month named alone. "may" is left out, because it is far more often the
// verb.
const LONE_MONTHS = MONTHS.split("|").filter((m) => m !== "may").join("|");

const UNREADABLE = [
  new RegExp(`\\b(?:${LONE_MONTHS})\\b`, "g"),
  /\b(?:the )?\d{1,2}(?:st|nd|rd|th)\b/g,
  new RegExp(`\\b(?:${byLength(ORDINAL_WORDS.keys())})\\b(?= at\\b)`, "g"),
  /\bo'?clock\b/g,
  /\b(?:half|quarter) (?:past|to)\b/g,
  // "am" is left out, because "I am" is far more common.
  /\bpm\b/g,
  /\b(?:at|by|until|around) \d{1,2}\b(?![:/\d])/g,
  /\b(?:today|tonight|tomorrow|yesterday|weekend|fortnight)\b/g,
  /\b(?:next|this|last|coming) (?:week|month|year|weekend|morning|afternoon|evening)\b/g,
  /\b(?:this|tomorrow|that|next) (?:morning|afternoon|evening|night)\b/g,
  /\bin \d+ (?:days?|weeks?|hours?)\b/g,
  /\b(?:days?|weeks?) (?:from now|ago|later)\b/g,
  /\bthe (?:day|night|morning|evening) (?:before|after)\b/g,
  /\b\d{1,2}\.\d{2}\b/g,
  /\b\d{1,2}h\d{2}\b/g,
  /\b\d{3,4}\s?(?:hours|hrs)\b/g,
  /\b\d{1,2}-\d{1,2}(?:-\d{2,4})?\b/g,
  /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g,
];

// Date-like or time-like text the parser does not read, except a day
// written alone ("the 16th"), which the grounding check resolves.
function unreadable(text: string): string[] {
  let rest = text;
  for (const re of READ) rest = rest.replace(re, " ");
  const found: string[] = [];
  for (const re of UNREADABLE) {
    for (const m of rest.matchAll(re)) {
      if (/^(?:the )?\d{1,2}(?:st|nd|rd|th)$/.test(m[0])) continue;
      found.push(m[0]);
    }
  }
  return found;
}

// Days written alone, such as "the 16th", with where they sit.
export function loneDays(text: string): Array<{ match: string; day: number; index: number }> {
  let rest = text;
  for (const re of READ) rest = rest.replace(re, (m) => " ".repeat(m.length));
  return [...rest.matchAll(/\b(?:the )?(\d{1,2})(?:st|nd|rd|th)\b/g)].map((m) => ({ match: m[0], day: Number(m[1]), index: m.index! }));
}
