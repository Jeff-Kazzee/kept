# 0017: Fixes from the second live Gmail and Calendar run

Status: the items E1 to E6 come from the sprint 13D handoff (2026-10-29).
Choices marked (proposed) are the writer's and wait for Jeff.

Live run 2 on the demo at sprint 13C passed the key check: a clash with an
event added after connecting was found with no manual read. It also found
the items below. This records what was found and changed.

Code: `src/google/case-mark.ts`, `src/google/calendar.ts`,
`src/reply/office.ts`, `src/actions/service.ts`, `server/request-log.ts`,
`server/main.ts`, `server/workspace.ts`, `mcp/main.ts`,
`ui/chat/ChatView.tsx`, `ui/case/Source.tsx`, `ui/agent/Receipts.tsx`,
`ui/pages/Settings.tsx`, `ui/App.tsx`, `ui/styles.css`. Tests:
`test/sprint13d-calendar.test.ts`, `test/sprint13d-office.test.ts`,
`test/request-log.test.ts`, `ui/chat/sprint13d.dom.test.ts`,
`ui/pages/sprint13d.dom.test.ts`, and changes to
`test/sprint13c-office.test.ts`, `test/sprint13c-calendar.test.ts` and
`test/activity.test.ts`.

## E1. A new case never inherits calendar events

Found: `eventIdFor` derived an event's id from the account, the calendar
and the slot key only, and the property lookup matched the same three.
The same slot in a new case mapped to the old case's event. Run 1's event
for Monday 11/16 1:00 PM sat in Google's trash, so the new case read it as
"removed by the person" and would not add it.

Changed:

- Each case has a mark: 26 random characters from a to v and 0 to 9, kept
  as one event on the `calendar_case` stream. It is made at the case's
  first Google Calendar write, in the transaction that records the write's
  intent, and Delete case erases it with the rest of the case. A sync that
  writes nothing makes none (fix round 1, R2). (proposed: made at the
  first write, not when the case starts, so a case that never touches the
  calendar holds no mark)
- The mark joins the inputs of the event id and is a fourth private
  property, `apptCase`. The property lookup asks for all four. An event
  counts as the case's only when its mark matches.
- A case with no mark yet owns no event, so a plan looks nothing up.
  `list` reads the mark after the events, so an event the case made while
  they were read is its own.
- "A sync never puts back an event the person removed in Google" holds
  within a case: the same case finds its removed event under the same id
  and refuses, as before.
- Every write plan and undo record carries the mark. A record without one
  is of the earlier scheme and is checked as before, so old Undo records
  still work.
- A case whose calendar writes predate marks (an activity entry or an
  intent of a calendar write, none with a mark) keeps the earlier scheme
  until Delete case: its mark is stored as none, its events are found and
  not doubled. (proposed)
- An event an earlier case made and the person kept in Google is not the
  new case's. It reads as one of the person's own events, so it can show as
  a clash, and the new case adds its own event for the same slot. Delete
  case leaves Google Calendar as it is, and its message now says so (E5).

## E2. One rule for an appointment's place

The schedule, the reply card and the calendar event use the slot's own
place from accepted evidence. 0016's H4 fallback to the office's one known
place for the event's location is gone: an appointment without its own
place has an event without a location, the schedule says "Place not
stated" and the reply leaves the place out. This replaces the location
bullet of 0016, H4. The event's title still names the office.

## E3. A finished answer is in view

- While a turn streams, the thread follows its end, as before. When the
  turn ends, the view stops where the newest answer starts if the answer is
  taller than what is left in view, so a long card after the words cannot
  push them out. A short answer stays at the end. If the person scrolled
  away while it streamed, the view stays and the "New messages" pill shows.
- The app's own scrolls are not read as the person scrolling away.
- A facts card shows the message's facts from the live case, so a second
  card for the same office message in the thread is the same card. The
  first one keeps its place, and each later one is a line: "The facts from
  Lantern Hill Clinic are in the card above. 1 waits for you there." with
  "Show the card", which scrolls to the first card and focuses it.
  (proposed: the first card in the thread is the one kept, also when a
  later answer carries it)
- The stored chat is unchanged, so no recorded chat changes.

## E4. A request log

- One line per request to `/api/` or `/auth/`: `request POST /api/chat 200
  stream, started 4 ms, done at 511 ms`, or `request GET /api/state 200 6
  ms`. A stream the client closed first says "closed by the client". A
  request closed before any answer says so.
- Never a body, a header, a cookie, a query string, a token or an address.
  A path segment that is not a plain id (letters, digits, `.`, `_`, `:`,
  `-`, at most 80, no `@`) is written as `*`. Fix round 1 replaced this
  with an allowlist (R4).
- On by default in local mode, off by default in hosted mode.
  `APP_REQUEST_LOG=1` or `0` turns it on or off. It writes to stdout, so
  the `appt-demo` service's journal holds it.
- For the run 2 question: if the browser shows 503 for a `POST /api/chat`
  whose line here says 200, the 503 came from something between the
  browser and the app, such as a proxy, and not from the app.

## E5. Delete case says it finished

Once Delete case finished the page shows "The case was deleted. Its
messages, facts, replies, chat and activity are erased. Events it added to
Google Calendar stay there." A failed delete shows only its error. Fix
round 1 (R7) keeps it on the page instead of a toast.

## E6. Smaller items

- The fallback sentence shown twice. A turn that stops after a limit
  stores its code-written sentence as the answer and also as a notice card
  (`src/agent/agent.ts`). The page showed both. It now skips a notice card
  whose words are the sentence the answer already shows. The stored chat is
  unchanged, so no recording changes.
- The lowercase name. For a Gmail office, the name is held back while one
  of its emails is not read yet or one of its facts that gives a place
  waits for review, because that place may spell a fuller name. Meanwhile
  the page says "the office" and the activity labels say "the email, Oct
  28, 6:43 PM". A name already made fuller, and a pasted sender, show at
  once. (proposed) Fix round 1 (R8) uses the same rule for the greeting
  and the event's title.
- The horizontal scrollbar. The welcome's decorative scene is 140% of the
  column wide and gave the thread a sideways scrollbar on an empty case. The
  welcome now clips it at its sides. Checked at 1280 and 390 px. The only
  other element wider than its box is the suggestion row above the
  composer, which scrolls sideways by design with its scrollbar hidden.
- Tentative events. The fake Google stores the `status` the app sends, and
  `test/sprint13c-calendar.test.ts` checks that a requested slot's event is
  sent and stored as `tentative`, so the app's side is right. In the
  Calendar API, `status: "tentative"` means the event is tentatively
  confirmed. To the writer's knowledge Google Calendar's own view draws
  such an event like any other for its owner (the "maybe" look belongs to
  an attendee's own answer), so the person sees it only through the title,
  "Lantern Hill Clinic (requested)". Not checked live. The coordinator's
  rerun can confirm it. No change made.

## Recordings

No recording needs a live rerecord. The tool results, the instructions and
the stored chat are unchanged. `pnpm demo:check --recorded` passes.

## Notes for the coordinator

- After this change, the demo's current case (from before marks) keeps the
  earlier scheme until Delete case. Delete case first for a clean run.
- Delete case leaves the app's events in Google Calendar. A new case adds
  its own, so remove the old ones in Google Calendar before recording, or
  they show as clashes.
- The schedule says "Removed in Google Calendar" for an appointment whose
  event the person removed in Google, once the app has read the calendar
  since (fix round 1).

## Fix round 1 (2026-10-29)

From the independent review (`findings-r1`) and the writer's own note.

- R1. Delete case is refused while a chat turn of the app runs, or while a
  Google intent opened in the last two minutes is open, in this process or
  another: "The assistant or a Google Calendar change is still working.
  Nothing was deleted. Wait a moment, then delete the case again." (409
  `case_busy`). A Google write runs before the store commit that records
  it, so a Delete case in between would leave its event at Google with no
  record. An intent a stopped process left open longer than two minutes no
  longer blocks it, so Delete case cannot be stuck. (proposed: two
  minutes, the existing STALE_INTENT_MS)
- R2. `plan()` only reads the mark. A case without one plans a create with
  no event id, and `googleWrite` gives the plan its mark and event id in
  the transaction that opens the intent, so the intent records them. A
  sync or removal that writes nothing leaves no mark, and no lookup by
  property runs for a case without one.
- R3. The request log leaves out `GET /api/case/version`, the page's
  2-second poll, unless it fails. It is the only route the page polls.
- R4. A path segment is kept only when it is one of the app's route words,
  or an id of the app's own shape where a route takes one: a message
  (`gmail-…`, `chat-…`, `pasted-<uuid>`, `m1`, with a round), a fact (a
  message id with `-e1` or `-u1`), a conflict, `q1`, `d1`, a slot key or
  `a1`. Every other segment is `*`, a secret-looking one included.
- R5. The import sheet keeps one entry per message, and a later facts card
  with the same key never takes the first card's place, so a pointer
  always points at a rendered card.
- R6. The first facts card's heading carries the anchor id with tabindex
  -1. "Show the card" scrolls to it and moves focus there, so a screen
  reader reads "Facts from Lantern Hill Clinic".
- R7. The Delete case sentence is a status in the Delete case panel, shown
  while the new, empty case is the one on the page, and gone at the first
  write in it. It replaces the toast.
- R8. `officeOf` takes the held-back name (`officeNameShown`). While the
  page says "the office", the calendar event is titled by its state alone
  ("Appointment", "Appointment (requested, not confirmed)") and the reply
  greets "Hello,". The next sync after the name resolves updates the title,
  with Undo. A draft made before reads as no longer fitting once the name
  resolves, as for any change of the office's name (0016, N3).
- Removed in Google Calendar. `GET /api/google` adds `calendarOwn`: for
  each stored read, its days, when it was read and the slots whose own
  event it found live. When a read made after the slot's last calendar
  write or undo covers its date and does not find the event, the agenda
  row says "Removed in Google Calendar" instead of the Google mark. Without
  such a read the app's own last write stands.

No recording needs a live rerecord: tool results, the instructions and the
stored chat are unchanged, and `pnpm demo:check --recorded` passes.

## Fix round 2 (2026-10-29)

From the second independent review (`findings-r2`).

- F1. The running-turn flag has a start time, taken from the turn's own
  first reading of the clock. A turn running longer than `TURN_STALE_MS`
  no longer holds Delete case back, so a turn that never ends cannot block
  it for good. (proposed: five minutes) The turn itself is not stopped:
  its later writes are refused by the case generation, as before.
- F2. `googleWrite` notes the case generation when it opens the intent. A
  write whose case is gone before it starts is not sent ("The case was
  deleted. Nothing was written to Google Calendar."). After the write, a
  deleted case, or an intent that is neither open nor closed, ends the
  call with no Undo claim. When the change reached Google the sentence
  names it: "The case was deleted while this Google Calendar change ran,
  and the change still reached Google Calendar: Added Monday 11/16 1:00
  PM to Google Calendar as confirmed. Nothing in the app records it, so it
  has no Undo. Check the event in Google Calendar and remove or change it
  there if you do not want it." The chat turn and MCP pass it on.
- F3. A read of the calendar records whether it was complete: false when
  Google still had a page after the fourth. `calendarOwn` leaves out
  incomplete reads, so "Removed in Google Calendar" never comes from a
  read that may have missed the event.
- F4. Delete case clears the stored calendar reads, so `calendarOwn` and
  the clash copy no longer carry the erased case's appointment keys. The
  next read fills them again.
- F5. The request log writes every message id and fact id as `*`, because
  a message id can hold words a person or an email chose. The ids it keeps
  are made by the server from numbers and dates: `q1`, `d1`, `a1`, slot
  keys and conflict ids of the app's own kinds.
- F6. When the first facts card's message is no longer in the case, the
  pointer says "This message is no longer in the case." and offers no
  button.
- F7. `GoogleCalendar.sync()` and `remove()` wrote with no intent or entry
  and nothing in the app called them. They are gone. Every write goes
  plan, `CaseActions.googleWrite`, execute. Their tests use a helper that
  does the same.
- F8. Kept as it is: an event made while the office's name is held back
  keeps its title ("Appointment", "Appointment (requested, not
  confirmed)") until the next sync of that appointment, which updates it
  with Undo. Accepting a fact does not start a sync, so the title can stay
  until the assistant or the person syncs that appointment again.

No recording needs a live rerecord. `pnpm demo:check --recorded` passes.

## After sprint 13D: the tool-call limit (coordinator, 2026-10-29)

In live run 2 the first chat step ("Check my Gmail for messages from
Lantern Hill Clinic and update my schedule.") read the schedule, searched
Gmail, imported two emails, accepted facts, hit one stale fact version and
listed open questions. It asked for a ninth tool call, met the limit of
eight (G8, 0007, raised from 6 to 8 in sprint 8) and ended with "I stopped
before finishing. Check the cards above." The limit is now 12 tool calls
per turn. The turn's token cap (80,000) still bounds the cost.
