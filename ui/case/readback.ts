// The reply card's readback: the fields the person ticked, shared by both
// reply cards, kept apart from the card so the shell loads it on its own
// (0019, P18).
import type { DraftView } from "../../src/reply/types.ts";

// The fields the user ticked and the reply-stream version they were ticked
// at. Approval states that version, so the server refuses a readback made
// before a later edit.
export type Readback = { at: number; names: ReadonlySet<string> };

// True when every field was ticked at the current version. A saved edit or
// any other change to the draft moves the version, so old ticks no longer
// count.
export function readbackDone(read: Readback, draft: DraftView, version: number): boolean {
  return read.at === version && draft.fields.every((f) => read.names.has(f.name));
}

// 0016, H5: the draft shows in the chat and in the schedule panel. Both
// cards read one readback, so a tick in one shows in the other. It belongs
// to the draft as shown: a new draft, a saved edit, any new version or
// changed fields start it empty again. Not saved, as before.
export type SharedReadback = { key: string; read: Readback; confirmClaim: boolean };
let sharedReadback: SharedReadback | null = null;
const readbackListeners = new Set<() => void>();
export const subscribeReadback = (f: () => void) => {
  readbackListeners.add(f);
  return () => void readbackListeners.delete(f);
};
export const readbackSnapshot = () => sharedReadback;

export function setSharedReadback(key: string, change: (prev: SharedReadback) => Omit<SharedReadback, "key">): void {
  const prev = sharedReadback?.key === key ? sharedReadback : null;
  const at = prev?.read.at ?? Number(key.split("|")[1]);
  sharedReadback = { key, ...change(prev ?? { key, read: { at, names: new Set() }, confirmClaim: false }) };
  for (const f of readbackListeners) f();
}

// The case generation is part of it, so after Delete case a new draft with
// the same id, version and text starts with no ticks (fix round 1, R5).
// Fix round 2, N6: the readback belongs to one session. When the page's
// session or account changes, including a sign-out, it is cleared, so ticks
// never reach another account's draft in the same tab.
let readbackOwner: string | null = null;
export function scopeReadback(owner: string): void {
  if (owner === readbackOwner) return;
  readbackOwner = owner;
  if (sharedReadback === null) return;
  sharedReadback = null;
  for (const f of readbackListeners) f();
}

export const readbackKey = (draft: DraftView, version: number, generation = 0) =>
  [draft.id, version, generation, draft.text, JSON.stringify(draft.fields.map((f) => [f.name, f.value]))].join("|");
