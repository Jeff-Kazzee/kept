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
  // SP12.5: symptoms named without a word above.
  "(?:head|stomach|tooth|back|ear)aches?",
  "aches?",
  "fevers?",
  "nause\\w*",
  "migraines?",
  "dizz\\w*",
  "blood pressure",
  // SP12.5: the commonest of these words in Spanish, French, German,
  // Italian and Portuguese, read without accents.
  "medicament\\w*",
  "medikament\\w*",
  "farmac\\w*",
  "sintom\\w*",
  "symptome\\w*",
  "tratamient\\w*",
  "traitements?",
  "behandlung\\w*",
  "dolor(?:es)?",
  "douleurs?",
  "schmerz\\w*",
  "enfermedad(?:es)?",
  "maladies?",
  "krankheit\\w*",
  "malattia",
  "doenca",
  "embaraz\\w*",
  "schwanger\\w*",
  "analisis de sangre",
  // Results words only with clinical context, as "lab results" and "your
  // results" in English (review round 1, finding 5).
  "(?:mis|tus|sus) resultados",
  "resultados? (?:de|del) (?:laboratorio|analisis|la prueba|las pruebas|examen(?:es)?|sangre)",
  "(?:mes|tes|vos) resultats",
  "resultats? (?:d['’]analyses?|d[eu] laboratoire|du test|des tests|sanguins?|d['’]examens?)",
  "(?:labor|test|blut|befund|untersuchungs)ergebniss?e?",
  "(?:meine|ihre|deine) ergebniss?e?",
  // Muse round 2, item 7.
  "blutuntersuchung\\w*",
  "befund\\w*",
];

const CLINICAL = new RegExp(`\\b(?:${TERMS.join("|")})\\b`, "i");

// Preparation and diet instructions (sprint 7A review, findings 7 and 9).
// Each is a phrase, so "arrive 15 minutes early", "bring your insurance
// card" and a calendar entry such as "Lunch with Sam" pass. A sentence about
// the building or its rules ("No water damage in Suite 2", "No food or
// drink in the waiting room") passes too, unless it also gives preparation
// timing such as "after midnight" or "before your visit".
const DIET_TERMS = [
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
const DIET = new RegExp(`\\b(?:${DIET_TERMS.join("|")})\\b`, "i");
const FACILITY =
  /\b(?:damage|damaged|leak(?:s|ing|ed)?|flood(?:s|ing|ed)?|service|outage|lobby|waiting (?:room|area)|building|parking|garage|fountain|cooler|vending|cafeteria|hallway|elevator|allowed in|permitted in|in the (?:office|clinic|lobby|hallway|exam rooms?))\b/i;
const PREP_TIMING =
  /\b(?:before (?:your|the) (?:visit|appointment|procedure|exam|test)|after midnight|midnight|the night before|the morning of|prior to|hours? before|fast(?:ing)?)\b/i;

function dietAdvice(text: string): boolean {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => DIET.test(sentence) && !(FACILITY.test(sentence) && !PREP_TIMING.test(sentence)));
}

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

// SP12.5: words written apart to get past the list. A run of three or more
// single letters with one space, dot, hyphen, underscore, star or middle
// dot between each ("l a b", "m.e.d.s") is read as one word, and those
// marks inside a word ("medi-cation", "do.se") are read as nothing.
const SPACED = /(?<!\p{L})\p{L}(?:[ .\-_*·]\p{L}){2,}(?!\p{L})/gu;
const INSIDE = /(?<=\p{L})[.\-_*·]+(?=\p{L})/gu;

export function despaced(text: string): string {
  return text
    .replace(SPACED, (run) => run.replace(/[ .\-_*·]/g, ""))
    .replace(INSIDE, "")
    .replace(/\s+/g, " ");
}

// Review round 1, finding 4: a clinical word written in chunks of two or
// more letters ("symp toms", "medi cation", "can cer"). Neighbouring
// chunks are joined and read against whole clinical words. Whole words,
// not stems, so "the rapper" and "can certainly" stay ordinary words. A
// chunk of one letter is left to the run of single letters above, so
// "Joe's can" stays as it is.
const WHOLE_WORDS = new Set(
  (
    "symptom symptoms medication medications medicine medicines medical treatment treatments therapy therapies therapist therapists " +
    "diagnosis diagnoses diagnose diagnosed prognosis prescription prescriptions prescribe prescribed pharmacy pharmacist drug drugs " +
    "pill pills dose doses dosage dosages blood biopsy biopsies cancer cancers cancerous tumor tumors tumour tumours chemo chemotherapy " +
    "radiation scan scans xray xrays mri ultrasound ultrasounds screening screenings surgery surgeries surgeon surgical illness " +
    "illnesses sickness disease diseases disorder disorders condition conditions infection infections allergy allergies allergic " +
    "pregnant pregnancy vaccine vaccines vaccination injection injections pain painful painkiller painkillers headache headaches " +
    "fever fevers nausea migraine migraines dizzy dizziness fasting diet medicamento medicamentos medicament medicaments medikament " +
    "medikamente sintoma sintomas symptome symptomes tratamiento tratamientos traitement traitements behandlung dolor dolores douleur " +
    "douleurs schmerz schmerzen enfermedad maladie krankheit embarazo embarazada schwanger"
  ).split(" "),
);
// Muse round 2, items 5 and 6: chunks keep joining while the joined text
// starts a whole clinical word ("me di ca tion"), and a comma may sit
// between them ("symp, toms"). A sentence end may not, and chunks that are
// all ordinary standalone words are never joined, so "the rapist" stays
// two words while "the rapy" is read as "therapy".
const CHUNK_GAP = /^[ \-_*·,]+$/;
const MAX_CHUNKS = 6;
const PREFIXES = new Set([...WHOLE_WORDS].flatMap((w) => Array.from({ length: w.length - 1 }, (_, i) => w.slice(0, i + 2))));
const COMMON_WORDS = new Set(
  (
    "a an the and or but to in on at of for by as is it be do so no my me we us he she his her our you your they them this that " +
    "can will may not all any one two new old see did has had have was are its into from with than then there here what when who " +
    "rapist rapists rapper certain certainly"
  ).split(" "),
);

export function joinsClinicalWord(text: string): boolean {
  const words = [...text.toLowerCase().matchAll(/\p{L}+/gu)].map((m) => ({ w: m[0], start: m.index!, end: m.index! + m[0].length }));
  for (let i = 0; i < words.length; i++) {
    let joined = words[i]!.w;
    if (joined.length < 2 || !PREFIXES.has(joined)) continue;
    let allCommon = COMMON_WORDS.has(joined);
    for (let j = i + 1; j < Math.min(words.length, i + MAX_CHUNKS); j++) {
      const next = words[j]!;
      if (next.w.length < 2 || !CHUNK_GAP.test(text.slice(words[j - 1]!.end, next.start))) break;
      joined += next.w;
      allCommon &&= COMMON_WORDS.has(next.w);
      if (WHOLE_WORDS.has(joined) && !allCommon) return true;
      if (!PREFIXES.has(joined)) break;
    }
  }
  return false;
}

export function hasClinicalContent(text: string): boolean {
  const normalized = normalizeForScope(text);
  if (mixesScripts(normalized)) return true;
  // Accents are matched as their base letters too, so "sýmptoms" matches.
  const unaccented = normalized.normalize("NFKD").replace(/\p{M}/gu, "");
  const joined = despaced(unaccented);
  return (
    CLINICAL.test(normalized) ||
    CLINICAL.test(unaccented) ||
    CLINICAL.test(joined) ||
    dietAdvice(normalized) ||
    dietAdvice(unaccented) ||
    dietAdvice(joined) ||
    joinsClinicalWord(unaccented)
  );
}

// S11: the fixed decline for text the user types that asks for clinical
// content. The app states its administrative scope and makes no model call.
export const SCOPE_DECLINE =
  "This app only handles appointment times, places, confirmations and office requests. " +
  "It cannot answer health questions. Please ask the office directly.";

// O-e: notes and tags from the user or an agent get the same check.
// Nothing is written when it fails.
export const RECORD_SCOPE_DECLINE =
  "Notes and tags hold administrative content only: times, places, confirmations and office requests. " +
  "This text reads as clinical content, so nothing was written.";

export class OutOfScopeError extends Error {
  override name = "OutOfScopeError";
  constructor(message: string = SCOPE_DECLINE) {
    super(message);
  }
}
