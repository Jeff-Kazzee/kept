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
import { findClashes } from "./clash.ts";
import { dateLabel, slotIdPart, slotKey, slotLabel, sourceLabel, stateLabel } from "./labels.ts";
import { distinctiveWords, locationsAgree } from "./location.ts";
import { arrivalTime, effectiveTime, isLater } from "./time.ts";
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

type Run = { status: SlotStatus; by: Assertion; latest: Assertion };

function run(seq: Assertion[]): Run | null {
  let result = null as Run | null;
  for (const a of seq) {
    const next: SlotStatus = TRANSITIONS[result?.status ?? "none"][a.status];
    if (result === null || next !== result.status) result = { status: next, by: a, latest: a };
    else if (a.status === next) result.latest = a;
  }
  return result;
}

const byArrival = (a: EvidenceView, b: EvidenceView) => arrivalTime(a) - arrivalTime(b) || a.id.localeCompare(b.id);

type SlotDraft = { key: string; date: string; time: string | null; items: EvidenceView[] };

type Folded = SlotDraft & {
  status: SlotStatus;
  by: EvidenceView;
  latest: EvidenceView | null; // null when the hold is implied by a move
  moves: EvidenceView[];
  stale: EvidenceView[];
  // Evidence left out of the state because its position is unknown.
  floating: EvidenceView[];
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

function foldSlot(draft: SlotDraft, settled: ReadonlySet<string>): Folded | null {
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
    .filter((a) => !(a.time === null && settled.has(a.ev.id)));

  const known = assertions.filter((a) => a.time !== null).sort((a, b) => a.time! - b.time! || byArrival(a.ev, b.ev));
  const unknown = assertions.filter((a) => a.time === null);
  // Two claims at the same instant that disagree have no order, so the
  // second is handled like a claim with an unknown time.
  let base: Assertion[] = [];
  for (const a of known) {
    const last = base.at(-1);
    if (last && last.time === a.time && last.status !== a.status) unknown.push(a);
    else base.push(a);
  }
  unknown.sort((a, b) => byArrival(a.ev, b.ev));

  const stale: EvidenceView[] = [];
  const floating: EvidenceView[] = [];
  for (const u of unknown) {
    const current = run(base);
    if (current === null) {
      base = [u];
      continue;
    }
    if (u.automatedReminder) {
      if (current.status !== "confirmed") stale.push(u.ev);
      continue;
    }
    const outcomes = new Set<SlotStatus>();
    for (let i = 0; i <= base.length; i++) outcomes.add(run([...base.slice(0, i), u, ...base.slice(i)])!.status);
    if (outcomes.size === 1) {
      const at = base.findIndex((b) => byArrival(u.ev, b.ev) < 0);
      base = at === -1 ? [...base, u] : [...base.slice(0, at), u, ...base.slice(at)];
    } else {
      floating.push(u.ev);
    }
  }

  const result = run(base);
  if (result === null) {
    // A move with no other claim still says the office holds the slot.
    if (moves.length === 0) return null;
    return { ...draft, status: "confirmed", by: moves[0]!, latest: null, moves, stale, floating };
  }
  return { ...draft, status: result.status, by: result.by.ev, latest: result.latest.ev, moves, stale, floating };
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
    const f = foldSlot(draft, settled);
    if (f === null) continue;
    folded.push(f);
    for (const ev of f.floating) conflicts.push(unknownOrderConflict(f, ev));
    if (f.stale.length > 0) conflicts.push(staleConflict(f));
  }

  // Step 3: change proposals and held slots.
  const held = folded.filter((f) => f.status === "confirmed");
  const proposals = new Map<string, { evidence: EvidenceView[]; open: Folded[] }>();
  for (const s of held) {
    const ref = s.latest;
    const moves = s.moves.filter((m) => ref === null || isLater(m, ref));
    const offers: EvidenceView[] = [];
    const open = new Set<Folded>();
    for (const t of folded) {
      if (t === s || (t.status !== "offered" && t.status !== "requested")) continue;
      for (const e of t.items) {
        if (e.claim.claim_type !== "offer" || e.claim.source_type !== "office_message") continue;
        if (ref !== null && !isLater(e, ref)) continue;
        offers.push(e);
        open.add(t);
      }
    }
    if (moves.length + offers.length > 0) {
      proposals.set(s.key, { evidence: [...moves, ...offers].sort(byArrival), open: [...open].sort((a, b) => a.key.localeCompare(b.key)) });
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
        clashes: input.calendar && f.time !== null && !closed ? findClashes(f.date, f.time, input.calendar) : null,
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
    .filter((e) => e.claim.slot.location !== null && !stale.has(e.id) && e.origin !== "answer")
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

function unknownOrderConflict(f: Folded, ev: EvidenceView): Conflict {
  const theirs = STATUS_OF[ev.claim.claim_type]!;
  const statuses = [...new Set<SlotStatus>([f.status, theirs])];
  return makeConflict({
    id: `${conflictId("unknown_order", [f.key])}-${ev.id}`,
    kind: "unknown_order",
    slotKeys: [f.key],
    evidenceIds: [f.by.id, ev.id],
    summary: `Two sources disagree about ${label(f)}, and the time of one of them is unknown. The slot keeps the state from the source with a known time.`,
    fixedQuestion: `Two messages disagree about ${label(f)}. Which is true now?`,
    choices: [
      ...statuses.map((s) => ({
        id: `status:${s}`,
        label: `${label(f)} is ${STATUS_WORD[s]}`,
        effects: [effect(CLAIM_FOR_STATUS[s], f)],
        settles: [ev.id],
      })),
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
    .map((t) => ({ id: `request:${t.key}`, label: `Request ${label(t)}`, effects: [effect("request", t)], settles: [] }));
  if (!hasMove && open.length > 0) {
    choices.push({ id: "keep", label: `Keep ${label(s)}`, effects: open.map((t) => effect("decline", t)), settles: [] });
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
