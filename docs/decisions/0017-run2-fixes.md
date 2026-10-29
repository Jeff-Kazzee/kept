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
  first Google Calendar write, inside that write's case command, and Delete
  case erases it with the rest of the case. (proposed: made at the first
  write, not when the case starts, so a case that never touches the
  calendar holds no mark)
- The mark joins the inputs of the event id and is a fourth private
  property, `apptCase`. The property lookup asks for all four. An event
  counts as the case's only when its mark matches.
- A case with no mark yet owns no event. `list` reads the mark after the
  events, so an event the case made while they were read is its own.
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
  `-`, at most 80, no `@`) is written as `*`.
- On by default in local mode, off by default in hosted mode.
  `APP_REQUEST_LOG=1` or `0` turns it on or off. It writes to stdout, so
  the `appt-demo` service's journal holds it.
- For the run 2 question: if the browser shows 503 for a `POST /api/chat`
  whose line here says 200, the 503 came from something between the
  browser and the app, such as a proxy, and not from the app.

## E5. Delete case says it finished

Once Delete case finished the page shows "The case was deleted. Its
messages, facts, replies, chat and activity are erased. Events it added to
Google Calendar stay there." A failed delete shows only its error.

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
  once. The reply's greeting and the event's title keep `officeNameOf`.
  (proposed)
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
- The schedule may still say "On Google Calendar" for an appointment whose
  event the person removed in Google. Seen in the browser check, not
  changed here.
