# 0003: Reply templates and the simulated send

Status: proposed, pending Jeff, 2026-10-27

This records how the user replies to the office in sprint 3 (D3). R-a to
R-h were set by the coordinator for this sprint. T1 was accepted by the
coordinator on 2026-10-27 and waits for Jeff. T items were chosen while
building it where the rules left a case open. Jeff's decisions of
2026-10-27 on W30 and the extraction effort are recorded in 0002.

Code: `src/reply/` (templates, checks and fields, model call, commands,
view), `ui/ReplyPanel.tsx`.

## Templates

Each template fixes what the reply asserts, so neither the model nor a
field value can flip its meaning.

| Template | Asserts | Valid only when | Needs | Approval records |
|---|---|---|---|---|
| Accept an offered slot | You accept the slot and ask the office to confirm it | The slot is offered | date, time | a request on the slot |
| Decline and ask for another time | You decline the slot and ask for another time | The slot is offered | date, time | a decline on the slot |
| Ask whether a slot still stands | A question. You commit to nothing | The slot is confirmed or change proposed | date, time | nothing |
| Keep the original | You keep the confirmed slot and decline the proposed change | The slot is change proposed | date, time | a decline on each open alternative |

The place, the office name, the declined alternatives and the user's name
are shown when the case has them and left out of the text otherwise.

## Coordinator decisions

- R-a. Approving an accept reply records a request, and the slot shows
  "Requested · reported by you". Approving a decline reply records a
  decline, and the slot shows "Declined · reported by you". Approving a
  keep-the-original reply records a decline on each open alternative of the
  proposed change, so the original returns to plain confirmed when an offer
  alone proposed the change. Approving an ask-whether-it-stands reply
  records the draft and the send only.
- R-b. Suggestions, drafts, edits, discards, approvals and simulated sends
  are events on one `reply` stream, and every write states its expected
  version. One draft is open at a time. A new draft discards the open one
  with a `reply_discarded` event in the same write. Sprint 5 can restore an
  open draft from these events.
- R-c. Code fills every field from the projected slot, the evidence and the
  case profile. The model only picks the template and the slot. A field
  value the model proposes must equal the code value or the attempt is
  rejected (`field_mismatch`). The readback shows each field with the
  evidence or slot it came from.
- R-d. A template that needs a field the slot lacks is not offered (S7).
  T1 narrows this for the place.
- R-e. Edited text is never checked against the case again and never shown
  as checked. The label "Edited by you. Not checked." stays until the draft
  is discarded, even when the text is changed back. The scope check of R-f
  still applies to it.
- R-f. Text the user types is checked with the clinical-content check before
  any model call or write (S11). This covers a pasted report, a note for the
  model call and an edit of a draft. Approval checks an edited text again.
  See T11.
- R-g. The simulated send writes only local events. A test counts fetch,
  socket, TLS, HTTP, HTTPS and DNS calls during approval and finds none.
- R-h. When the text was edited away from the code render, approval
  records no claim by default. The approve step shows one more statement
  built by code from the template, for example "This reply still requests
  Monday 11/16 1:00 PM", unticked. Only when the user ticks it does approval
  record the template's claims. Otherwise approval records the draft and the
  simulated send only, and the sent reply says no slot change was recorded.
  A text that says the same as the code render, also one restored after an
  edit, needs no statement. Line endings and trailing spaces on a line or at
  the end do not count as a change for this. The edit label still follows
  any change. The ask-whether-it-stands template records no claim, so it
  shows none. Set in review round 1.

## Choices made while building

- T1 (accepted by the coordinator 2026-10-27). The place is optional for
  every template, including accept. R-d
  asked that accept need a place. In the demo, m3 offers Monday 11/16 1:00
  PM without a place, so that rule would withhold the accept template from
  the demo beat "Dana picks Monday. The accept template renders." The reply
  then names no place, and the readback says the place is left out. A slot
  without a time still gets no template.
- T2. Every template needs the date and the time. Slot identity is date
  plus time (D-g), so a date-only slot gets no template. In S7 the confirmed
  slot without a time offers nothing, and "ask whether it stands" is listed
  as withheld for the missing time.
- T3. The office name is the sender of the latest office message on the
  slot. Imported text is data, so it is shown on one line and cut to 120
  characters. The user's name comes from the case profile
  (`fixtures/case.json`). When either is missing, the greeting or the
  signature leaves it out.
- T4. Tapping "Keep <original>" in a question opens a keep-the-original
  draft and records no decline, for the same reason as W30: a decline is a
  statement to the office, so it waits for the approved reply.
- T5. Keep-the-original declines every alternative that a proposal on the
  slot offered and that is still open, offered or requested (the meaning of
  "open" in W13). A requested alternative must be withdrawn too, or keeping
  the original would leave a request standing.
- T6. Keep-the-original is offered for any change-proposed slot, also when
  the office asked to move it. The question in W17 does not offer "Keep" for
  a move, but a reply may still say so. After approval the move still
  proposes a change (W15), so the slot stays change proposed.
- T7. The model call takes an optional note the user types, the slots and
  the templates. It never sees message text. A tap on a question choice
  uses no model call: code takes the template from the tap, so the model
  cannot change what the user chose.
- T8. Approval needs the name of every field the user read back, and the UI
  keeps the button disabled until each field is ticked. Approval states the
  reply-stream version the ticks were made at. A saved edit moves the
  version, so the UI clears the ticks and the server refuses a readback
  from before the edit. Approval refuses a
  draft whose template no longer fits the slot or whose fields no longer
  equal what code builds (`case_changed`). The user discards it and starts
  again.
- T9. An answer whose choice opens a draft states the expected version of
  the reply stream as well as the question queue, and both are written in
  one transaction.
- T10. Evidence from an approved reply has origin `reply`. It is ordered
  like an answer (W6), just after the latest evidence the user had in view.
  It carries no place, so it never changes a slot's place. Its quote is a
  code label such as "Approved reply: I accept Monday 11/16 1:00 PM".
- T11. The clinical check covers a pasted report on the `user_report`
  channel, the note for the model call and every draft edit. It reads the
  text after NFKC normalization with format characters (such as zero-width
  spaces and soft hyphens) removed, and also with accents removed. A word
  that mixes Latin letters with letters of another script fails closed and
  gets the fixed decline. The same check applies to model text (W28), where
  a false match costs a retry. A clinical report is refused at
  import, so its text is never stored. Office messages are imported as data
  and are not checked, because the office may name things to bring.
- T12. Edited text must not be empty, must differ from the current text and
  may hold up to 2000 characters. An approved reply keeps its edited flag.
- T13. The model call has one retry through the shared retry code, which
  passes only problem codes. After that the suggestion is recorded with the
  output of each attempt, and the user picks a template and slot from the
  options code offers.
- T14. A proposed date and time must match exactly. A proposed place must
  match apart from case and spacing. A null value proposes nothing.
- T15. The template call defaults to effort `low`, like the other D2 calls.
- T16. Evidence writes do not move the reply stream, so a model call can
  return after the case changed. Every check, field values included, runs
  again on the model's final output against the case as it is when the call
  returns. A pick that no longer fits is recorded as
  a fallback to manual entry with the problems, and no draft opens.
- T17. The evaluation scores the model's own final pick apart from the
  system outcome. When no template fits, the code fallback meets the
  expected outcome, and the report counts how often the model still
  proposed a pick that code blocked.
