// Administrative scope check. The app handles times, places, confirmations
// and office requests only. Model text that uses a clinical word is
// rejected. The list errs toward rejecting: a false match costs one retry
// or the fixed wording, while a missed clinical word reaches the user.
// Each term matches its singular and plural forms. Words that are also
// ordinary administrative words ("result", "lab", the verb "treat") are
// listed only inside clinical phrases. Text is normalized first, and a word
// that mixes Latin with another script fails closed. Runs in the browser
// and in Node.

const TERMS = [
  "diagnos\\w*",
  "prognos\\w*",
  "symptoms?",
  "treatments?",
  "therap\\w*",
  "medicat\\w*",
  "medicines?",
  "medical",
  "prescri\\w*",
  "pharmac\\w*",
  "drugs?",
  "pills?",
  "doses?",
  "dosages?",
  "lab (?:results?|work|tests?|reports?|values?)",
  "test results?",
  "results? of your",
  "your (?:lab |test )?results?",
  "blood",
  "biops(?:y|ies)",
  "cancers?",
  "cancerous",
  "tumou?rs?",
  "chemo\\w*",
  "radiation",
  "scans?",
  "x-?rays?",
  "mri",
  "ultrasounds?",
  "screenings?",
  "surg\\w*",
  "illness(?:es)?",
  "sick(?:ness)?",
  "diseases?",
  "disorders?",
  "conditions?",
  "infections?",
  "allerg\\w*",
  "pregnan\\w*",
  "vaccin\\w*",
  "injections?",
  "pain(?:s|ful)?",
  "mental health",
  // Preparation and diet instructions (sprint 7A review, finding 7). Each
  // is a phrase, so "arrive 15 minutes early", "bring your insurance card"
  // and a calendar entry such as "Lunch with Sam" still pass.
  "fasting",
  "fast (?:after|before|from|for|overnight|until|beginning)",
  "(?:what|can|should|may|must|do) (?:i|we|you) (?:eat|drink)",
  "(?:eat|eating|drink|drinking) (?:or|and) (?:skip|avoid|drink|eat|not)",
  "(?:skip|avoid|stop|no|only|limit) (?:eating|drinking|food|foods|meals?|breakfast|liquids?|caffeine|alcohol|coffee|water)",
  "(?:nothing|not) to (?:eat|drink)",
  "(?:don't|do not|cannot|can't|must not|should not|shouldn't) (?:eat|drink)",
  "drink only",
  "only (?:drink|water|clear)",
  "clear (?:liquids?|fluids?)",
  "empty stomach",
  "diet(?:ary|s)?",
  "nil by mouth",
  "npo",
  "(?:eat|drink|food|meals?) (?:the night before|the morning of|after midnight|before (?:the|your) (?:visit|appointment))",
  "prep(?:aration)? instructions?",
  "bowel prep\\w*",
];

const CLINICAL = new RegExp(`\\b(?:${TERMS.join("|")})\\b`, "i");

// Letters of a script other than Latin. Digits, marks and punctuation are
// not letters, so they never count.
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const WORD = /[\p{L}\p{M}]+/gu;

// Text as the check reads it: compatibility forms folded (fullwidth letters
// become ASCII), format characters such as zero-width spaces and soft
// hyphens removed.
export function normalizeForScope(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

// True when one word mixes Latin letters with letters of another script,
// as in "symptoms" written with a Cyrillic у. Such a word is treated as out
// of scope, because the list cannot match it.
export function mixesScripts(text: string): boolean {
  return (text.match(WORD) ?? []).some((w) => LATIN_LETTER.test(w) && NON_LATIN_LETTER.test(w));
}

export function hasClinicalContent(text: string): boolean {
  const normalized = normalizeForScope(text);
  if (mixesScripts(normalized)) return true;
  // Accents are matched as their base letters too, so "sýmptoms" matches.
  const unaccented = normalized.normalize("NFKD").replace(/\p{M}/gu, "");
  return CLINICAL.test(normalized) || CLINICAL.test(unaccented);
}

// S11: the fixed decline for text the user types that asks for clinical
// content. The app states its administrative scope and makes no model call.
export const SCOPE_DECLINE =
  "This app only handles appointment times, places, confirmations and office requests. " +
  "It cannot answer health questions. Please ask the office directly.";

// O-e: notes, tags and proposal text from the user or an agent get the
// same check. Nothing is written when it fails.
export const RECORD_SCOPE_DECLINE =
  "Notes, tags and proposed changes hold administrative content only: times, places, confirmations and office requests. " +
  "This text reads as clinical content, so nothing was written.";

export class OutOfScopeError extends Error {
  override name = "OutOfScopeError";
  constructor(message: string = SCOPE_DECLINE) {
    super(message);
  }
}
