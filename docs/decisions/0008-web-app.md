# 0008: The web app (chat and schedule UI)

Status: proposed, pending Jeff (2026-10-28)

This records how sprint 7B builds the web app: the chat beside the
schedule, the cards, the design system, the production build and the host
setting for a private proxy. W1 to W8 and P1 to P3 came with the sprint,
and W9 with a coordinator note. B1 to B23 are choices the writer made
while building it. The chat route and the case agent are sprint 7A
(0007). Both work to the chat contract below.

Code: `ui/App.tsx` (shell and layout), `ui/chat/` (thread, composer,
stream reader, chat state, scripted mock), `ui/case/` (cards),
`ui/schedule/` (panel and tabs), `ui/components/` (icons, buttons,
badges, untrusted box), `ui/styles.css` (design system), `ui/format.ts`
(times and error sentences), `server/static.ts` (production serving),
`server/hosts.ts` (host check), `scripts/precompress.ts` (compression and
budget), `vite.config.ts`.

## The chat contract

Shared with 7A. Every `/api/*` route except `POST /api/pair` needs the
paired session cookie. `/api/chat` follows the same rule for POST and GET.

- `POST /api/chat` with `{ "text": string, "expectedVersion": number }`,
  the case generation header and the app header. It answers
  `text/event-stream` with the events `turn.started`, `text.delta`,
  `tool.started`, `tool.finished`, `card`, `facts`, `turn.done` and
  `turn.error`. Error codes include `out_of_scope`, `case_deleted`,
  `stale_edit`, `busy`, `model_unavailable`, `ungrounded` and
  `server_error`.
- Event order, from 0007 (C1 and C4): `turn.started`, then
  `tool.started` and `tool.finished` for each tool with its cards between
  them, then `facts`, then `text.delta` in pieces of about 80 characters,
  then `turn.error` when the turn has a code, then `turn.done`. The agent
  holds the answer text until it passes the checks, so the text can arrive
  in a burst at the end while tools and cards arrive live. A turn refused
  before it starts sends only `turn.error`. A turn that fails after it
  started without storing an answer (`server_error`, `case_deleted` during
  the turn, a busy store) sends `turn.error` with no `turn.done`. When
  `turn.error` comes before `turn.done` (`out_of_scope`, `ungrounded`,
  `model_unavailable`), the text already carries the fixed sentence.
- A declined message is stored as the fixed sentence "Not saved: this
  message asked about health, which this app does not handle.", not as
  the person's words (0007, C2).
- `GET /api/chat` answers `{ "chatVersion": number, "messages": ChatMessage[] }`.
- Cards hold references only (`claims`, `question`, `reply`,
  `explanation`, `proposal`, `notice`). The page renders each from the
  current case view, and every action uses an existing route with that
  entity's expected version. The chat adds no route that changes slot
  state.

The types and fixed sentences are 7A's, in `src/agent/types.ts`. The page
imports them (`ui/chat/types.ts` adds only how it reaches the chat).

Superseded in part by `0019-polish.md` (2026-10-30): W6's "system fonts
only" is now Inter, self-hosted with no dependency, and P2's budget is
100 KB.

## Coordinator decisions

- W1. Laptop (1024 px and up): the chat is the main column and the
  schedule panel is on the right, 38 percent of the width, between 380 and
  600 px. Tablet (768 to 1023 px): the panel is a side sheet opened from
  the top bar, closed with Escape, the close button or the backdrop. Phone
  (up to 767 px): the chat is full screen and a bottom tab bar switches
  between Chat and Schedule. Nothing scrolls sideways at 360 px.
  Superseded by `0015-shell-layout.md` (2026-10-28): a left sidebar sits
  before the chat, the schedule panel keeps this sizing on its right, and
  the phone's tab bar had already become a bottom sheet (0011, U18).
- W2. The schedule panel has five tabs: Schedule, Checklist, Activity,
  Access and Settings. Superseded by `0015-shell-layout.md`: the panel has
  three tabs, Schedule, Checklist and Activity. Settings moved to the
  sidebar's account menu and Connections, and Access was removed earlier
  (0011, V13).
- W3. The thread shows user and assistant messages, streaming text with a
  typing state, a tool line per `tool.started` label, fact chips and
  cards. Assistant text carries a small "Model output" tag. The fixed
  decline has its own style, "Outside this app's scope".
- W4. Cards render from the live case view (see B6 to B9).
- W5. The composer keeps pasted messages intact, sends on Enter and adds a
  line on Shift+Enter, has a calendar file button and offers "Paste a
  message from the office", "What is confirmed?" and "Load the demo" on
  an empty chat.
- W6. CSS custom properties for color, type, spacing, radius and
  elevation. Light and dark themes follow the system, with a manual switch
  in Settings. System fonts only, no web font. Visible focus rings, 44 px
  touch targets, labeled fields with id and name, reduced motion
  respected. Inline SVG icons. No new dependency (see B15).
- W7. The old single-page UI is gone. Its logic moved into the new parts
  and its UI tests moved with it. The pairing screen is kept and
  restyled.
- W8. No raw model JSON on screen. Errors are plain sentences that say
  nothing was saved.
- P1. `pnpm build` writes `dist/ui` and a `.br` and `.gz` copy of each text
  file. `pnpm start` serves it. `pnpm dev` keeps Vite for development.
- P2. Budget: under 150 KB of JavaScript gzipped on first load. The build
  fails above it.
- P3. `APP_ALLOWED_HOSTS` adds host names for a private proxy. The server
  still binds 127.0.0.1.
- W9 (proposed, coordinator, 2026-10-28). The chat checks a whole message
  for clinical words before any model call, so a pasted office message such
  as "Please bring your lab results" gets the scope decline. The decline
  stays (fail closed). The page offers a way through that is not the chat:
  under the decline, "Add this as an office message" opens an import sheet
  (how it came, sender, received time in America/Denver, and the text
  prefilled with the person's message). It posts to the existing
  `/api/messages` route, reads the message through the existing extract
  route, and shows the claims card in the thread from the case view. The
  composer offers the same "Add an office message" at any time, prefilled
  with what is in the composer. The import route's own check applies only
  to a person's own report (`user_report`), which the sheet does not
  offer, so an office message with a clinical word is imported. Its
  extraction keeps to appointment facts, and every fact still waits for
  review.

## Writer decisions

- B1. The Schedule tab starts with "Waiting for you": claims to review,
  agent proposals, the open question and the open reply draft. Every card
  the chat shows can also be acted on here, so nothing is lost when a chat
  card scrolls away or the scripted chat is cleared. The tab shows the
  count of what waits, and so does the phone tab bar.
- B2. The agenda groups appointments by day. Each one shows a state badge
  with a colored dot and words ("Confirmed, change proposed" for a change
  proposal), the source, the place, the quote that set the state, clash
  markers, notes, Archive or Undo archive, and "Reply to the office about
  this time" with the templates that fit. The calendar's own events on the
  same days show as dashed rows marked "Your calendar".
- B3. A fact chip opens the Schedule tab (the side sheet on a tablet, the
  Schedule view on a phone), scrolls to the appointment, outlines it and
  moves focus to it. Focus goes back to the chip when the sheet closes or
  the phone goes back to Chat. A chip names only a slot: its label and
  state come from the live case view, with the state at the time as a
  muted line when it changed. A slot that is gone or archived shows "No
  longer on your schedule" and the chip is disabled (review round 1).
- B4. The mock chat (`ui/chat/mockStream.ts`, `?mockchat=1`) is a
  development tool. Only `pnpm dev` has it: the production bundle is built
  without it and ignores the parameter, because it makes real case writes
  (review round 1). It follows the contract and its event order, and
  changes the case only through the existing routes: import and read a
  message, explain a conflict, ask the next question. It holds its text to
  the end and sends it in pieces of about 80 characters, and stores a
  declined message as the fixed sentence. Its text is written by code from
  the live case and is tagged "Scripted demo reply, not a model". It keeps its chat in the tab's sessionStorage,
  which Delete case or closing the tab clears. A pasted text that matches
  a fixture message is imported with that message's id, sender and time,
  so the recorded extraction applies.
- B5. Without the scripted chat, the page asks `GET /api/chat`. A 404
  shows "The chat is not available in this build yet" and disables the
  message box. The schedule panel and "Add an office message" work as
  before. Only a development build mentions `?mockchat=1` there. The
  message box grows by its `rows` attribute and CSS `field-sizing:
  content`, never by a style written from script.
- B6. A question card shows the reply draft its answer opened, under the
  question, and then the simulated send. The open question and draft also
  show in "Waiting for you".
- B7. The claims card lists the message's claims, each with its quote, its
  origin and accept and reject. "Add a fact by hand" keeps manual entry. A
  message whose extraction failed opens it. "Show the whole message"
  shows the text in an untrusted box. Claims rejected by code checks are
  listed in words, never as model output.
- B8. The reply card keeps the readback rules from sprint 3: every field
  ticked at the current version, edited text labeled, the claim
  confirmation after an edit, and "Simulated. Nothing was sent." after
  approval.
- B9. The template the model picked (`reply.suggestion`) shows as a notice
  in words. Its raw output, which the old panel showed, is no longer on
  screen (W8). The old "Ask the model to pick a template" box is gone,
  because the agent takes that role. The extraction effort select and the
  attempt list are gone too. Extraction runs at the default effort
  (`minimal`).
- B10. "Load the demo" loads the demo calendar when none is loaded and
  puts the first demo message (m1) in the composer. A "Next demo message"
  chip offers m2, m3 and m4 in turn, once nothing waits for review.
- B11. A turn the server did not store stays on screen with its error, and
  its text goes back into the composer. A stored turn is replaced by the
  stored messages. Whether a turn was stored is decided only after the page
  reads `GET /api/chat` again, so a stored `model_unavailable` turn never
  refills the composer. While the text is held, the turn shows its tool
  lines and a typing state, and screen readers hear the running tool's
  label or "The assistant is checking its answer". An `ungrounded` or
  `model_unavailable` turn shows its fixed sentence once, as a notice. A
  decline shows its sentence once, in the decline style.
- B12. Every case time shows in America/Denver with MDT or MST. Chat and
  card headers use "Sun, Nov 1, 1:30 AM MST". The Activity tab and agent
  notes keep "2026-11-01 01:30 MST".
- B13. The theme choice is kept in localStorage under
  `appointments-theme` and holds only the theme name. The page applies it
  when the script runs, so a choice that differs from the system setting
  can show the system theme for a moment on load. No inline script, so the
  Content-Security-Policy stays strict.
- B14. The font stack lists the system UI fonts of each platform and
  common Linux fonts before `system-ui`, because some Linux setups map
  `system-ui` to a monospace font.
- B15. No new dependency. Tailwind was not added: the hand-written CSS is
  5.1 KB gzipped, and Tailwind would add an install and a build step for
  little gain.
- B16. Production headers: `Content-Security-Policy` with `default-src
  'self'`, `script-src 'self'`, `style-src 'self'`, `img-src 'self'`,
  `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`. Also `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`
  same-origin, and a `Permissions-Policy` that turns off camera,
  microphone, location, payment and USB. Vite emits no inline script and
  assets are never inlined as data URLs. Every `/api` response, refused
  hosts and the chat route included, has `X-Content-Type-Options: nosniff`
  and `Content-Security-Policy: default-src 'none'; frame-ancestors
  'none'`, set before routing so a streamed response carries them too.
  The build loader refuses a symlink or any file outside the build root's
  real path, and the start fails with the reason (review round 1).
- B17. The person's words of a declined message are kept in the page's
  memory only, by user message id, so "Add this as an office message" can
  prefill them. They are never written to storage. After a reload the
  sheet opens empty, because the server keeps only the fixed sentence.
  Office messages added through the sheet show their claims card in the
  thread after the chat message that was last when they were added. That
  placement is in the page's memory. After a reload their facts are under
  "Waiting for you" in the Schedule tab.
- B18. The received time in the sheet is typed in America/Denver and sent
  with its offset. An hour that happens twice on 2026-11-01 is read as the
  first one (MDT).

- B19. The Schedule tab offers a conflict that waits for a question when
  none is open: its explanation card (with Explain) and "Ask me the
  question about this", which uses the existing route. The chat usually
  asks it. Without that, the story could not finish when the chat cannot
  answer, as in recorded mode before live chat recordings exist. (J12
  removed the recorded mode, 0013.)
- B20. The page uses the real `/api/chat` (SP7B.8). Answer text arrives
  after the checks, so tool lines and a typing state show while it is
  held. The page takes ids from `turn.started` and `turn.done` and the
  chat version from `turn.done` and `GET /api/chat`, never a count, since
  an import also writes an imported-lines record (0007, R2-10).
- B21. The fixed sentences 7A's code writes in place of an answer
  (`UNGROUNDED_TEXT`, `MODEL_UNAVAILABLE_TEXT`, the limit and malformed
  sentences, `PARTIAL_TEXT`) show as notices tagged "Written by code", in
  the stream and in the stored chat. Notice cards, such as
  `QUESTION_WITHHELD_NOTICE`, carry the same tag. Under
  `MODEL_UNAVAILABLE_TEXT`, and under a turn that failed without an
  answer, "Add this as an office message" opens the import sheet with the
  person's text. The claims card shows the `unknown` channel as "Channel
  not stated", and for a message the chat imported shows "Source
  suggested by the assistant" with the fields it suggested, on the
  message and on each claim, with the whole message open (0007, E1).
- B22. The import sheet recognizes a synthetic demo message by its exact
  text and imports it with the fixture's id, sender, channel and time, as
  the chat did for a pasted fixture message in recorded mode (removed by
  J12, 0013). A demo
  message already in the case shows its claims card instead of a second
  import.
- B23. "Add this as an office message" shows under a scope decline always,
  and under an unavailable or failed answer only when the person's text
  reads as a pasted message (a line break, or 60 characters or more), not
  under a question. While a turn streams, a card event makes the page read
  the case again, so a card about a message the turn just imported renders
  live, and until then it says "Loading the message…" rather than that the
  message is gone. The explanation stays beside the open question in
  "Waiting for you".
- Review round 2 (low): build files are opened once with `O_NOFOLLOW` and
  checked with fstat on that handle. Chips are keyed by slot and position
  and carry their message id and slot key, so focus finds the live chip
  again. On a phone, Escape on the Schedule view goes back to Chat and
  focuses the chip or the Chat tab. The tablet sheet is a modal dialog
  while open (`role="dialog"`, `aria-modal`), the header and the chat are
  inert, and opening it moves focus to its heading. Without field-sizing,
  the message box counts the rows a long line wraps to at the box's width.
  The bundle test scans every emitted file, maps and decompressed copies
  included.

## Host setting (P3)

`APP_ALLOWED_HOSTS=my-box.tailnet-name.ts.net` lets the app answer to that
name, with or without the app's port, and accept a write from
`https://my-box.tailnet-name.ts.net`. An entry that is not a plain host
name, with an optional port, stops the app at start. Any other host is
refused with `forbidden_host`, as before. In development the same names are
passed to Vite's own host check.

The session cookie is marked `Secure` when the pairing request came from an
`https://` page (its `Origin`) or the proxy says `X-Forwarded-Proto: https`.
`Secure` only narrows where the browser sends the cookie, so a forged header
cannot widen access. It stays `HttpOnly` and `SameSite=Strict`.

## Measured on the production build

Measured 2026-10-28 on the server with a temporary database. See the sprint
report for the numbers: the JavaScript on first load, gzipped, and the
Chrome DevTools audit results.
