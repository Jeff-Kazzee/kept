# 0002: Slot states and conflict resolution

Status: proposed, pending Jeff, 2026-10-27. W19, W20 and D-f were accepted
by Jeff on 2026-10-27.

This records how accepted evidence becomes slot states, how conflicts are
raised and asked about, and how model output is checked. Items marked D-a to
D-h were set for sprint 2 and wait for Jeff's review unless marked accepted. Items marked W were
chosen while building sprint 2 where the rules left a case open. Each W item
is the narrowest choice found that keeps rules 1 to 7 true.

Code: `src/slots/` (projection, labels, clashes), `src/conflicts/` (model
calls and checks), `src/case/` (calendar, question queue, answers).

## Slots

- D-g. Slot identity is date plus time. Location is a detail of the slot.
- W1. A claim with a date and no time joins the one timed slot on that date.
  With no timed slot on that date it becomes a date-only slot. With two or
  more timed slots on that date it raises an `ambiguous_date` conflict and is
  left out until the user says which slot it means. Example: m4 cancels
  "Thursday, November 12" with no time, and joins Thursday 11/12 10:30 AM.
- W2. A claim with no date is not placed on any slot. Office requests are not
  slot claims.
- D-f (accepted by Jeff 2026-10-27). A date that comes only from a weekday in the quote ("Monday") is
  checked against the 14-day window. Every weekday matches at least two dates
  in that window, so such a claim always raises an `ambiguous_date` conflict
  and is left out until the user picks a date. Only model-extracted claims are
  checked. A manual entry has a date the user typed.

## What each claim says about its slot

| Claim | Says the slot is |
|---|---|
| offer | offered |
| request (answer only) | requested |
| confirm | confirmed |
| reminder | confirmed (held) |
| cancel | canceled |
| decline (answer only) | declined |
| move | no status. It proposes a change (see below). |
| clarify (answer only) | no status. It says which date, time or place another claim means. |
| office_request | nothing about the slot |

## Event times (rules 4 and 5)

The PRD orders evidence by event time. Most messages do not state an event
time, so code derives one:

- W3. A stated event time with a clock time is used as is. A stated date
  without a clock time counts as unknown, because it cannot order events on
  the same day.
- W4. A message a person at the office sent, and a user report, describe the
  state when they were sent. Their event time is the evidence time.
- W5. An automated sender may send stale content, so its event time is
  unknown. An office message whose sender kind is unknown also has an unknown
  event time. The user reviews the sender kind when accepting the claim.
- W6. An answer is ordered just after the latest evidence in the case when
  the user answered, or at the answer's own time if that is later. The user
  answered with that evidence in view. This also keeps answers in order when
  the fixture messages carry dates later than the real clock.

## Transition table

Claims on one slot are applied in event-time order. Row: the status so far.
Column: what the next claim says.

| Status so far | offered | requested | confirmed | canceled | declined |
|---|---|---|---|---|---|
| (none) | offered | requested | confirmed | canceled | declined |
| offered | offered | requested | confirmed | canceled | declined |
| requested | requested | requested | confirmed | canceled | declined |
| confirmed | confirmed | confirmed | confirmed | canceled | confirmed |
| canceled | offered | requested | confirmed | canceled | canceled |
| declined | offered | requested | confirmed | canceled | declined |

- Rule 1 holds because the only way from confirmed to canceled is a cancel
  claim, and cancel claims come only from office messages and user reports.
  A test checks every other claim type against a confirmed slot.
- W7. A request or a re-offer does not lower a confirmed slot. A re-offer of
  a requested slot keeps it requested.
- W8. The source shown beside a state is the source of the claim that set the
  state. A later claim that repeats the same state does not change the label.

## Unknown order (rule 5)

- W9. Claims with a known event time are applied first. The claims with an
  unknown time are then judged together: code finds every outcome reachable
  by placing them at any position in that sequence, in any order. An
  outcome is the status and the source of the claim that set it. The search
  is exact. It walks states of (known claims used, unknown claims used per
  kind, status, source), so many claims on one slot stay fast. If every
  placement gives the same outcome, the claims are applied. If not, code
  keeps only the unknown claims that cannot change the outcome from the
  known claims on their own, leaves the rest out, and raises one
  `unknown_order` conflict for the slot that shows the known source and
  every claim left out. With no known claim, code keeps none of them, so it
  never picks one unknown claim over another. The slot then has no state
  until the user answers. Two disagreeing claims at the same instant are
  treated as claims with an unknown time.
- W10. The `unknown_order` choices cover every status any order of the
  claims can give, including orders that combine a kept claim with one left
  out. An answer records the shortest run of user-reported claims that
  reaches the chosen status through the transition table, in order (from
  confirmed, "offered" is a cancel and then an offer). It settles every
  unknown-time claim on the slot, kept or left out, so none of them raises
  the conflict again. A settled claim is dropped whatever its event time,
  which covers a claim left out for a same-instant tie.

## Possibly stale reminders (rule 6)

- W11. An automated reminder with an unknown event time that disagrees with
  the status from claims with known times is marked possibly stale. It
  changes nothing. A `possibly_stale` conflict asks once. The choices are
  "the reminder is out of date", "the slot still stands" (recorded as a user
  report that confirms the slot) and "Not sure yet".
- W12. A reminder that agrees with the slot raises nothing. A reminder with
  nothing to disagree with holds the slot as confirmed. A reminder a person
  sent has a known time and follows rule 4.

## Change proposed

- W13. A confirmed slot is change proposed when the office proposed to move
  it, or offered a different slot that is still offered or requested, and
  that proposal certainly came after every claim that holds the slot. The
  original still holds. The label is "Confirmed · office message, change
  proposed". A proposal that certainly came before a hold does not count.
- W33. Order is certain when both times are known, or when the earlier
  claim's message arrived before the later claim's known time, since an
  event happens no later than its message arrives. When the order of a
  proposal and a hold is not certain, the change is shown as proposed and an
  `unknown_order` conflict asks whether it is still proposed. "Still
  proposed" changes nothing. "Stands with no change proposed" records a
  user-reported confirmation, which comes after every proposal and so
  withdraws them.
- W14. An offer made before the confirmation proposes nothing. In S1,
  Tuesday stays offered and Thursday is confirmed.
- W15. A move with no other claim on the slot still shows it as held with a
  change proposed. The office called it "your visit".
- W16. A later confirmation of the same slot withdraws an earlier move.
- W17. The `change_proposed` question offers "Request <slot>" for each
  alternative that is still offered. When the office only offered another
  time (no move), it also offers "Keep <original>", which declines the
  alternatives. When the office asked to move the slot, keeping is not
  offered. Choosing a replacement records a request on it and leaves the
  original unchanged (rule 2). Other alternatives stay offered.

## Held slots (rule 3)

- W18. A case is one appointment. When two or more slots are held
  (confirmed, including change proposed), a `both_held` conflict asks which
  one stands. Choosing one records a user-reported cancel of each other held
  slot. While `both_held` is open, no `change_proposed` question is asked,
  because "which one stands" answers it.
- A confirmation of the replacement releases the original only through a
  cancel claim. A move is a proposal, not a cancel. In S4 both slots stay
  held.

## Places

- W19 (accepted by Jeff 2026-10-27). Messages describe one place in different words. Two places agree when
  the distinctive words of one all appear in the other. Generic words
  ("our", "the", "office", "clinic", "location", "building") are not
  distinctive. So "Elm Street office" (m1) agrees with "Lantern Hill Clinic,
  400 Elm Street, Suite 2" (m2). A plain string comparison would raise a
  place conflict in the demo story. Among places that agree, the one with
  the most distinctive words is shown.
- D-g. Places that do not agree raise a `location_mismatch` conflict, except
  on a canceled or declined slot. The answer records the chosen place as a
  user report. It stands until a later claim gives a place that does not
  agree with it.

## Incomplete slots (S7)

- W20 (accepted by Jeff 2026-10-27). A held slot without a time or without a place is incomplete. Offered
  and requested slots are not checked, because offers often omit the place.
  In S5, Monday is confirmed by the user's report with no place, so the app
  asks for it.
- W21. Free-text answers are out of scope (D-a), so the `incomplete_slot`
  question has the choices "I will add it from a message or a report" and
  "Not sure yet". Neither changes a slot. The user adds the detail by pasting
  the office's message or reporting it.

## Calendar clashes

- D-e. An appointment slot is assumed to last 60 minutes
  (`ASSUMED_SLOT_MINUTES`). The UI shows this assumption. Times are
  America/Denver. A slot clashes with an event when the intervals intersect.
  Touching intervals do not clash.
- W22. Clashes are checked for offered, requested and held slots, not for
  canceled or declined ones. A slot without a time is not checked.
- W23. Calendar times with a TZID or no zone are wall-clock times in that
  zone (an unknown zone name is read as America/Denver). UTC times are
  converted. An all-day event without an end lasts until local midnight of
  the next date, so it covers 23 or 25 hours on a daylight change day. A timed event
  without an end has no length, as in RFC 5545. Recurring events count only
  their first instance, because the reader does not expand RRULE.
- W24. The calendar is loaded into the case as an event, so the server can
  check clashes and a reopened case keeps it.

## Questions and answers

- D-a. Answers are structured choices that code builds from the open
  conflict. The user's tap is the review. It is recorded as
  `reported_by_user` evidence through the event log with an expected
  version. No model output is in that path. Free-text answers are out of
  scope for this sprint.
- W25. One question is open at a time. The question queue is one stream, and
  every write states its expected version. A question whose conflict has
  changed or gone is withdrawn before the next one is asked.
- W26. A conflict is identified by its kind and slots, and its evidence set.
  Once a question about it is answered, it is not asked again until its
  evidence changes. "Not sure yet" counts as an answer. So a possibly stale
  reminder is asked about once.
- W27. A conflict where no choice would change anything (a move with no open
  alternative) is shown but not asked.
- W30. The PRD defines requested as "the user approved a request for the
  slot and sent it". Sending arrives with reply templates in sprint 3. In
  this sprint the request is recorded when the user taps "Request <slot>",
  as the S3 fixture stub states. Sprint 3 may move this step to the approval
  of the reply.

## Model calls

- D-d. An explanation must cite at least one evidence ID. Every cited ID must
  belong to the conflict it explains, not only exist in the case. The text
  must contain no date or time that is absent from the cited evidence. It is
  stored as an event linked to the conflict.
- D-b. An explanation still invalid after one retry is not shown. The
  conflict shows its evidence and quotes, and a label says the explanation is
  unavailable.
- D-c. A proposed question must name an open conflict that has not been
  asked, cite evidence of that conflict, and contain no date or time that is
  absent from the cited evidence. Still invalid after one retry, code uses a
  fixed wording for the conflict kind. The answer choices always come from
  code.
- W28. Both checks also reject text with clinical words, text over a length
  limit, and (for questions) text that does not end with a question mark.
  The clinical list (`src/domain/scope.ts`) covers singular and plural forms
  and errs toward rejecting, because a false match costs a retry or the
  fixed wording. Words that are also ordinary administrative words
  ("result", "lab", the verb "treat") appear only in clinical phrases such as
  "lab result", "test results" and "your results". A test checks that every fixture message, recorded model output and
  code-built question passes.
- W32. Each date mention in model text is checked as one unit. Its year,
  month and day, weekday and times must all fit one point in time that one
  cited item states: its slot, its event time, its evidence time, or one
  mention in its quote. A quote without a year means the arrival year, or
  the next year when that month and day had already passed, as in
  extraction. Each candidate year is its own point, so a year and a weekday
  are never taken from two different dates.
- W31. The date check covers what the date parser reads: month names with a
  day, M/D, ISO dates, weekdays and clock times. Relative words such as
  "tomorrow" or "the 12th" are not read, so they are not checked.
- D-h. The new calls use reasoning effort `low` by default, set by an
  option. Extraction defaults to effort `minimal` since Jeff's decision of
  2026-10-27. Effort `low` stays available by option.
- W29. The model receives the conflict summary written by code, and for
  each evidence item its ID, claim type, source, sender kind, times, slot
  values and quote. For an answer item the quote is the label the user
  tapped. No full message text is sent.
