// Administrative scope check. The app handles times, places, confirmations
// and office requests only. Model text that uses a clinical word is
// rejected. The list errs toward rejecting: a false match costs one retry
// or the fixed wording, while a missed clinical word reaches the user.
// Each term matches its singular and plural forms. Runs in the browser and
// in Node.

const TERMS = [
  "diagnos\\w*",
  "prognos\\w*",
  "symptoms?",
  "treat(?:s|ed|ing|ments?)?",
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
  "labs?",
  "results?",
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
