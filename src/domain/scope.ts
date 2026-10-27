// Administrative scope check. The app handles times, places, confirmations
// and office requests only. Model text that uses clinical words is rejected.
// Runs in the browser and in Node.

const CLINICAL = /\b(diagnos\w*|symptom\w*|treatment\w*|medication\w*|medicine\w*|prescri\w*|dose|dosage|lab results|test results|condition\w*|therap\w*|surgery|illness\w*|disease\w*)\b/i;

export function hasClinicalContent(text: string): boolean {
  return CLINICAL.test(text);
}
