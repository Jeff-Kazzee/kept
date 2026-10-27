// Administrative scope check. The app handles times, places, confirmations
// and office requests only. Model text that uses a clinical word is
// rejected. The list errs toward rejecting: a false match costs one retry
// or the fixed wording, while a missed clinical word reaches the user.
// Each term matches its singular and plural forms. Words that are also
// ordinary administrative words ("result", "lab", the verb "treat") are
// listed only inside clinical phrases. Runs in the browser and in Node.

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
];

const CLINICAL = new RegExp(`\\b(?:${TERMS.join("|")})\\b`, "i");

export function hasClinicalContent(text: string): boolean {
  return CLINICAL.test(text);
}

// S11: the fixed decline for text the user types that asks for clinical
// content. The app states its administrative scope and makes no model call.
export const SCOPE_DECLINE =
  "This app only handles appointment times, places, confirmations and office requests. " +
  "It cannot answer health questions. Please ask the office directly.";

export class OutOfScopeError extends Error {
  override name = "OutOfScopeError";
  constructor() {
    super(SCOPE_DECLINE);
  }
}
