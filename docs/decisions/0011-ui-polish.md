# 0011: The polished agent UI

Status: proposed, pending Jeff (2026-10-28)

Sprint 9 rebuilds the look of the web app (0008) and turns it into an agent
tool. The agent does the work, and the user watches, steers and undoes. It
works to the contract shared with sprint 8 (agent-first back end, time zone)
and sprint 10 (model providers and sign-in), with the coordinator's additions
for the model picker and Google. V1 to V13 are the design direction Jeff set.
U1 to U20 are choices the writer made while building it.

Code: `ui/contract.ts` (the contract types), `ui/agentApi.ts` (its routes),
`ui/agent/` (shared agent state, receipts, model picker), `ui/dev/fakeBackend.ts`
(the development fake of the new routes), `ui/chat/`, `ui/case/`,
`ui/schedule/`, `ui/components/Menu.tsx`, `ui/styles.css`, `vite.config.ts`.

## Design direction

- V1. A centered chat column, 720 px at most, with generous space.
  Assistant messages are plain text on the page with no bubble. User
  messages sit in a soft rounded bubble on the right.
- V2. A type scale about 1.2 apart with a 1.6 line height, a warm neutral
  palette with one blue accent, 1 px borders, layered shadows only on what
  floats (the composer, menus, sheets, toasts), and 12 to 16 px radii. The
  system font stack stays.
- V3. The composer floats at the bottom: a large rounded field, an attach
  button (calendar file or office message), the model and provider
  indicator with its picker, and a round send button.
- V4. Tool activity shows as quiet lines with a small spinner while a turn
  runs, and folds into one line ("Worked through 3 steps") when it ends.
- V5. What the agent did shows as compact receipts ("Accepted 2 facts from
  Lantern Hill Clinic · Undo"). Claims show as tidy rows with their status
  and Undo, and the quote one click away.
- V6. The reply card stays prominent, with an accent outline. Approving the
  simulated send is the user's alone.
- V7. The empty state has a welcome line, three suggestion chips and "Try
  the demo".
- V8. The schedule panel looks like a calendar: days, a time column, a
  colored edge and pill by state, clash pills, and the checklist, activity
  and settings as calm tabs. It folds to a 64 px rail on a laptop, is a
  side sheet on a tablet and a bottom sheet on a phone.
- V9. Activity is a timeline of every action by the assistant, an external
  agent over MCP or the user, with Undo and the plain reason when Undo is
  refused.
- V10. Settings: the time zone (searchable list, "Use this device's zone"),
  the provider (Meta key, or Sign in with ChatGPT), the model, Google, the
  theme and Delete case.
- V11. Motion of 150 to 200 ms on messages, receipts, menus, sheets and
  tabs, off under `prefers-reduced-motion`.
- V12. Dark mode has its own values: a warm dark neutral, lighter surfaces
  for depth, a lighter accent and state colors tuned for contrast.
- V13. Gone: the pairing screen, the Access tab and grant UI, proposal
  cards, and the per-claim review prompts the agent now handles.

## Writer decisions

- U1. The contract types live in `ui/contract.ts`, because sprint 9 does
  not touch `src/`. `ChatMessage` gains `actions` and `ChatEvent` gains
  `action` there. When sprint 8 adds them to `src/agent/types.ts`, the
  file re-exports them instead.
- U2. A route the server does not have yet answers 404, and the page reads
  that as "not in this build": the default zone (America/Denver), the case
  history in Activity with a note, and "not available in this build yet"
  in Settings. Before sprints 8 and 10 merge, the production build shows
  this. Its three 404s are logged by the browser, which costs 4 points of
  Lighthouse Best Practices until the routes exist.
- U3. The fakes of the new routes and the scripted chat are in development
  builds only. `APP_UI_FAKES=1 pnpm build` makes a check build that has
  them, so the browser check runs on the minified bundle under the strict
  CSP. A plain `pnpm build` sets `import.meta.env.APP_FAKES` to false and
  drops them. `test/bundle.test.ts` checks both markers are absent.
- U4. The fake keeps no key or token. Saving a Meta key records only that a
  key is set. ChatGPT sign-in and Google connect sign in a synthetic account
  and send the page back to `/?mockchat=1&signedIn=chatgpt` or
  `&connected=google`, as the real callbacks do. The fake's ChatGPT model
  list is synthetic ("Standard (sample connection)").
- U5. The scripted chat acts as the agent-first back end will: it imports
  and reads a message, accepts each fact through the existing accept route
  and records each as an activity entry, and for a demo message sets the
  zone to America/Denver as an agent action. With Google connected it adds
  a confirmed time to Google Calendar, removes a canceled one, and "Check
  my email" imports the next demo message as found in Gmail.
- U6. The fake undoes a time zone change, a Google Calendar change and an
  archive. It cannot undo an accepted fact, because the base has no route
  that reverses a review, so it answers `undo_blocked` with a sentence that
  says so. The real undo comes with sprint 8.
- U7. A claims card shows one receipt for the facts the agent decided about
  that message, and each row has its own Undo. A turn's receipts leave out
  the facts of a message whose claims card is in the same turn.
- U8. A fact no one has decided (a message added through the import sheet,
  or the base back end) keeps small Accept and Reject buttons in its row,
  so the case never stalls.
- U9. Undo of a receipt with several entries undoes them newest first,
  sorted in one place (`ui/agent/undo.ts`). The activity is read again
  right before the first undo, each later one sends the version read after
  the one before, and an entry already undone is skipped. One undo runs at
  a time, and Undo waits while a turn streams. A refusal stops the run,
  and its reason shows beside the receipt and the Activity row until the
  next undo.
- U10. The shell reads the case, settings, activity and Google together and
  applies only its latest read, so a refresh started by a card mid-turn
  cannot replace a newer one with older data. An `action` event refreshes
  them, like a `card` event.
- U11. Every time uses the case zone with its short name ("MDT",
  "GMT+1"), from `format.ts` (`shortTime`, `stampTime`, `clockTime`,
  `wallToIso`). When the name and the short name match, as for UTC, it
  shows once. The received time in the import sheet is typed in the case
  zone, and an hour that happens twice is read as the first one.
- U12. On first load with `timezoneSource: "default"` the page sends this
  device's zone once, with the contract's body (`timezone`,
  `expectedVersion`). The body cannot say it came from the browser, so the
  server must set `browser` itself or the contract needs a field. Open for
  sprint 8.
- U13. The provider list is data (`PROVIDERS` in `Settings.tsx`). The
  first entry is the main path and is marked Default. Each later one sits
  under its own "Or ..." line, so a third provider is one more entry. Meta
  is first. Each provider says what it receives. A radio is off until that
  provider is ready (a key, or signed in).
- U14. The model picker shows "Meta · Muse Spark 1.3" with each model's
  cost hint, and the same choice is a select in Settings. In the scripted
  chat the indicator adds "(scripted)", because no model answers.
- U15. Google calendar marks and "From Gmail" come from the activity:
  `calendar_event_added`, `calendar_event_updated`,
  `calendar_event_removed` (target a slot) and `gmail_message_imported`
  (target a message). A message view may also carry `importedFrom:
  "gmail"`. These names are assumed until the Google writer settles them.
- U16. A sign-in address opens only on this origin or over https. Anything
  else is refused before the page navigates.
- U17. Settings' "About this app" now says the app reads email only when
  Google is connected, and only to search for appointment messages. Delete
  case no longer mentions grants. Whether settings and sign-ins survive
  Delete case is for sprints 8 and 10 to say.
- U18. The tab bar on phones is gone: Schedule is a bottom sheet opened
  from the top bar, a modal dialog like the tablet sheet. Escape, the close
  button or the backdrop closes it, and focus goes back to what opened it.
- U19. Suggestions above the composer stay on one line and scroll
  sideways inside it. The page itself never scrolls sideways.
- U20. Absolutely positioned hidden inputs and screen-reader text sit
  inside positioned scrollers (`.thread`, `.panel-body`, `.segmented`), so
  they cannot make the shell taller than the window. The thread has a
  visually hidden "Conversation" heading, so card headings follow in order.

## Second pass: the outdoors look (Jeff, 2026-10-28)

Jeff asked for one look in two modes, dark by default, drawn from forests,
mountains, rivers, creeks, hot springs and wildlife, at a high-end polish.

- U21. Tokens from the outdoors (`styles.css`). Dark, the default: forest
  night ground (#0f1714), evergreen and slate surfaces, granite hairlines,
  birch (#e8ece4) and lichen (#a7b5a6) text. Light: mist and birch-bark
  ground (#f3f2ec), warm stone surfaces, deep moss and moss-gray text.
  River teal is the accent and hot spring turquoise the second color. Every
  text and pill pair was checked at WCAG AA (4.5 or more) in both modes
  with a contrast script before use, and Lighthouse checks the rendered
  pages.
- U22. State pills, each with its words: offered creek blue, requested
  sunrise amber, confirmed moss green, change proposed hot spring
  turquoise with an ochre edge, canceled clay, declined granite.
- U23. Dark is the default. `index.html` starts with `data-theme="dark"`,
  and Settings offers Dark, Light and System. A light choice can show dark
  for a moment on load, because no inline script may run. One theme-color
  meta tag follows the theme in use, so the phone's bar matches either
  mode.
- U24. Identity: a mountain ridge over a river line, inline SVG, in the
  header, the empty state, the error screen and the favicon. A web
  manifest names it as the app icon (SVG, so no image download). The empty
  chat has a wide, very low-contrast ridge and contour drawing with a small
  heron line drawing. The empty Activity tab has a fox. A barely visible
  topographic pattern sits behind the chat in pure CSS (two repeating
  radial gradients), faded out at the bottom and off under
  `prefers-contrast: more` and forced colors. No data URLs, so the CSP
  stays strict.
- U25. Fine print leaves the panels. "Built by code from the accepted
  facts" and the clash assumption sit behind an info button beside
  Appointments, and in Settings, About this app. The checklist and
  Activity notes moved behind info buttons too.
- U26. A claims card is one receipt by default ("Accepted 3 facts · Undo")
  with the facts folded away. Open, each fact is one line ("Thu 11/12
  10:30 AM confirmed · Lantern Hill Clinic · Undo"), and a tap on the line
  shows the status, the quote and the source. The card opens by itself
  when a fact waits for the user. Folded content stays in the page with
  `hidden`, so it is searchable by assistive tech when shown.
- U27. The scripted tag reads "Scripted", with "demo reply, not a model"
  for screen readers and on hover. It shows only in the scripted chat, as
  before. A real chat shows "Model output".
- U28. The model indicator reads "Meta · Muse Spark 1.3" on wide screens
  and "Meta · Spark 1.3" on phones, without "(scripted)".
- U29. The agenda is a compact calendar: a right-aligned time column with
  tabular numbers, a 3 px colored rail per state (the change-proposed rail
  turns ochre at its foot), the place and the state pill, and small
  markers for a clash and a Google Calendar event. The clash sentence is
  in the marker's title and screen-reader text and under Details, with the
  quote, notes, Archive and replies. "Show archived" shows only when
  something is archived.
- U30. Typography: headings at -0.015em (display at -0.025em) with
  balanced wrapping, `text-wrap: pretty` on paragraphs, tabular numbers on
  every time, body at 1.6 and assistant text at 1.65. Provider names and
  agenda times do not wrap.
- U31. Spacing on an 8 px grid (`--s-1` to `--s-8`, with 4 px only for
  tight inner gaps), 16 px card padding everywhere, and the chat column
  and panel tops aligned under one 56 px header.
- U32. Depth per theme. Light: soft layered shadows. Dark: an inset
  highlight, a hairline ring and a faint teal glow instead of black
  shadows. The composer sits on a translucent ground with a 16 px blur
  where supported. Hairlines are alpha borders at 9 to 22 percent.
- U33. Motion: 150 to 220 ms ease-out on messages, receipts (staggered 40
  ms apart), menus, details, sheets and tabs. Each tab opens at its top
  with a short fade. A skeleton with a soft shimmer shows while the case
  loads. The send button morphs into a filled stop square while a turn
  runs. Stop aborts the page's stream, says "You stopped this answer. The
  app may still save what it finished.", puts the text back in the
  composer and reads the chat again. All motion is off under reduced
  motion.
- U34. Details: one icon set at a 1.75 stroke, hover, active and focus
  states on every control, a "New messages" pill when content arrives
  while the thread is scrolled up (smooth scroll, instant under reduced
  motion), a copy button on the reply text (draft and approved), and
  designed loading, error (with Try again) and offline states. The
  offline banner listens to the browser's online and offline events.
- U35. Phone: safe-area insets on the header, thread and composer,
  `interactive-widget=resizes-content` so the composer stays above the
  keyboard, a 44 px drag handle on the bottom sheet (a tap or a downward
  drag closes it), 44 px targets for Undo, the model pill, info buttons
  and fold toggles, and no tab icons, so the tab labels fit.
- U36. The explanation in "Waiting for you" keeps its sources folded, so
  the panel stays an agenda first.

## Review round 1 (Muse, 2fc3063..ae0dd84)

- R1-1 and R1-2. Unpaired browsers and MCP proposals with no screen come
  from the base, which still has pairing and proposals. Resolved by the
  sprint 8 merge, which removes both, and this branch rebases onto it
  before merge. Until then any refused read, an unexpected 401 included,
  shows the reason and a working Try again (`LoadError`).
- R1-3 and R1-4. Undo order, serialization and the fresh read: see U9.
- R1-5. A failed read of settings, activity or Google keeps the last good
  value, so times keep their zone, and a quiet notice says the app shows
  the last settings it read. Only a 404 means the route is missing.
- R1-6. The shell checks that a read is still the latest after every
  wait, the one after Delete case included.
- R1-7. Saving and removing the Meta key and signing out of ChatGPT send
  `expectedVersion` (the settings version). Google disconnect sends the
  connection's `version`, a new field of `GET /api/google`.
- R1-8. The first device-zone send counts as done when it is sent or
  refused for a version. Any other failure is tried again at the next read.
- R1-9. Undo links, tabs, the model pill, info buttons, summaries and the
  new-messages pill have 44 px hit areas at every width.
- R1-10. A menu choice gives focus back to the menu's button before it runs.
- R1-11. Closing the sheet gives focus back to what opened it, such as the
  model pill that opened Settings.
- R1-12. Calendar event and clash titles render as labeled data
  (`UntrustedInline`). The clash marker's own text no longer repeats them.
- R1-13. A wall time the clocks skip is refused after a round trip, and
  the import sheet says to pick a time an hour later.

## On sprint 8's back end (rebased onto `sprint/08-agent-first`)

- U37. The page uses sprint 8's routes for activity, undo, the time zone
  part of the settings and the `action` chat event, and sprint 8's types
  (`src/activity/types.ts`, `ChatMessage.actions`) in place of its own.
  The fakes cover only what is still missing: the provider, model and
  sign-in parts of the settings and `/api/google`. A server that sends no
  model list (`models`) has no provider routes, and Settings says choosing
  a provider is not available in this build. In a development or check
  build, `createHybridBackend` joins the real routes and the fake: the
  real settings with the fake's provider part, and the real activity with
  the fake's Gmail and Google Calendar entries, each undone where it came
  from.
- U38. The scripted chat writes through the routes, so the server logs
  each import, read and accept, and the chat streams those entries as
  actions. Loading the demo calendar sets the demo's zone on the server
  (0009, A14), so the scripted chat no longer sets it.
- U39. The first-load zone call sends `source: "browser"` (0009). This
  closes U12.
- U40. Agent reports the office never confirmed (`unconfirmedEvidenceIds`,
  0009 D1) show on their slot as a muted line, "Reported through an
  external agent, not confirmed", and under Details with the agent's
  words as untrusted text. They never set the slot's state.
- U41. `PASTE_TURN_NOTICE` and `IMPORT_AFTER_ACTION_NOTICE` (0009 D2) show
  as notices written by code, and a `waits_for_person` error shows the
  paste notice.
- U42. Records name an agent by `name` ("the assistant", "an external
  agent"), and old grant records keep their grant name.
- U43. `src/records/types.ts`, sprint 8's shim for the old proposal card,
  is deleted. `ui/case/ProposalCard.tsx` was already gone.

## On sprint 8's round 2 (rebased onto `9eb9a08`)

- U44. The own-report card (`own_report`, 0009 D1'): one line with
  `OWN_REPORT_QUESTION`, the sender and the start of the message as
  labeled data (so two open questions can be told apart), and Yes and No.
  It answers through `POST /api/messages/:id/own-report` with the
  message's version. Answered, it folds to a receipt, "Recorded as your
  own report" or "Not recorded as your own report", with Undo through its
  `own_report_recorded` entry. A Yes on clinical text shows the fixed
  scope decline in the card and changes nothing. While a question is open
  the assistant cannot decide the message's facts, so each open question
  is first in "Waiting for you" and counts there.
- U45. `IMPORT_AFTER_ACTION_NOTICE` is gone. `PASTE_TURN_NOTICE` and
  `waits_for_person` stay notices written by code.
- U46. Agents may answer a question only with a choice that records no
  claim. The page needs no change: a refused answer comes back as a turn
  error or an activity refusal in the server's words.

## On sprint 10's routes (`sprint/09b-real-settings`, from `dev` at `2db4521`)

- U47. The provider, model and sign-in parts of Settings use sprint 10's
  routes, and their fakes are gone. The development fake now covers only
  `/api/google` (sprint 11) and the Gmail and Google Calendar entries the
  scripted chat writes. `providersInBuild` is gone: the server always
  sends the model list.
- U48. The server never switches the provider by itself. A provider that
  lost its key or its ChatGPT sign-in stays the provider, and Settings and
  the composer say it needs setup. With recorded responses the composer
  names the chosen model with "(recorded)".
- U49. Errors: 422 `provider_not_ready` and `unknown_model`, 400
  `invalid_key`, 503 `settings_busy` and the other settings refusals show
  the server's own sentence. A write that meets `settings_busy` with
  `retryable: true` is tried once more. `modelNotice` shows under the
  model choice and in the composer's menu. The sign-out's `notice` shows
  as a toast. A failed ChatGPT sign-in comes back to `?signInError=<code>`
  and shows a plain sentence for the code.
- U50. The default zone is UTC, the server's. Every settings and sign-in
  write states the one `settingsVersion`.

## Measured on the production build

Measured 2026-10-28 on the server with a temporary database, in Chrome
through DevTools.

- JavaScript on first load: 93.4 KB gzipped in one file (budget 150 KB).
  CSS: 7.0 KB gzipped. The check build with the fakes: 98.7 KB. After the
  second pass: 96.2 KB, CSS 8.7 KB, check build 101.6 KB.
- Lighthouse, production build on this base: accessibility 100, best
  practices 96 (the three 404s of U2), on desktop and mobile.
- Lighthouse, check build where the new routes answer: accessibility 100,
  best practices 100. A snapshot of the filled demo case found one heading
  order issue, fixed by U20.
- Phone trace, 390 px, Slow 4G and 4x CPU slowdown: LCP 1,945 ms, CLS 0.00.
  After the second pass, with the whole demo case on the page: LCP 2,216
  ms, CLS 0.00.
- Second pass, Lighthouse snapshots of the filled demo case with every
  fold open, dark and light: accessibility 100, best practices 100.
  Production build on this base: accessibility 100, best practices 96
  (U2), desktop and mobile.
