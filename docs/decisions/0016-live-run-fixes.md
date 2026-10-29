# 0016: Fixes from the first live Gmail and Calendar run

Status: the items H1 to L3 come from the sprint 13C handoff (2026-10-29).
Choices marked (proposed) are the writer's and wait for Jeff.

On 2026-10-29 a laptop session drove the real flow on the demo: connect
Google, add a "Team standup" event in Google Calendar, have a fictional
clinic send two emails, then ask the chat to import them, check clashes,
draft a reply and put the appointment on the calendar. The clash question
failed and several labels were wrong. This records what was found and
changed.

Code: `src/google/events.ts`, `src/agent/tools.ts`, `server/google.ts`,
`server/api.ts`, `src/reply/office.ts`, `src/reply/draft.ts`,
`src/reply/service.ts`, `src/google/calendar.ts`, `src/actions/service.ts`,
`src/activity/`, `src/case/service.ts`, `ui/pages/Settings.tsx`,
`ui/case/ReplyCard.tsx`, `ui/chat/ChatView.tsx`, `ui/agent/Receipts.tsx`,
`ui/App.tsx`, `ui/styles.css`. Tests: `test/sprint13c-calendar.test.ts`,
`test/sprint13c-office.test.ts`, `test/sprint13c-name.test.ts`,
`ui/pages/sprint13c.test.ts`, and additions to `test/activity.test.ts`,
`ui/case/ReplyCard.test.ts` and `ui/chat/ChatView.test.ts`.

## H1. Clash checks read Google Calendar live enough

Found: `check_calendar` read the case view's copy of the Google events,
which `GoogleCalendarEvents.refresh` fetched at start, after Connect and on
"Read the calendar again". The event was added after the last fetch, so
the copy did not have it.

Changed:

- The events are kept per window of at most 31 days, each with the time it
  was read. A newer window replaces what older ones held for the same days.
  At most four windows are kept.
- Before it answers, `check_calendar` calls `ensure` for its date. When no
  window read in the last 60 seconds covers the date, the app reads the
  case window (31 days from the earliest of today and the appointments)
  when that covers the date, else a window that starts at the date.
  (proposed: 60 seconds, four windows)
- `get_schedule` does the same for the case's dates, so its slot clashes
  are current.
- One read per window per chat turn. Over MCP each call is its own turn.
- A read keeps the 15 second time limit of every Google call. A failed read
  answers with its code only. `check_calendar` then returns
  `ok: false` with "Google Calendar could not be read right now, so the app
  cannot say whether that time is free." and a code-written notice card. It
  leaves out the events, so the answer cannot say the day is free.
  `get_schedule` adds `google_calendar.read: false` and its code.
- The schedule panel reads the case view, which never waits for Google.
  The page's poll (`GET /api/case/version`) starts a background read of the
  case window when the copy is more than 60 seconds old and no read failed
  in that time, one at a time. The live version carries a `calendar`
  counter, so the page reloads when the read lands. (proposed)
- The added output fields appear only with Google Calendar connected, so
  the recorded chats, which have no Google, keep their request keys.

## H2. "Read the calendar again" gives feedback

- `POST /api/google/calendar/refresh` answers `read`: the read's time, the
  count of the person's own events, the window and its length.
  `GET /api/google` adds the same as `calendarRead`, with the last failure
  after the last good read.
- Connections always shows the line: "Read at 6:52 PM, 3 events in the
  next 31 days." When the window does not start today it names its dates.
  Before the first read it says "Google Calendar has not been read yet."
- While it reads, the button says "Reading the calendar…" and is busy. A
  failure shows the server's sentence as a toast, and the line under it
  says "The read at 6:58 PM failed." with a plain reason.

## H3. Time zone source

Found: the first page to load sends its browser's zone when the zone is
still the default, with source "browser". A browser on the server, in UTC,
loaded first. Every device after it read "From this device".

Changed:

- "From this device" shows only when this device's zone is the case's zone.
  Otherwise source "browser" reads "From the first browser that opened the
  app". The settings outlive Delete case, so "the app", not "this case".
- When the zone came from a browser or the default and differs from this
  device's, a notice under the top bar says so with one button, "Use
  America/Denver". It records the zone as set by you. Nothing changes the
  zone without the person pressing it. A zone set by you or the assistant
  shows no notice.
- Delete case keeps settings (the time zone, the provider and model). That
  is right: they belong to the app and this computer, not to the case, and
  the README already says so. Kept as it is. The
  name that signs replies is case data and now lives in the case (M2).

## H4. The calendar event names the office

- The title is the office's name and the state: "Lantern Hill Clinic
  (requested)", "Lantern Hill Clinic (change proposed)", and "Lantern Hill
  Clinic" when confirmed. Without an office name the earlier words stay.
  The state words are code's. The office's name and place come from its
  messages and are shown as given.
- The location is the slot's place, or else the one place the office's
  accepted facts give. Two different places give none. (proposed)
- "Edits only events it created" holds: the change is in `desiredEvent`
  only. An event made before this change is updated at the next sync, with
  Undo, because its title differs.
- The fake Google endpoint stores the sent `status`. A test checks that a
  requested slot's event is sent and stored as `tentative`.

## H5. One readback for both reply cards

The draft shows in the chat and in the schedule panel. Both cards now read
one readback store, so a tick in one shows in the other. It belongs to the
draft as shown (its id, version, text and fields), so a new draft, an edit
or a new version starts it empty. Approval still needs every field. Ticks
are still not saved.

## M1. The greeting names the office

Found: the greeting used the raw Gmail sender, "lantern hill
<address>".

Changed: the office name is the sender's name without any address. A bare
address gives "Hello,". For a Gmail message, when the office's own place
starts with a fuller name holding the sender's words in order, that name
is used: the account "lantern hill" with the place "Lantern Hill Clinic,
400 Elm Street" greets "Hello Lantern Hill Clinic,". A pasted sender is the
name the person's message gave and stays as it is. (proposed)

## M2. Where "Dana Reyes" came from

Found: `server/workspace.ts` and `mcp/main.ts` built the case with
`userName: loadCaseProfile().user_name`, the synthetic profile in
`fixtures/case.json`. Every reply in the product was signed with it, in any
case, before and after Delete case. It was a default, not a demo load.

Changed:

- The app and the MCP server pass no name. `CaseService.userName()` is the
  name a test or an eval passes, else the last `user_name_given` in the
  case's `profile` stream. Delete case erases it with the case.
- Without a name the reply ends "Thank you." and the "Your name" field says
  "Not given yet." with a field and "Sign with this name". Only the person
  can give it (`POST /api/profile/name`). It refuses an address. Giving it
  builds an open, unedited, unsigned draft again with the name, in the same
  write, so the card shows the signed text to read back.
- The activity entry is "Gave the name that signs your replies." without
  the name, like a note's. It cannot be undone: give another name to change
  it. (proposed)
- `pnpm demo:check --recorded`, the evals and the tests still pass the
  fixtures' name to their own case, as a test double. The live
  `demo:check` runs the real app, which signs with no name.

## M3. No raw ids in what the person reads

- Each activity entry keeps its `summary` with the ids, for the log and the
  agents' tool results, and gets a `label` the page shows: "Added from
  Gmail: the email from lantern hill, Oct 28, 6:43 PM." The tool results
  are unchanged, so the recorded chats keep their keys.
- A reply field's source names the message by its sender and time,
  "Sender of the email from lantern hill, Oct 28, 6:43 PM". The readback no
  longer shows evidence ids.
- Chat receipts name the sender without an address.

## M4. "Accepted" at import

Found: the summary "Accepted the offer for Monday…" said a fact was
accepted into the case, and read as the person taking the offer. The line
"Accepted an office request from message …" showed twice because the email
held two requests, and a request's own words are message text, which the
activity log leaves out by design.

Changed: the label says "Recorded the office's offer of Monday 11/16 1:00
PM, from the email from …". A rejected fact is "Left out …". Requests read
"Recorded the office's request (fact 2 of 3) for your checklist, from the
email from …", so two requests of one message differ without their words.

## L1, L2, L3

- L1. A code-written notice in the chat whose action was undone is struck
  through and says "Undone. The activity list shows the undo." It matches
  the turn's activity entry by its summary.
- L2. The "New messages" pill sits in the composer's own row instead of
  floating over the end of the conversation.
- L3. Not changed. The instructions are part of every recorded chat's
  request key, so any change to them needs every recording made again
  live. The calendar steps already show code-written notices with Undo.

## Recordings

No recording needs a live rerecord. Every recorded chat test and
`pnpm demo:check --recorded` pass unchanged. The coordinator's live run
will make new requests with Google connected, which the recordings do not
cover.

## Notes for the coordinator

- A draft open in the demo database from before this change reads "The
  case changed since this draft was made", because its office field's
  source text changed. Discard it and start again.
- An event the earlier version added at Google keeps its old title until
  the next sync of its slot, which updates it with Undo.
