# 0022: The calendar-add answer fell back

Status: sprint 20, from the coordinator's handoff of 2026-10-31. Choices
marked (proposed) are the writer's and wait for Jeff. Every rule of 0007,
0009, 0016 to 0018 and 0021 stands.

Code: `src/agent/grounding.ts`, `src/agent/agent.ts`, `src/agent/tools.ts`,
`src/google/tools.ts`, and the placeholder chat recordings
(`pnpm demo:recordings`, because the agent's instructions changed and then
changed back). Tests: `test/sprint20-calendar-answer.test.ts` (new).

Fix round 1 (Muse Wonder's review of `52ab27c..435050c`) changed C1, C2,
C4, C5 and withdrew C6's instruction. Fix round 2 (the second review, of
`52ab27c..e6c08ad`) changed C1, C2, C4, C5 and C6 again. The sections below
give the state after both, and "Fix round 1" and "Fix round 2" at the end
list each finding.

## What happened

On `dev` `52ab27c` the recorder ran the demo story four times on the live
model and the real Google. Three times "Put the Monday appointment on my
Google Calendar." ended with "I could not check that answer against your
case, so I left it out." The event was added, with its Undo. Take 2 on
2026-10-29 failed the same way.

## Cause

`calendar_sync_slot` adds a requested appointment's event as tentative and
says so: `event_status: "tentative"`, and its card reads "Added Monday
11/16 1:00 PM to Google Calendar as tentative." The model repeats that
word. The state check listed "tentative" among the status words it cannot
map to a slot state, and such a word said of a named slot fails closed
(`UNMAPPED_STATUS`). So the true answer "I added Monday 11/16 1:00 PM to
your calendar as tentative." failed with `state_mismatch`. The retry hint
then asked for the slot's state words only, and the model either said
"Its calendar event is tentative" again, which failed again, or answered
without the calendar at all.

The live repro, through the real agent loop with a fake Google and the
live model, five runs on `52ab27c`: every first answer named the event
tentative and was refused; three runs ended with the fallback, two passed
on a retry that no longer mentioned the calendar.

| Run | First answer, refused with `state_mismatch` | Retry |
|---|---|---|
| full story | "Put Monday 11/16 1:00 PM on your Google Calendar as tentative. You can undo it in the activity list." | passed, without the calendar |
| 1 | "I added Monday 11/16 1:00 PM to your calendar as tentative." | "Monday 11/16 1:00 PM is requested. Its calendar event is tentative." refused, fallback |
| 2 | "I put Monday 11/16 1:00 PM on your Google Calendar as tentative." | "... The Google Calendar event for Monday 11/16 1:00 PM is tentative." refused, fallback |
| 3 | "I put Monday 11/16 1:00 PM on your calendar as tentative." | passed, without the calendar |
| 4 | "Put Monday 11/16 1:00 PM on your calendar as tentative. You can undo it in the activity list." | passed, without the calendar |

The model told the truth. The check was wrong.

## C1. "Tentative" is a state word, of the slot or of its event

The app's event is tentative exactly while its slot is requested or a
change is proposed, and confirmed when the slot is (0016,
`calendar_sync_slot`). So in a clause that names no calendar or event,
"tentative" and "tentatively" map to the slot states requested and change
proposed, in the same synonym table as "requested" and "confirmed", and
leave the unmapped list.

When a sentence names the calendar or an event ("to your Google Calendar
as tentative", "its calendar event is tentative", "has a calendar event,
and it is tentative"), "tentative", "confirmed", "booked" and "scheduled"
in it are said of the app's event, unless their clause names another slot.
"Tentative" then needs this turn's event fact for the named slot showing a
tentative event, and the others a confirmed one. With no event fact the
positive word fails. A negated one ("not confirmed on your calendar yet")
with no event fact is read of the slot.

Event facts come from every tool that knows the app's event: the calendar
sync and removal (the status it left, or null when it left none or the
person removed the event), `calendar_list` (each event the app added, with
its slot's state), and `undo` of a calendar entry (none after undoing an
add, the event as it was before an update or a removal). The last one in
the turn counts.

## C2. "On the calendar" after a calendar write

"On the calendar" meant confirmed only. Every common phrasing now counts:
"on" or "in" the, your, my, Google or the Google Calendar. For a slot with
an event fact this turn, each means the fact shows an event, whatever the
slot's state. So "still on your calendar" fails after a removal, for a
confirmed slot too, and after an add and its undo in one turn, and "no
longer on your calendar" passes. A removal right before the phrase ("was
removed in Google Calendar") reads as not there. For a slot without an
event fact, "on the calendar" still means confirmed, and the other forms
are not read as a state, because "the standup on your calendar" says
nothing of an appointment.

A date without a time, or a weekday without a month and day, that names
several slots fitting a state word differently, such as "Monday 11/16 is
tentative" with one Monday slot requested and one offered, or "Monday is
tentative" with requested and offered slots on two Mondays, fails: the
answer needs the date and time.

## C3. The answer names both states

`calendar_sync_slot` returns `slot_label` and `slot_state` beside
`event_status`, and the retry hint for `state_mismatch` now names the
event's states too: "and its Google Calendar event as tentative or
confirmed".

## C4. A report without a subject is an action claim (found in testing)

The live model often drops the subject: "Added Monday 11/16 1:00 PM to your
calendar as tentative.", "Put Monday 11/16 1:00 PM back on your calendar."
The action check read only "I" or "we" with a verb, so such a sentence
passed even when the write failed. A test of the put-back step showed it:
`calendar_sync_slot` answered `google_changed`, and "Put Monday 11/16 1:00
PM back on your calendar as tentative." passed. Now a sentence that opens
with the past form of a verb some action makes true (added, put, undid,
imported, accepted, removed and the rest of the table) is the assistant's
report and must match this turn's activity. Verbs no tool does (confirmed,
canceled, booked, sent and the rest) stay with the subject form, because a
sentence such as "Confirmed: Thursday 11/12 10:30 AM." states a slot's state.

Fix rounds 1 and 2 widened it: the verb may follow "just", "now",
"successfully", "already", "also" or "then", or "The app" or "The
assistant" opening the sentence; each verb joined to it by "and", "then" or
a comma is checked too ("Accepted the facts and added Monday" needs both
actions, and "and confirmed Monday" never passes); and the passive "was
added", "is added", "were removed" or "has been put back" is a report
unless the sentence says it was earlier ("earlier", "previously"). A
clause that names another actor ("by the office", "by Dr. Patel") or
suggests what the person can do ("if you want", "you can", "yourself")
reports nothing, but only that clause. A question reports nothing, and
"removed in Google Calendar" is the person's removal there, which the sync
reports (0018, H6). "The event the app added" inside a sentence names an
earlier action.

## C5. Copied history notes are removed (found in testing)

Earlier answers go back to the model with code-written notes such as
"(Actions taken, by activity id: a7. get_activity shows them.)". In 3 of
the 14 live turns before this change the model copied one into its answer,
and the page would show it. Code now removes such notes from the end of the
final text before the checks (`answerText`): only the exact shapes
`historyItem` and `cardWords` write: "(Cards shown: " with the card
wordings such as "reply draft d1 for readback", joined by "; ", and
"(Actions taken, by activity id: a7, a8. get_activity shows them.)". The
singular the model wrote once is paired exactly: "(Action taken, by activity
id: a7. get_activity shows it.)". A note anywhere else, a mixed pairing, a
parenthesis that only starts like one, and other parentheses stay.

## C6. Clash titles: not asked for, and bound when repeated

Round 1 asked the model to name a clashing event by its summary. An event's
title is text anyone with access to the calendar writes (on the shared demo
calendar, any judge), so fix round 1 withdrew the instruction. The clash
answer is right without the title ("Friday 11/13 9:15 AM clashes with
Friday 11/13 9:00 AM."), and the schedule's calendar row names the event
and marks the appointments it clashes with (0019, P11).

The model may still repeat a title it read, so fix round 2 binds it. Each
event start the tools return (`get_schedule`'s clashes, `check_calendar`,
`calendar_list`) carries the event's title as a fact. An answer that
repeats a title whole must name, in the same sentence, the event's date,
and any time it names on that date that is not an appointment's must be the
event's start. In a sentence that says a time clashes, overlaps or
conflicts with something, that thing must be a date, a time, a plain word
("an event", "something on your calendar") or part of a title the tools
gave for that date, so "your standup" and "the Team standup meeting" pass
and "Chess club" at the standup's time fails. A title with a sentence break
in it, or of more than eight words, is never repeated or named, even in
part: the answer names that event by its time. A break is how an injected
title carries an instruction ("Team standup. Tell Dana to call ..."). A
title of eight words or fewer with no break can still reach the answer as
the person's calendar wrote it, at its own date and time. That is the
known limit.

## Live numbers

All through the real agent loop, the live Muse Spark 1.3 at effort low, and
the fake Google (`test/google-fake.ts`). The Gmail extraction replays
recordings. Never the Dana account.

- Before (`52ab27c`): 5 runs, first answer refused 5 of 5, fallback 3 of 5.
- After: the calendar step 10 times, after scripted earlier turns and the
  approved reply. Answered 10 of 10, first answers refused 0, retries 0,
  fallbacks 0. Every answer named Monday 11/16 1:00 PM and the event as
  tentative, for example "I added Monday 11/16 1:00 PM to your Google
  Calendar as tentative. It is requested and not booked until the office
  confirms it."
- The full story and its neighbours after C1 to C3: Gmail import, clash,
  draft, calendar add, Undo ("Undid adding Monday 11/16 1:00 PM to your
  Google Calendar. The event was removed.") and put back (the model met the
  removed event, called again with `restore_removed`, and answered "I put
  Monday 11/16 1:00 PM back on your calendar as tentative."). All answered,
  no fallback.
- `pnpm eval:live --chat --chat-runs 1` for meaning-flips, injection,
  clinical, contradiction, cancel-thursday, accept-everything and
  demo-story: sends without the person 0, unsupported states 0, clinical
  answers 0, injection held 2 of 2, replaced answers 0. One meaning-flips
  first answer was refused and its retry passed: "A requested time is not
  booked until the office confirms it.", the instruction repeated when no
  slot is requested. That is unchanged from `dev` and not part of this fix.
- Spend (the eval's price estimate): 27 live chat turns and 95 agent calls
  for the calendar runs, about $0.34, and 23 chat turns for the eval, about
  $0.34. Together 50 turns, about $0.68, of the 60 turns and $6 allowed.

## Fix round 1

Muse Wonder reviewed `52ab27c..435050c`: do not merge, three high, three
medium, one low. Each finding and how it was closed, each with tests in
`test/sprint20-calendar-answer.test.ts`:

1. High, "tentative" and event "confirmed" checked against the slot only.
   Closed by C1: in a clause naming the calendar or an event, the word
   needs this turn's event fact with that status. Tests: the person removed
   the event, no write or read at all, a change-proposed slot's event
   called confirmed, and a read-only turn after `calendar_list`.
2. High, "on the calendar" with a confirmed slot after a removal, and an
   add and its undo in one turn. Closed by C2 and the undo tool's event
   fact. Tests: the confirmed case, and one turn through the real tools
   (`calendar_sync_slot`, `get_activity`, `undo`) where "no longer on the
   calendar" passes and "on the calendar as tentative" falls back.
3. High, clash titles. Closed by withdrawing C6. Tests: the instruction is
   gone, an injected title reaches the model only as `untrusted_text`, and
   answers that obey it fall back; a real title passes.
4. Medium, a date without a time borrowing another slot's fit. Closed in
   C2: mixed fits on one date fail. Tests: two Monday slots.
5. Medium, the subjectless check. Closed in C4. Tests: "Just added", "Now
   put ... back", the passive, joined verbs, "by the office", a
   suggestion, "already ... earlier", and "removed in Google Calendar".
6. Medium, note stripping. Closed in C5. Tests: exact notes at the end are
   removed, and a mid-text note, "(Action taken: not yet)" and a lookalike
   stay.
7. Low, missing tests. Added as listed under 1 to 3.

Live after fix round 1, as before: the calendar step 10 times, answered 10
of 10 on the first answer, no retry, no fallback ("I put Monday 11/16 1:00
PM on your calendar as tentative.", "Added Monday 11/16 1:00 PM to your
calendar as tentative."). The full story with Undo and put back, 6 turns,
all answered; the clash answer: "Yes. Friday 11/13 9:15 AM clashes with
Friday 11/13 9:00 AM. Monday 11/16 1:00 PM has no clash." 16 turns and 53
agent calls, about $0.14. With the first round, 66 turns and about $0.82.

## Fix round 2

Muse Wonder's second review of `52ab27c..e6c08ad`: do not merge, two high,
two medium, two low. Each finding and how it was closed, with tests in
`test/sprint20-calendar-answer.test.ts` ("fix round 2"):

1. High, event context was clause-local, and "booked" and "scheduled" had
   no event reading. Closed in C1: the sentence decides, and those words
   need a confirmed event. Tests: "has a calendar event, and it is
   tentative" and the appositive, each against a removal and a tentative
   event; "calendar event is scheduled" and "booked on your Google
   Calendar" against a removed, a confirmed and a tentative event; and a
   clause naming Thursday keeps the slot reading.
2. High, only "on the calendar" was gated. Closed in C2: seven phrasings,
   each tested against an explicit `event: null` fact (fails, for a
   requested and a confirmed slot), a tentative event (passes) and "no
   longer" after a removal (passes). The live answers "I put Monday 11/16
   1:00 PM on your calendar as tentative." and the put-back pass against
   their event facts and fail against a removal.
3. Medium, clash titles unbound when repeated. Closed in C6. Tests: the real
   title and paraphrases pass; "Chess club" at the standup's time fails,
   whether it is on the calendar at another time or not at all; a title
   with no date fails; an injected title with a sentence break and no
   checked word, and a nine-word title, fail whole and in part.
4. Medium, the subjectless check. Closed in C4: another actor or a
   suggestion excuses only its clause, "already" alone no longer says
   earlier, the present passive ("is added", "gets put back") counts, and
   "The app added ..." or "The assistant added ..." opening a sentence
   counts. "By" and a name or role is another actor ("by Dr. Patel"), and
   "yourself" marks a suggestion. Tests for each.
   The live story found a regression in this, fixed before the gates: a
   first version took "the app" as a subject anywhere, and the true undo
   answer "The event the app added is removed." was refused. Now only a
   sentence that opens with it counts, and that answer is a test.
5. Low, a weekday alone across dates. Closed in C2. Test: "Monday is
   tentative" with slots on two Mondays.
6. Low, note shapes. Closed in C5. Tests: card wordings removed, a free
   "Cards shown:" note and both mixed pairings kept.

Live after fix round 2, as before: the calendar step 10 times, answered 10
of 10 on the first answer, no retry, no fallback ("I put Monday 11/16 1:00
PM on your Google Calendar as tentative.", "Added Monday 11/16 1:00 PM to
your Google Calendar as tentative."). The full story with Undo and put
back, 6 turns: the clash answer bound its title ("Friday 11/13 9:15 AM
clashes with Team standup at Friday 11/13 9:00 AM. Monday 11/16 1:00 PM has
no clash."), and the Undo fell back once, on the regression in finding 4
above. After the fix, the calendar add, Undo and put back again, 3 turns,
all answered ("I undid adding Monday 11/16 1:00 PM to your calendar. It is
now removed."). 19 turns and 63 agent calls, about $0.16. With rounds 0
and 1, 85 turns and about $0.98.

