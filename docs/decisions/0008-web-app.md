# 0008: The web app (chat and schedule UI)

Status: proposed, pending Jeff (2026-10-28)

This records how sprint 7B builds the web app: the chat beside the
schedule, the cards, the design system, the production build and the host
setting for a private proxy. W1 to W8 and P1 to P3 came with the sprint,
and W9 with a coordinator note. B1 to B18 are choices the writer made
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

The types are in `ui/chat/types.ts`.

## Coordinator decisions

- W1. Laptop (1024 px and up): the chat is the main column and the
  schedule panel is on the right, 38 percent of the width, between 380 and
  600 px. Tablet (768 to 1023 px): the panel is a side sheet opened from
  the top bar, closed with Escape, the close button or the backdrop. Phone
  (up to 767 px): the chat is full screen and a bottom tab bar switches
  between Chat and Schedule. Nothing scrolls sideways at 360 px.
- W2. The schedule panel has five tabs: Schedule, Checklist, Activity,
  Access and Settings.
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
  Schedule view on a phone), scrolls to the appointment and outlines it.
- B4. The mock chat (`ui/chat/mockStream.ts`, `?mockchat=1`) follows the
  contract and its event order, and changes the case only through the
  existing routes: import and read a message, explain a conflict, ask the
  next question. It holds its text to the end and sends it in pieces of
  about 80 characters, and stores a declined message as the fixed
  sentence. Its text
  is written by code from the live case and is tagged "Scripted demo
  reply, not a model". It keeps its chat in the tab's sessionStorage,
  which Delete case or closing the tab clears. A pasted text that matches
  a fixture message is imported with that message's id, sender and time,
  so the recorded extraction applies.
- B5. Without `?mockchat=1`, the page asks `GET /api/chat`. A 404 shows
  "The chat is not available in this build yet" and disables the
  composer. The schedule panel works as before.
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
  assets are never inlined as data URLs.
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
