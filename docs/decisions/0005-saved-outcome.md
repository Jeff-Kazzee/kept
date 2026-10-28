# 0005: Saved outcome, checklist and Delete case

Status: proposed, pending Jeff, 2026-10-27

This records how the case survives a restart, how the office's late reply
reaches the end state, how the checklist and the case history are built,
and how Delete case erases the case in sprint 5 (D4). O-a to O-h were set
by the coordinator for this sprint. S items were chosen while building it
where the rules left a case open.

Code: `src/store/event-log.ts` (`eraseCase`), `src/case/service.ts`
(`deleteCase`, `caseVersion`, `history`), `src/case/checklist.ts`,
`src/case/history.ts`, `src/reply/view.ts` (the draft notice),
`src/records/service.ts` (the clinical check), `src/model/request.ts`
(extraction instructions), `ui/App.tsx`.

## Coordinator decisions

- O-a. Delete case erases every event of the case: messages, evidence,
  reviews, slots, questions, explanations, replies, records, notes, tags and
  proposals. It also erases the case's access log entries and every
  rate-limit counter. Grants are app settings and stay. Revoking them stays
  with `pnpm grant revoke` until the sprint 6 grant screen.
- O-b. Erased means gone from disk, not only from queries. After the delete
  commits, a TRUNCATE checkpoint, VACUUM and a second TRUNCATE checkpoint
  rewrite the file and empty the WAL. `secure_delete` is on for the delete,
  and VACUUM builds its copy in memory. A test writes a marker into a pasted
  message, the calendar name, a note, a proposal statement and a reply edit,
  deletes the case, and searches every file in the database directory for
  the marker as bytes, with the store open and after it closes.
- O-c. The user types DELETE to confirm. The button says what is erased and
  that it cannot be undone. `EventStore.eraseCase` is the one function that
  lifts the append-only guard. Inside one transaction it drops the delete
  trigger, deletes, and creates the trigger again, so no other connection
  ever sees the table without it, and a failure rolls the guard back too.
  A test checks that no other source file deletes or updates events or
  drops a trigger, and that only `CaseService.deleteCase` calls `eraseCase`.
- O-d. A Delete case while an MCP server process has the file open leaves
  the file sound. The server's next call finds no case: `list_appointments`
  returns an empty list and `get_appointment` returns `not_found`. Tested
  with the stdio server running as a subprocess during the delete.
- O-e. Notes and proposal statements written by an agent go through
  `hasClinicalContent`, which reads normalized text, as user text does. A
  clinical value writes nothing. The MCP server answers with the tool error
  `out_of_scope` and logs the call with that result.
- O-f. The checklist lists accepted `office_request` evidence only, each
  item with the verbatim quote and the source label of every evidence item
  behind it. A request the user rejected in review does not appear. Items
  are not model output and carry no model label. They have no done state in
  this sprint. Requests in the same words become one item that keeps every
  source. Different wording stays as separate items.
- O-g. The extraction instructions now ask for a separate `office_request`
  claim for each thing to bring or do, even when one sentence asks for
  several, with two examples that no fixture uses. The schema, the quote
  check and the scoring are unchanged. The coordinator measures the change
  live.
- O-h. A restart restores the slot states, the open conflicts and the
  current question, the stored explanations, the open reply draft with its
  edit and its edited label, and the checklist. All of these are
  projections of the event log, so nothing extra is saved. Readback ticks
  are held in the browser only and are not restored. The draft card says
  so.

## Decisions made in the sprint

### Delete case

- S1. Delete case states an expected version, as every user write does.
  The case version is the highest event number among case events, leaving
  out grants and the access log. So an agent reading the case does not make
  the user's confirmation stale, and neither does creating a grant. The
  version check runs inside the delete transaction. A mismatch is a stale
  edit (HTTP 409) and erases nothing.
- S2. When the delete commits but another program keeps the file busy so
  that the compaction cannot finish, the app answers HTTP 503 with
  `compaction_incomplete`: the case is deleted, old text may remain in the
  file until that program closes, and running Delete case again finishes
  the job. The app and the MCP server also finish it at start (R3). Delete
  case on an empty case only compacts.
- S3. The API route is `POST /api/case/delete` with `expectedVersion` and
  `confirmation`. The server checks the confirmation word too, not only the
  UI. No MCP tool reaches it.

### Clinical check

- S4. The check covers notes from the user as well as from an agent, tags,
  and every free-text field of a proposal (statement, place and request
  item), not only agent notes and statements. Tags and places are text an
  agent writes as well, and the app's scope is administrative for every
  writer. A note with a hidden character is still refused earlier as
  `invalid_input`.

### Checklist

- S5. Two requests are in the same words when their request items match
  after compatibility folding, removing format characters, ignoring case,
  collapsing spaces and dropping end punctuation. The item shows the
  request in the words of its first source. Items keep the order in which
  their first source entered the case.

### Late office reply

- S6. The office's reply goes through extraction and review like any other
  message. Its claims change nothing until the user accepts them. An open
  draft that the reply overtakes says "The office replied. This draft no
  longer fits." The app says this when a claim from an office message was
  accepted after the draft was made, ordered by event number, not by clock
  time. Other changes say "The case changed since this draft was made."
  Approval stays blocked by the existing validity check.
- S7. The slots table shows the quote of the evidence that set each state,
  so "Confirmed · office message" and the office's words are on screen
  together.

### History

- S8. The case history lists every case event in order with a label built
  by code from the event kind, ids, counts, dates and times. It does not
  repeat message text, quotes, notes, proposal statements, tags, file names
  or choice labels (R4). Those stay in the
  views that label them. Grant events are left out. Access log entries are
  included. The simulated send is written with the approval, so the
  approval entry says "Approved. Simulated send." and the send has no entry
  of its own. An undone event is marked.

### Fixtures

- S9. S10 now has three D4 checkpoints that reopen the app on a database
  file: with the question open, with an edited draft before approval, and
  before the office's late reply. Each reopen must restore the exact app
  state. The scenario uses m1 to m4. The replay gains `explain`, `ask` and
  `reopen` steps.
- S10. The extraction recordings are keyed by message id, as before. Both
  m2 recordings already split the two requests, so only a note was added
  to each.

## Review round 1

- R1. Case generation. A counter in a `case_meta` table, outside the
  events table, that Delete case increments in its transaction. A command
  on the case reads it when it starts and runs in a scope
  (`EventStore.inCase`, on AsyncLocalStorage, so it holds across the
  awaits of a model call). Every write transaction in that scope checks,
  inside the lock, that the generation has not moved. If it has, the write
  fails with `CaseDeletedError` and nothing is written. Stream versions
  start again at 0 after a delete, so the expected version alone could not
  catch this. The API runs every request as one command, at the generation
  the page last read, which the UI sends in the `X-Case-Generation` header.
  A stale page gets HTTP 409 `case_deleted`. The MCP server runs every tool
  call as one command at the generation read when the call starts. explain,
  askNext, suggest, extraction, add_note, set_tags and propose_change also
  open their own scope, so a direct caller is covered too.
- R2. An MCP call that crosses a Delete case returns `not_found` with a
  message that the case was deleted, returns no data, and is not logged. A
  waiting log entry from a busy call carries its generation and is dropped,
  never written, once the generation moves. This removes the known limit
  sprint 5 first recorded here.
- R3. Delete case sets an `erase_pending` mark in `case_meta` in the
  delete transaction. The mark is cleared only after the TRUNCATE
  checkpoint, VACUUM and the second TRUNCATE checkpoint succeed. The app
  and the MCP server finish a pending erase at start, before they serve.
  The Delete case panel warns while the mark is set.
- R4. History labels hold no free text. A loaded calendar is "Calendar
  loaded", a tag change gives the number of tags, and an answer gives the
  choice id, which code builds from slot keys and fixed words.
- R5. Confirming a proposal checks its statement, place and request item
  again, before any write, so a proposal stored before the check existed
  cannot become evidence with clinical text.
- R6. The checklist key drops every punctuation mark, quote and bracket at
  either end of the request, so "Bring new insurance card?" and "Bring new
  insurance card" are one item.

## Review round 2

- B1. Every request that changes state must carry the case generation the
  page last read, in the `X-Case-Generation` header. A missing or malformed
  one is refused with HTTP 400 `generation_required` before anything runs.
  Only GET may leave it out. The UI reads the case before its first write
  if it has not yet, and sends the generation from its latest read, so the
  first write after a Delete case uses the new one.
- B2. The `erase_pending` mark holds the generation whose erase is pending.
  `finishPendingErase` reads it before compacting and, after compacting,
  clears it in a write transaction only if it still holds that generation.
  So a process that finishes one erase late cannot clear the mark of a
  later delete by another process.
- B3. Every public write of the intake, case, reply and records services
  runs as one case command (`inCase`), not only the ones with a model call
  or a pre-read. A test runs each of them on a store that refuses any
  write outside a command, and lists every public method as a read or an
  exercised write, so a new unscoped write fails it. Grants are app
  settings and stay outside this rule.

## Live evaluation finding

- C2. In the second live run of the O-g change, effort `minimal` once
  extracted "Reply C to confirm." from s6-reminder as an office request.
  The instructions now say that an office request is something to bring or
  do for the appointment, and that how to answer the message is not one,
  with the neutral example "Text Y to keep this time." The schema, the
  quote check and the scoring are unchanged. The recorded fault
  `faults/extract-reply-mechanics.json` holds that claim, and an offline
  test shows it passes the quote check and counts as extra in the scoring.

## Known limits

- VACUUM rewrites the whole file, so Delete case takes longer as the file
  grows. Grants and the empty schema are all that remain afterwards.
