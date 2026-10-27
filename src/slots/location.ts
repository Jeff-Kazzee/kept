// Location comparison for one slot. Messages describe the same place in
// different words, such as "our Elm Street office" and "Lantern Hill Clinic,
// 400 Elm Street, Suite 2". Two locations agree when the distinctive words of
// one all appear in the other. Generic words such as "office" and "clinic"
// are not distinctive. Locations that do not agree raise a conflict. Code
// never merges or rewrites a location.
import { words } from "../domain/quote.ts";

const GENERIC = new Set(["our", "the", "a", "an", "at", "office", "clinic", "location", "building"]);

export function distinctiveWords(location: string): string[] {
  return words(location).filter((w) => !GENERIC.has(w));
}

export function locationsAgree(a: string, b: string): boolean {
  const wa = distinctiveWords(a);
  const wb = distinctiveWords(b);
  if (wa.length === 0 || wb.length === 0) return true;
  const sa = new Set(wa);
  const sb = new Set(wb);
  return wa.every((w) => sb.has(w)) || wb.every((w) => sa.has(w));
}
