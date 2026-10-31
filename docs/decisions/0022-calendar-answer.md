# 0022: The calendar-add answer fell back

Status: sprint 20, from the coordinator's handoff of 2026-10-31. Choices
marked (proposed) are the writer's and wait for Jeff. Every rule of 0007,
0009, 0016 to 0018 and 0021 stands.

Code: `src/agent/grounding.ts`, `src/agent/agent.ts`, `src/google/tools.ts`,
and the placeholder chat recordings (`pnpm demo:recordings`, because the
agent's instructions changed). Tests: `test/sprint20-calendar-answer.test.ts`
(new).

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

## C1. "Tentative" is a state word

The app's event is tentative exactly while its slot is requested or a
change is proposed, and confirmed when the slot is (0016,
`calendar_sync_slot`). So "tentative" and "tentatively" now map to the
slot states requested and change proposed, in the same synonym table as
"requested" and "confirmed", and leave the unmapped list. The check stays
as strict as for any state word: "Friday 11/13 9:15 AM is tentative" fails
while Friday is offered, "Monday is tentative" fails once Monday is
confirmed, and "Monday is not tentative" fails while it is requested.

## C2. "On the calendar" after a calendar write

"On the calendar" meant confirmed only. After a sync, "Monday 11/16 1:00 PM
is on the calendar" is true of the requested slot. Each calendar write's
fact now carries `event`: the status of the app's event it left, or null
when it left none (removed, nothing to add, or removed by the person). "On
the calendar" is true of a confirmed slot or of a slot whose last write in
the turn left an event, so "still on the calendar" after a removal fails.
"On your calendar" stays unchecked as a state, as before; the action check
holds "I put it on your calendar".

Limit: an Undo of a calendar entry gives the slots' facts without `event`,
so in a turn that both adds an event and undoes it, the add's fact still
stands for "on the calendar". No live turn did both.

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

## C5. Copied history notes are removed (found in testing)

Earlier answers go back to the model with code-written notes such as
"(Actions taken, by activity id: a7. get_activity shows them.)". In 3 of
the 14 live turns before this change the model copied one into its answer,
and the page would show it. Code now removes such a note from the
final text before the checks (`answerText`). Other parentheses stay.

## C6. The clash answer names the event

One instruction is added: "When a time clashes with a calendar event, name
the event by its summary and give its start as the tools label it." In the
live runs after it the clash answer read "Friday 11/13 9:15 AM clashes with
Team standup Friday 11/13 9:00 AM." (proposed: the summary is the person's
own calendar text, untrusted for instructions, and every date and time in
it is still checked.)

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
