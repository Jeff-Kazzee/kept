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
- U9. Undo of a receipt with several entries undoes them newest first. The
  first sends the activity version the page showed. Each later one sends
  the version read after the previous undo. A refusal stops the run, and
  its reason shows beside the receipt and the Activity row until the next
  undo.
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

## Measured on the production build

Measured 2026-10-28 on the server with a temporary database, in Chrome
through DevTools.

- JavaScript on first load: 93.4 KB gzipped in one file (budget 150 KB).
  CSS: 7.0 KB gzipped. The check build with the fakes: 98.7 KB.
- Lighthouse, production build on this base: accessibility 100, best
  practices 96 (the three 404s of U2), on desktop and mobile.
- Lighthouse, check build where the new routes answer: accessibility 100,
  best practices 100. A snapshot of the filled demo case found one heading
  order issue, fixed by U20.
- Phone trace, 390 px, Slow 4G and 4x CPU slowdown: LCP 1,945 ms, CLS 0.00.
