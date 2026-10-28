// Slot projection: accepted evidence becomes slot states by fixed rules.
// This is a pure function over evidence views. It reads only accepted
// evidence, so model output that the user has not accepted never changes a
// slot. docs/decisions/0002-slot-states.md holds the transition table and
// the reasoning for each rule.
//
// Steps:
// 1. Place each claim on a slot. Slot identity is date plus time. A claim
//    with a date and no time joins the one timed slot on that date, or
//    becomes a date-only slot when there is none. Code never guesses: a
//    weekday that fits more than one date, or a date-only claim that fits
//    more than one timed slot, raises a conflict and is left out until the
//    user says which one it means.
// 2. Fold each slot's claims in event-time order through the transition
//    table. When a claim's event time is unknown and its position would
//    change the result, the slot keeps the state from the known claims and
//    a conflict is raised (rules 4 and 5). An automated reminder with an
//    unknown time that disagrees is marked possibly stale and changes
//    nothing (rule 6).
// 3. A confirmed slot is change proposed when, after its confirmation, the
//    office proposed to move it or offered a different slot that is still
//    open. Two or more held slots raise a conflict that asks which one
//    stands (rule 3).
// 4. Locations that do not agree raise a conflict. A held slot without a
//    time or a location is incomplete.
import type { EvidenceClaim, SlotState } from "../domain/claim.ts";
import { weekdayOnlyCandidates } from "../domain/datetime.ts";
import type { IcsEvent } from "../domain/ics.ts";
import type { EvidenceView } from "../intake/events.ts";
import { DEFAULT_TIME_ZONE } from "../domain/zone.ts";
import { findClashes } from "./clash.ts";
import { dateLabel, slotIdPart, slotKey, slotLabel, sourceLabel, stateLabel } from "./labels.ts";
import { distinctiveWords, locationsAgree } from "./location.ts";
import { arrivalTime, certainlyBefore, effectiveTime } from "./time.ts";
import {
  CONFLICT_PRIORITY,
  type Choice,
  type ChoiceEffect,
  type Conflict,
  type ConflictKind,
  type Projection,
  type SlotStatus,
  type SlotView,
} from "./types.ts";

export type ProjectionInput = {
  // Every evidence item in the case. Only accepted items are used.
  evidence: EvidenceView[];
  // Evidence with an unknown event time that an answer has replaced.
  settled?: ReadonlySet<string>;
  // Events of the loaded calendar, or null when none is loaded.
  calendar?: IcsEvent[] | null;
  // The case's time zone, for the calendar clash math (0009, J5). UTC
  // when not given.
  timeZone?: string;
};

const STATUS_OF: Partial<Record<EvidenceClaim["claim_type"], SlotStatus>> = {
  offer: "offered",
  request: "requested",
  confirm: "confirmed",
  reminder: "confirmed",
  cancel: "canceled",
  decline: "declined",
};

// The transition table. Row: the slot's status so far. Column: what the
// next claim in event-time order says. Only a cancel claim moves a
// confirmed slot to canceled, and cancel claims come only from office
// messages and user reports (rule 1). A request, a decline, a reminder or a
// confirmation of another slot never releases a confirmed slot (rules 2
// and 3).
export const TRANSITIONS: Record<SlotStatus | "none", Record<SlotStatus, SlotStatus>> = {
  none: { offered: "offered", requested: "requested", confirmed: "confirmed", canceled: "canceled", declined: "declined" },
  offered: { offered: "offered", requested: "requested", confirmed: "confirmed", canceled: "canceled", declined: "declined" },
  requested: { offered: "requested", requested: "requested", confirmed: "confirmed", canceled: "canceled", declined: "declined" },
  confirmed: { offered: "confirmed", requested: "confirmed", confirmed: "confirmed", canceled: "canceled", declined: "confirmed" },
  canceled: { offered: "offered", requested: "requested", confirmed: "confirmed", canceled: "canceled", declined: "canceled" },
  declined: { offered: "offered", requested: "requested", confirmed: "confirmed", canceled: "canceled", declined: "declined" },
};

const CLAIM_FOR_STATUS: Record<SlotStatus, ChoiceEffect["claim_type"]> = {
  offered: "offer",
  requested: "request",
  confirmed: "confirm",
  canceled: "cancel",
  declined: "decline",
};

const STATUS_WORD: Record<SlotStatus, string> = {
  offered: "offered",
  requested: "requested",
  confirmed: "confirmed",
  canceled: "canceled",
  declined: "declined",
};

const UNSURE: Choice = { id: "unsure", label: "Not sure yet", effects: [], settles: [] };

type Assertion = {
  ev: EvidenceView;
  status: SlotStatus;
  time: number | null;
  automatedReminder: boolean;
};

type Run = { status: SlotStatus; by: Assertion };

function run(seq: Assertion[]): Run | null {
  let result = null as Run | null;
  for (const a of seq) {
    const next: SlotStatus = TRANSITIONS[result?.status ?? "none"][a.status];
    if (result === null || next !== result.status) result = { status: next, by: a };
  }
  return result;
}

const sourceOf = (a: Assertion) => sourceLabel(a.ev.claim.source_type, a.ev.claim.agent_name ?? null);

const byArrival = (a: EvidenceView, b: EvidenceView) => arrivalTime(a) - arrivalTime(b) || a.id.localeCompare(b.id);

type SlotDraft = { key: string; date: string; time: string | null; items: EvidenceView[] };

type Folded = SlotDraft & {
  status: SlotStatus;
  by: EvidenceView;
  // The claims in the slot's sequence that say it is held. Empty when the
  // hold is implied by a move alone.
  holds: EvidenceView[];
  moves: EvidenceView[];
  stale: EvidenceView[];
};

// Claims with an unknown time that code left out, the claim with a known
// time that set the slot's state (null when none did), every status the
// slot's claims could give in some order, and the status the slot has
// without the claims left out ("none" when it has none).
type Unordered = {
  floating: EvidenceView[];
  // Every unknown-time claim of the slot, kept or not. An answer settles
  // all of them, because the user answers with all of them in view.
  unknown: EvidenceView[];
  against: EvidenceView | null;
  statuses: SlotStatus[];
  from: SlotStatus | "none";
};

const label = (s: { date: string; time: string | null }) => slotLabel(s.date, s.time);

function conflictId(kind: ConflictKind, keys: string[]): string {
  return `${kind.replace(/_/g, "-")}-${keys.map(slotIdPart).join("_")}`;
}

function effect(claim_type: ChoiceEffect["claim_type"], slot: { date: string; time: string | null }, extra: Partial<ChoiceEffect> = {}): ChoiceEffect {
  return { claim_type, date: slot.date, time: slot.time, location: null, clarifies: null, ...extra };
}

function makeConflict(c: Omit<Conflict, "askable">): Conflict {
  return { ...c, askable: c.choices.some((ch) => ch.id !== UNSURE.id) };
}

// Every outcome the known sequence can end in once the unknown claims are
// placed at every possible position, in every relative order. An outcome is
// the status and the source label of the claim that set it, so a different
// source in another order also counts as a different result. The search is
// exact. It walks states (known claims used, unknown claims used per kind,
// status, source), and unknown claims of the same status and source are
// interchangeable, so the number of states stays small.
function outcomesOf(base: Assertion[], unknown: Assertion[]): Set<string> {
  const groups = new Map<string, { status: SlotStatus; source: string; count: number }>();
  for (const u of unknown) {
    const key = `${u.status}|${sourceOf(u)}`;
    const g = groups.get(key) ?? { status: u.status, source: sourceOf(u), count: 0 };
    g.count++;
    groups.set(key, g);
  }
  const kinds = [...groups.values()];
  const out = new Set<string>();
  const seen = new Set<string>();
  type State = { i: number; used: number[]; status: SlotStatus | "none"; source: string };
  const stack: State[] = [{ i: 0, used: kinds.map(() => 0), status: "none", source: "" }];
  const step = (st: State, status: SlotStatus, source: string): Pick<State, "status" | "source"> => {
    const next = TRANSITIONS[st.status][status];
    return next === st.status ? { status: st.status, source: st.source } : { status: next, source };
  };
  while (stack.length > 0) {
    const st = stack.pop()!;
    const key = `${st.i}|${st.used.join(",")}|${st.status}|${st.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let done = st.i === base.length;
    if (st.i < base.length) stack.push({ ...st, i: st.i + 1, ...step(st, base[st.i]!.status, sourceOf(base[st.i]!)) });
    kinds.forEach((k, j) => {
      if (st.used[j]! === k.count) return;
      done = false;
      const used = [...st.used];
      used[j]!++;
      stack.push({ ...st, used, ...step(st, k.status, k.source) });
    });
    if (done && st.status !== "none") out.add(`${st.status}|${st.source}`);
  }
  return out;
}

const statusOfOutcome = (o: string) => o.slice(0, o.indexOf("|")) as SlotStatus;

function foldSlot(draft: SlotDraft, settled: ReadonlySet<string>): { folded: Folded | null; unordered: Unordered | null } {
  const moves = draft.items.filter((e) => e.claim.claim_type === "move").sort(byArrival);
  const assertions: Assertion[] = draft.items
    .filter((e) => STATUS_OF[e.claim.claim_type] !== undefined)
    .map((ev) => {
      const time = effectiveTime(ev);
      return {
        ev,
        status: STATUS_OF[ev.claim.claim_type]!,
        time,
        automatedReminder: ev.claim.claim_type === "reminder" && ev.claim.sender_kind === "automated" && time === null,
      };
    })
;

  const known = assertions.filter((a) => a.time !== null).sort((a, b) => a.time! - b.time! || byArrival(a.ev, b.ev));
  const unknown = assertions.filter((a) => a.time === null);
  // Two claims at the same instant that disagree have no order, so the
  // second is handled like a claim with an unknown time.
  const base: Assertion[] = [];
  for (const a of known) {
    const last = base.at(-1);
    if (last && last.time === a.time && last.status !== a.status) unknown.push(a);
    else base.push(a);
  }
  // Claims an answer has replaced are dropped here, after the split, so a
  // claim that was moved to the unknown list for a tie is dropped too.
  const open = unknown.filter((u) => !settled.has(u.ev.id)).sort((a, b) => byArrival(a.ev, b.ev));

  // Rule 6: with a state from claims with known times, an automated
  // reminder with an unknown time never changes it. One that disagrees is
  // possibly stale.
  const knownRun = run(base);
  const stale: EvidenceView[] = [];
  let rest = open;
  if (knownRun) {
    for (const u of open) if (u.automatedReminder && knownRun.status !== "confirmed") stale.push(u.ev);
    rest = open.filter((u) => !u.automatedReminder);
  }

  // Rules 4 and 5: the unknown claims are applied only if no order of them
  // changes the result. Otherwise code keeps only the claims that cannot
  // change the state from the known claims on their own, and leaves the
  // rest out. With no known claim, nothing is kept, so code never picks
  // one unknown claim over another.
  let kept = rest;
  let unordered: Unordered | null = null;
  const all = outcomesOf(base, rest);
  if (all.size > 1) {
    const knownOutcome = knownRun ? `${knownRun.status}|${sourceOf(knownRun.by)}` : null;
    kept = knownRun ? rest.filter((u) => { const o = outcomesOf(base, [u]); return o.size === 1 && o.has(knownOutcome!); }) : [];
    if (outcomesOf(base, kept).size > 1) kept = [];
    const floating = rest.filter((u) => !kept.includes(u));
    // The choices cover every status any order of all the claims can give,
    // including orders that combine a kept claim with one left out.
    const statuses = new Set([...all].map(statusOfOutcome));
    if (knownRun) statuses.add(knownRun.status);
    unordered = {
      floating: floating.map((u) => u.ev),
      unknown: rest.map((u) => u.ev),
      against: knownRun?.by.ev ?? null,
      statuses: [...statuses],
      from: run(sortedWith(base, kept))?.status ?? "none",
    };
  }

  // Kept claims give the same status and source in any position, so they go
  // in arrival order.
  const seq = sortedWith(base, kept);
  const result = run(seq);
  if (result === null) {
    // A move with no other claim still says the office holds the slot.
    if (moves.length === 0 || unordered) return { folded: null, unordered };
    return { folded: { ...draft, status: "confirmed", by: moves[0]!, holds: [], moves, stale }, unordered };
  }
  const holds = result.status === "confirmed" ? seq.filter((a) => a.status === "confirmed").map((a) => a.ev) : [];
  return { folded: { ...draft, status: result.status, by: result.by.ev, holds, moves, stale }, unordered };
}

function sortedWith(base: Assertion[], kept: Assertion[]): Assertion[] {
  const seq = [...base];
  for (const u of kept) {
    const at = seq.findIndex((b) => byArrival(u.ev, b.ev) < 0);
    seq.splice(at === -1 ? seq.length : at, 0, u);
  }
  return seq;
}

// The shortest run of user-reported claims that takes a slot from one
// status to another through the transition table. From confirmed, for
// example, "offered" takes a cancel and then an offer.
export function claimsToReach(from: SlotStatus | "none", to: SlotStatus): SlotStatus[] {
  const queue: Array<{ at: SlotStatus | "none"; path: SlotStatus[] }> = [{ at: from, path: [] }];
  const seen = new Set<string>([from]);
  while (queue.length > 0) {
    const { at, path } = queue.shift()!;
    for (const claim of ["confirmed", "canceled", "offered", "requested", "declined"] as SlotStatus[]) {
      const next = TRANSITIONS[at][claim];
      if (next === to) return [...path, claim];
      if (!seen.has(next)) {
        seen.add(next);
        queue.push({ at: next, path: [...path, claim] });
      }
    }
  }
  throw new Error(`No claims reach ${to} from ${from}.`);
}

export function projectSlots(input: ProjectionInput): Projection {
  const accepted = input.evidence.filter((e) => e.status === "accepted").sort(byArrival);
  const settled = input.settled ?? new Set<string>();
  const conflicts: Conflict[] = [];

  // User answers that say which date, time or place a claim means. The
  // latest answer wins.
  const clarified = new Map<string, { date: string; time: string | null }>();
  const placeAnswers = new Map<string, EvidenceView>();
  for (const e of accepted) {
    if (e.claim.claim_type !== "clarify" || e.claim.slot.date === null) continue;
    if (e.answer?.clarifies) clarified.set(e.answer.clarifies, { date: e.claim.slot.date, time: e.claim.slot.time });
    else if (e.claim.slot.location !== null) placeAnswers.set(slotKey(e.claim.slot.date, e.claim.slot.time), e);
  }

  // Step 1: place claims on slots.
  const timed = new Map<string, SlotDraft>();
  const dateOnly: Array<{ ev: EvidenceView; date: string }> = [];
  for (const e of accepted) {
    const type = e.claim.claim_type;
    if (STATUS_OF[type] === undefined && type !== "move") continue;
    let { date, time } = e.claim.slot;
    const answer = clarified.get(e.id);
    if (answer) ({ date, time } = answer);
    else if (date !== null && e.origin === "model" && e.claim.quote !== null) {
      const candidates = weekdayOnlyCandidates(date, e.claim.quote, e.claim.evidence_time);
      if (candidates !== null && candidates.length > 1) {
        conflicts.push(ambiguousConflict(e, candidates.map((d) => ({ date: d, time }))));
        continue;
      }
    }
    if (date === null) continue;
    if (time === null) dateOnly.push({ ev: e, date });
    else addTo(timed, date, time, e);
  }
  const untimed = new Map<string, SlotDraft>();
  for (const { ev, date } of dateOnly) {
    const onDate = [...timed.values()].filter((s) => s.date === date);
    if (onDate.length === 1) onDate[0]!.items.push(ev);
    else if (onDate.length === 0) addTo(untimed, date, null, ev);
    else conflicts.push(ambiguousConflict(ev, onDate.map((s) => ({ date: s.date, time: s.time }))));
  }

  // Step 2: fold each slot.
  const folded: Folded[] = [];
  for (const draft of [...timed.values(), ...untimed.values()]) {
    const { folded: f, unordered } = foldSlot(draft, settled);
    if (unordered) conflicts.push(unknownOrderConflict(draft, unordered));
    if (f === null) continue;
    folded.push(f);
    if (f.stale.length > 0) conflicts.push(staleConflict(f));
  }

  // Step 3: change proposals and held slots.
  const held = folded.filter((f) => f.status === "confirmed");
  const proposals = new Map<string, { evidence: EvidenceView[]; open: Folded[] }>();
  for (const s of held) {
    // A proposal counts when it certainly came after every claim that holds
    // the slot, and not when it certainly came before one of them. When
    // neither is certain, the change is shown as proposed and a conflict
    // asks, because a later confirmation would withdraw it.
    const candidates: Array<{ ev: EvidenceView; slot: Folded | null }> = s.moves.map((ev) => ({ ev, slot: null }));
    for (const t of folded) {
      if (t === s || (t.status !== "offered" && t.status !== "requested")) continue;
      for (const ev of t.items) {
        if (ev.claim.claim_type === "offer" && ev.claim.source_type === "office_message") candidates.push({ ev, slot: t });
      }
    }
    const definite = candidates.filter((c) => s.holds.every((h) => certainlyBefore(h, c.ev)));
    const unsure = candidates.filter((c) => !definite.includes(c) && !s.holds.some((h) => certainlyBefore(c.ev, h)));
    if (definite.length === 0 && unsure.length > 0) conflicts.push(changeOrderConflict(s, unsure.map((c) => c.ev)));
    const chosen = definite.length > 0 ? definite : unsure;
    if (chosen.length > 0) {
      const open = [...new Set(chosen.flatMap((c) => (c.slot ? [c.slot] : [])))].sort((a, b) => a.key.localeCompare(b.key));
      proposals.set(s.key, { evidence: chosen.map((c) => c.ev).sort(byArrival), open });
    }
  }
  if (held.length >= 2) conflicts.push(bothHeldConflict(held));
  else {
    for (const s of held) {
      const p = proposals.get(s.key);
      if (p) conflicts.push(changeConflict(s, p.evidence, p.open));
    }
  }

  // Step 4: locations, missing details and clashes.
  const slots: SlotView[] = folded
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((f) => {
      const loc = resolveLocation(f, placeAnswers.get(f.key) ?? null);
      const closed = f.status === "canceled" || f.status === "declined";
      if (loc.disputed && !closed) conflicts.push(locationConflict(f, loc.candidates));
      const state: SlotState = f.status === "confirmed" && proposals.has(f.key) ? "change_proposed" : f.status;
      const missing: SlotView["missing"] = [];
      if (f.status === "confirmed") {
        if (f.time === null) missing.push("time");
        if (loc.location === null && !loc.disputed) missing.push("location");
      }
      if (missing.length > 0) conflicts.push(incompleteConflict(f, missing));
      const source = sourceLabel(f.by.claim.source_type, f.by.claim.agent_name ?? null);
      return {
        key: f.key,
        date: f.date,
        time: f.time,
        label: label(f),
        state,
        stateLabel: stateLabel(state, source),
        stateEvidenceId: f.by.id,
        sourceType: f.by.claim.source_type,
        sourceLabel: source,
        location: loc.location,
        locationDisputed: loc.disputed,
        missing,
        evidenceIds: [...f.items].sort(byArrival).map((e) => e.id),
        proposalEvidenceIds: state === "change_proposed" ? proposals.get(f.key)!.evidence.map((e) => e.id) : [],
        staleEvidenceIds: f.stale.map((e) => e.id),
        clashes: input.calendar && f.time !== null && !closed ? findClashes(f.date, f.time, input.calendar, input.timeZone ?? DEFAULT_TIME_ZONE) : null,
      };
    });

  conflicts.sort((a, b) => CONFLICT_PRIORITY.indexOf(a.kind) - CONFLICT_PRIORITY.indexOf(b.kind) || a.id.localeCompare(b.id));
  return { slots, conflicts, staleEvidenceIds: folded.flatMap((f) => f.stale.map((e) => e.id)) };
}

function addTo(map: Map<string, SlotDraft>, date: string, time: string | null, ev: EvidenceView) {
  const key = slotKey(date, time);
  const slot = map.get(key) ?? { key, date, time, items: [] };
  slot.items.push(ev);
  map.set(key, slot);
}

type LocationResult = {
  location: string | null;
  disputed: boolean;
  candidates: Array<{ location: string; ev: EvidenceView }>;
};

// The slot's place. A place the user chose in an answer stands until a
// later claim gives a place that does not agree with it. Among places that
// agree, the most detailed one is shown.
function resolveLocation(f: Folded, answer: EvidenceView | null): LocationResult {
  const stale = new Set(f.stale.map((e) => e.id));
  let candidates = f.items
    .filter((e) => e.claim.slot.location !== null && !stale.has(e.id) && e.origin !== "answer" && e.origin !== "reply")
    .sort(byArrival)
    .map((ev) => ({ location: ev.claim.slot.location!, ev }));
  if (answer) {
    candidates = [{ location: answer.claim.slot.location!, ev: answer }, ...candidates.filter((c) => byArrival(c.ev, answer) > 0)];
  }
  if (candidates.length === 0) return { location: null, disputed: false, candidates };
  const disputed = candidates.some((a) => candidates.some((b) => !locationsAgree(a.location, b.location)));
  if (disputed) return { location: null, disputed, candidates };
  const best = candidates.reduce((a, b) => (distinctiveWords(b.location).length >= distinctiveWords(a.location).length ? b : a));
  return { location: best.location, disputed: false, candidates };
}

// Conflict builders. Every choice comes from code.

function ambiguousConflict(ev: EvidenceView, options: Array<{ date: string; time: string | null }>): Conflict {
  const labels = options.map(label);
  return makeConflict({
    id: `ambiguous-date-${ev.id}`,
    kind: "ambiguous_date",
    slotKeys: options.map((o) => slotKey(o.date, o.time)),
    evidenceIds: [ev.id],
    summary: `One claim fits more than one slot: ${labels.join(" or ")}. It is left out until you say which one it means.`,
    fixedQuestion: `A message could mean ${labels.join(" or ")}. Which one does it mean?`,
    choices: [
      ...options.map((o, i) => ({
        id: `means:${slotKey(o.date, o.time)}`,
        label: `It means ${labels[i]}`,
        effects: [effect("clarify", o, { clarifies: ev.id })],
        settles: [],
      })),
      UNSURE,
    ],
  });
}

function unknownOrderConflict(slot: SlotDraft, u: Unordered): Conflict {
  const floating = u.floating.map((e) => e.id);
  const order: SlotStatus[] = ["offered", "requested", "confirmed", "canceled", "declined"];
  const statuses = order.filter((s) => u.statuses.includes(s));
  return makeConflict({
    id: conflictId("unknown_order", [slot.key]),
    kind: "unknown_order",
    slotKeys: [slot.key],
    evidenceIds: u.against ? [u.against.id, ...floating] : floating,
    summary: u.against
      ? `Sources disagree about ${label(slot)}, and the time of at least one of them is unknown. The slot keeps the state from the source with a known time.`
      : `Sources disagree about ${label(slot)}, and none of them has a known time. Code does not choose between them, so the slot has no state until you answer.`,
    fixedQuestion: `Sources disagree about ${label(slot)}. Which is true now?`,
    choices: [
      ...statuses.map((s) => ({
        id: `status:${s}`,
        label: `${label(slot)} is ${STATUS_WORD[s]}`,
        effects: claimsToReach(u.from, s).map((c) => effect(CLAIM_FOR_STATUS[c], slot)),
        settles: u.unknown.map((e) => e.id),
      })),
      UNSURE,
    ],
  });
}

function changeOrderConflict(s: Folded, unsure: EvidenceView[]): Conflict {
  return makeConflict({
    id: `${conflictId("unknown_order", [s.key])}-change`,
    kind: "unknown_order",
    slotKeys: [s.key],
    evidenceIds: [...new Set([...s.holds.map((e) => e.id), ...unsure.map((e) => e.id)])],
    summary:
      `${label(s)} is held. A proposal to change it may have come before or after a confirmation, because a time is unknown. ` +
      "The change is shown as proposed until you answer.",
    fixedQuestion: `Is a change away from ${label(s)} still proposed?`,
    choices: [
      { id: "change:proposed", label: `A change away from ${label(s)} is still proposed`, effects: [], settles: [] },
      { id: "change:withdrawn", label: `${label(s)} stands with no change proposed`, effects: [effect("confirm", s)], settles: [] },
      UNSURE,
    ],
  });
}

function staleConflict(f: Folded): Conflict {
  return makeConflict({
    id: conflictId("possibly_stale", [f.key]),
    kind: "possibly_stale",
    slotKeys: [f.key],
    evidenceIds: [...f.stale.map((e) => e.id), f.by.id],
    summary: `An automated reminder mentions ${label(f)}, but a source with a known time says it is ${STATUS_WORD[f.status]}. The reminder may be out of date. It does not change the slot.`,
    fixedQuestion: `An automated reminder mentions ${label(f)}, which is ${STATUS_WORD[f.status]}. Is the reminder out of date?`,
    choices: [
      { id: "ignore", label: `The reminder is out of date. ${label(f)} stays ${STATUS_WORD[f.status]}.`, effects: [], settles: [] },
      { id: "still-stands", label: `${label(f)} still stands`, effects: [effect("confirm", f)], settles: [] },
      UNSURE,
    ],
  });
}

function bothHeldConflict(held: Folded[]): Conflict {
  const sorted = [...held].sort((a, b) => a.key.localeCompare(b.key));
  const labels = sorted.map(label);
  return makeConflict({
    id: conflictId("both_held", sorted.map((s) => s.key)),
    kind: "both_held",
    slotKeys: sorted.map((s) => s.key),
    evidenceIds: sorted.map((s) => s.by.id),
    summary: `${labels.join(" and ")} are both held. No evidence says that one of them was moved or canceled.`,
    fixedQuestion: `${labels.join(" and ")} are both held. Which one stands?`,
    choices: [
      ...sorted.map((s) => ({
        id: `stands:${s.key}`,
        label: `${label(s)} stands`,
        effects: sorted.filter((o) => o !== s).map((o) => effect("cancel", o)),
        settles: [],
      })),
      UNSURE,
    ],
  });
}

function changeConflict(s: Folded, evidence: EvidenceView[], open: Folded[]): Conflict {
  const hasMove = evidence.some((e) => e.claim.claim_type === "move");
  const choices: Choice[] = open
    .filter((t) => t.status === "offered")
    .map((t) => ({
      id: `request:${t.key}`,
      label: `Request ${label(t)}`,
      effects: [],
      settles: [],
      draft: { template: "accept_offer" as const, slotKey: t.key },
    }));
  if (!hasMove && open.length > 0) {
    choices.push({ id: "keep", label: `Keep ${label(s)}`, effects: [], settles: [], draft: { template: "keep_original", slotKey: s.key } });
  }
  choices.push(UNSURE);
  const offered = open.map(label);
  return makeConflict({
    id: conflictId("change_proposed", [s.key]),
    kind: "change_proposed",
    slotKeys: [s.key, ...open.map((t) => t.key)],
    evidenceIds: [s.by.id, ...evidence.map((e) => e.id)],
    summary:
      `${label(s)} is confirmed. After that, the office ` +
      (hasMove ? "proposed to move it" : "offered a different time") +
      (offered.length > 0 ? `: ${offered.join(" or ")}.` : ".") +
      " The original still holds.",
    fixedQuestion: hasMove
      ? `The office proposed to move ${label(s)}. Which time do you want instead?`
      : `The office offered ${offered.join(" or ")} while ${label(s)} is confirmed. Do you want to change?`,
    choices,
  });
}

function locationConflict(f: Folded, candidates: LocationResult["candidates"]): Conflict {
  const places = [...new Map(candidates.map((c) => [c.location, c])).values()];
  return makeConflict({
    id: conflictId("location_mismatch", [f.key]),
    kind: "location_mismatch",
    slotKeys: [f.key],
    evidenceIds: [...new Set(candidates.map((c) => c.ev.id))],
    summary: `Sources give different places for ${label(f)}.`,
    fixedQuestion: `Sources give different places for ${label(f)}. Which place is right?`,
    choices: [
      ...places.map((p, i) => ({
        id: `place:${i + 1}`,
        label: `${p.location} is right`,
        effects: [effect("clarify", f, { location: p.location })],
        settles: [],
      })),
      UNSURE,
    ],
  });
}

function incompleteConflict(f: Folded, missing: SlotView["missing"]): Conflict {
  const what = missing.map((m) => (m === "time" ? "time" : "place")).join(" and ");
  const subject = f.time === null ? `The visit on ${dateLabel(f.date)}` : label(f);
  return makeConflict({
    id: conflictId("incomplete_slot", [f.key]),
    kind: "incomplete_slot",
    slotKeys: [f.key],
    evidenceIds: [f.by.id],
    summary: `${subject} is confirmed, but the ${what} ${missing.length > 1 ? "are" : "is"} missing.`,
    fixedQuestion: `${subject} is confirmed without a ${what}. Can you add ${missing.length > 1 ? "them" : "it"} from a message or a report?`,
    choices: [{ id: "later", label: "I will add it from a message or a report", effects: [], settles: [] }, UNSURE],
  });
}
