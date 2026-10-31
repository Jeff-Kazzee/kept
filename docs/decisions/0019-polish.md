# 0019: Design, UX and performance polish

Status: P1 to P20 are the direction of the sprint 17 handoff (2026-10-30),
after Jeff asked to "dramatically polish and improve the app design and UX
and performance". Choices marked (proposed) are the writer's and wait for
Jeff.

The app works. This sprint changes how it looks, reads and performs, not
what the agent does or what code checks. Every grounding, scope, Undo,
read back, approval and Gmail rule of 0012 to 0018 holds. Identity stays:
the dark green outdoors theme, the mountain mark, both themes and the
three-column shell of 0015.

This replaces 0011 V2's system font rule and 0008 W6's "system fonts only".
0008 P2's budget tightens from 150 KB to 100 KB. The rest of 0008, 0011 and
0015 holds.

Code: `ui/styles.css`, `ui/fonts/`, `ui/index.html`, `ui/App.tsx`,
`ui/chat/ChatView.tsx`, `ui/chat/useChat.ts`, `ui/agent/Receipts.tsx`,
`ui/case/ReplyCard.tsx`, `ui/case/readback.ts`, `ui/case/lazyCards.tsx`,
`ui/case/caseCards.ts`, `ui/components/onDemand.tsx`,
`ui/schedule/SchedulePanel.tsx`, `ui/schedule/Agenda.tsx`,
`ui/schedule/CaseTabs.tsx`, `ui/schedule/lazyPanel.tsx`,
`ui/schedule/tabs.ts`, `ui/shell/PageView.tsx`, `ui/pages/shared.tsx`,
`ui/useLiveRefresh.ts`, `ui/layout.ts`, `server/static.ts`,
`server/main.ts`, `scripts/precompress.ts`, and the scripted chat in
`ui/chat/mockStream.ts`. Tests: `ui/sprint17.node.test.ts`,
`ui/useLiveRefresh.test.ts`, `test/static.test.ts` and updates to the
tests that encoded the old structure.

## Direction (the handoff)

Visual system

- P1. Typography. Inter is self-hosted as one variable woff2, the Latin
  subset, 48,256 bytes (47.1 KB), preloaded, `font-display: swap`, with a
  metric-matched fallback face ("Inter Fallback", `size-adjust` and the
  ascent, descent and line gap overrides). The file and its OFL license
  are in `ui/fonts/`. No npm dependency. One display size (30 px, 24 px
  on a phone), body at 15 px, meta at 12 and 13 px, tabular numbers on
  every time.
- P2. Tokens. One spacing scale on a 4 px base (`--s-half` 4 px to
  `--s-8` 64 px, with `--s-px` 2 px for hairline gaps), three surfaces
  (`--surface`, `--surface-2`, `--surface-3`) and three elevations
  (`--elev-1` to `--elev-3`) per theme, one radius scale, one accent with
  `--accent-hover` and `--accent-pressed`, and the state colors of 0011
  U22 plus `--st-clash-*`, each text pair 4.5:1 or more in both themes.
  Outside the token block, every color is a token, and every padding,
  margin, gap and radius above a 2 px hairline is a token. A test fails
  on either. Component dimensions (icon sizes, the 72 px agenda time
  column, the 18 px count badge) are plain lengths and are not checked
  (round 2, finding 7: the wording now says what the test checks).
- P3. Three kinds of card. Quiet is the default: a subtle fill, no border.
  Plain sits on the page. Emphasized has an accent edge, for what needs
  the person: the reply to approve, the own-report question and what
  waits in the schedule. Receipts are rows of one quiet group.
- P4. One inline SVG icon set, one stroke width, one 24 px grid, as
  before.

Chat UX

- P5. A turn reads as one unit. The words lead, the actions sit in one
  receipt group under them, and one quiet line closes the turn: the
  folded steps, "Model output" (or "Scripted"), and the clock time, with
  the full time on hover, for a screen reader, and while keyboard focus
  is anywhere in the turn. Three or more actions fold under one line,
  "4 actions · Added the email from Lantern Hill Clinic, Oct 30, 3:04 PM.,
  and 3 more", that opens with a click or Enter. Each row keeps its own
  Undo. A refused Undo opens the group, so its reason is in view.
- P6. Slot chips show only when an answer states a new or changed time:
  a chip shows when the thread has not shown its slot yet, or showed it
  in another state. The state is the one the chip carried when the answer
  was written. Chips still come from code. They are one compact row.
- P7. A running turn shows a calm live step list. The running step
  breathes (an opacity pulse), and the list folds to "Worked through N
  steps" in the turn's closing line. The send button is Stop, as before.
- P8. The follow-up chips sit in their own row of the composer's area, on
  its solid ground, with a short fade above it. The row is always there,
  so the composer never moves when chips come and go. On a phone the
  chips scroll sideways with edge fades and snap points.
- P9. The empty case: the mark, one display line, one sentence, three
  start cards with icons ("Check my Gmail for appointment changes",
  "Paste a message from the office", "Try the demo"), and one line that
  says whether Google and a model are connected, with Connections.
- P10. The reply card leads the flow: "Reply to the office" with the
  template and time, the field rows with their source, a read back with
  its progress ("3 of 5 checked" and a bar), one primary Approve, and
  "Sending is simulated. Nothing leaves this app." beside it.

Schedule panel

- P11. The agenda keeps sticky day headers, the time column with tabular
  numbers and the colored edge and pill per state. Today is marked with a
  "Today" tag, and a clash shows on both the appointment and the
  calendar event.
- P12. "Waiting for you" is one compact emphasized card: the title, the
  count, a two-line summary written by code ("A question about Friday
  11/13 9:15 AM. A reply to read back: Monday 11/16 1:00 PM."), and the
  items with their actions. "Ask me the question about this" is now "Ask
  about this change".
- P13. Activity is a timeline: the actor's mark on a joining line, the
  sentence, "2 min ago" (the full time on hover and for screen readers),
  and Undo where allowed.

Motion and feel

- P14. Motion tokens: 120, 180 and 260 ms with one easing. Messages and
  receipts fade and rise, sheets and the drawer slide, tabs cross-fade.
  Every animation moves only transform and opacity, and no transition
  touches layout. All of it is off under `prefers-reduced-motion`, the
  skeleton sweep, the spinner and the running step included. A test
  holds each rule.
- P15. The skeleton has the shell's shape, the composer at its foot
  included, and a chat that is still loading shows a quiet placeholder,
  never the welcome.

Mobile

- P16. The composer keeps the safe area and `interactive-widget`, every
  target is 44 px, the schedule sheet's tabs have a clear active state,
  and the sheet has a grab handle with two snap points: it opens full, a
  drag down snaps it to half, a drag down from half closes it, and a drag
  up goes back to full. A tap on the handle still closes it. Nothing
  scrolls sideways, checked at 1440, 820 and 390 px in both themes.

Performance

- P17. In local mode the static server adds `<link rel="preload"
  as="fetch" crossorigin>` for `/api/session`, `/api/state`,
  `/api/settings`, `/api/activity`, `/api/google` and `/api/chat`, so the
  first reads run while the script loads. GET routes need no header, so
  the page's own `fetch` takes the preloaded answer, and the CSP is
  unchanged. The hosted site has none, because its reads need a session.
  `/api/fixtures` loads only when the person opens the demo or the import
  sheet, or once a demo message is in the case.
- P18. Code split. The sidebar's pages (Connections, Agent access,
  Settings, Usage), the sign-in screen, the import sheet, the schedule
  panel and the case's cards load on demand. First-load JavaScript is
  97.8 KB gzipped (was 111.7 KB), and the build fails above 100 KB.
- P19. Long transcripts. Finished turns out of view use
  `content-visibility: auto` with a remembered block size. Typing renders
  the composer only (its text is in a small store), a finished turn is
  memoized, and the thread reads layout once per frame in
  `requestAnimationFrame`.
- P20. Replaced in round 2 (finding 4) by one held read, below. Round 1
  text: the live poll asked every 2 seconds while a turn or an undo ran
  and right after a change, then waits half again as long each quiet
  check, up to 15 seconds. A hidden tab asks nothing and asks once when it
  shows again.

## Writer decisions (proposed)

- P21. The scripted chat plays a demo-length transcript. With the demo
  calendar loaded, "Check my Gmail for appointment changes" adds the two
  demo emails (m1 and m2) as pastes and says it did not search Gmail.
  "Add Monday to my calendar" makes a scripted Google Calendar receipt:
  its words end "Scripted, nothing was written.", it lives in the tab's
  sessionStorage, shows in the activity, and its Undo stays in the tab.
  The scripted chat and these entries are in development and check builds
  only, as before (J12, `test/bundle.test.ts`).
- P22. The scripted chat's module loads with `import()` in those builds,
  so its top-level constants (`src/domain/scope.ts`) no longer reach the
  production bundle as side effects. It cut 2.9 KB of raw script.
- P23. On-demand parts render at once once their chunk is in
  (`onDemand.tsx`), with no Suspense pass, so a card that arrives later
  never flashes its placeholder. The case's cards (facts, question,
  explanation, reply, own report, Checklist and Activity) start loading
  with the page, and the first render of a case that shows one waits for
  them. The panel starts with the page on a laptop, and on a phone or
  tablet when the sheet first opens or the browser is idle. The pages'
  chunk loads when the browser is idle after the first load. Honest
  accounting: the 97.8 KB counts the scripts index.html loads. The cards
  (7.0 KB), the panel (4.4 KB) and their shared chunk (3.5 KB) load right
  after, in parallel with the first reads, when the screen needs them.
- P24. The first render of the case shows the stored chat. The shell
  reads it with the case's first reads (the preload has it), the chat
  hook starts from it, and that render draws the newest six messages.
  The older ones follow in a transition right after the first paint, with
  the view kept where it is in the same commit. The thread opens at its
  end before the first paint.
- P25. On a phone or tablet the schedule sheet mounts the first time it
  opens and stays mounted after. Focus on the sheet's heading waits for
  its chunk, and `focusSoon` now also keeps trying while its target is
  not there yet.
- P26. On a laptop the top bar says how the case stands: "4 appointments ·
  1 waiting for you".
- P27. The fixed decline and code notices are quiet cards (no border).
- P28. The account button's accessible name starts with its visible
  words ("You, This computer, account menu"), for Lighthouse's
  label-content-name-mismatch check.

Not changed, because it would weaken a rule: nothing. The stored chat,
the activity and every route are as they were.

## Measured

Method: the server on 127.0.0.1:5200 with a temporary database, Chrome
156 headless driven through the DevTools protocol, 390 x 844 as a mobile
device, Fast 4G (165 ms latency, 1.01 MB/s down, 169 KB/s up), 4x CPU
slowdown, cache off, dark theme, the median of 5 loads. LCP and CLS are
the browser's `largest-contentful-paint` and `layout-shift` entries.
INP is the longest Event Timing interaction: typing 20 characters in the
composer, and opening the newest facts card after scrolling to it.
"Requests before LCP" counts the document and every resource that
started before LCP. The "before" build is `53ee090` with only the
scripted chat's demo transcript added (`04048e3`).

The production build has no scripted chat, so its transcript is a real
stored chat: the recorded demo story (m1 to m3 pasted, "What is
confirmed?", the Friday clash, the move to Monday, the approval, m4,
"What do I need to bring?") replayed into the database with the test
doubles, as `pnpm demo:check --recorded` does. The 30-turn INP runs on
the check build (`APP_UI_FAKES=1`), which is the same code plus the
scripted chat. Its LCP is not comparable: the scripted chat reads the
case again before it shows its chat, and the old build painted the
welcome first.

| Measure | Before | After |
| --- | --- | --- |
| First-load JavaScript, gzipped | 111.7 KB, 1 file | 97.8 KB, 2 files |
| CSS, gzipped | 10.3 KB | 11.9 KB |
| Production, empty case: LCP | 1,412 ms | 1,308 ms |
| Production, empty case: CLS | 0 | 0 |
| Production, empty case: typing INP | 88 ms | 80 ms |
| Production, 8-turn stored chat: LCP | 2,336 ms | 1,980 ms |
| Production, 8-turn stored chat: CLS | 0.014 | 0 |
| Production, 8-turn stored chat: typing INP | 168 ms | 96 ms |
| Production, 8-turn stored chat: open a facts card INP | 96 ms | 72 ms |
| Check build, 30 turns: typing INP | 208 ms | 112 ms |
| Check build, 30 turns: open a facts card INP | 120 ms | 112 ms |
| Check build, 30 turns: CLS | 0.014 | 0 |
| Requests before LCP (production, stored chat) | 12 | 17 |

Requests before LCP went up on purpose: the six first reads and the font
start with the page, in parallel, instead of one after another after the
script.

Chunks after, gzipped, in KB of 1,024 bytes: entry 89.0 and its shared
`format` chunk 8.6 (97.7 at the measured commit, 97.8 at the final one after P28, as `scripts/precompress.ts` counts
it), case cards 7.0, pages 6.9, panel 4.4, their shared chunk 3.5, import
sheet 1.6, sign-in 1.3, copy button 0.4. Inter: 47.1.

Not met: the LCP target of 1.2 s. The data now arrives while the script
loads, so what is left on a 4x slowed phone is the script's own
evaluation (about 190 ms) and the first render of the case (about 540 ms
for the 8-turn chat before P24, the largest single task in the trace).
Getting under 1.2 s with a long chat would need the first view rendered
on the server or a much smaller first render. Follow-up, not built.

Lighthouse 13.4.1 through the DevTools MCP, production build with the
stored demo chat: accessibility 100, best practices 100, SEO 100, mobile
and desktop. Desktop flagged the account button's name (P28, fixed after
the run).

## Browser check (port 5200, check build)

Each step was run by script and passed:

1. index.html names no page, sheet or card chunk.
2. At 1440 dark, Tab goes from the fold toggle through the sidebar (Case,
   Connections, Agent access, the account) into the case's start cards,
   each with a visible 2 px ring.
3. The demo transcript: the two demo emails, m3, "What is confirmed?",
   the Friday clash (marked on both rows), the answer that opens the
   Monday reply.
4. The reply card's Approve stays off until every field is ticked, and
   the progress reads "0 of 5 checked" then "5 of 5 checked". Approval
   shows "Simulated. Nothing was sent."
5. The calendar receipt, m4, the checklist answer and the clinical
   decline.
6. The Gmail turn's four actions fold under one line. Enter opens it.
   Each undoable row has its own Undo for its own words, and each Undo
   acts on its own action: undoing an email's import was refused with the
   server's reason (its facts were reviewed), shown on that row.
7. The calendar receipt's Undo marks it undone.
8. Connections and Agent access open from the sidebar and Settings from
   the account menu, from the pages' chunk.
9. At 1440, 820 and 390 px, dark and light, nothing scrolls sideways.
10. At 390, the Schedule button opens a modal sheet, full, with focus on
    its heading. A drag down snaps it to half, a drag up back to full,
    and a drag down from half closes it, with focus back on the button.
11. At 390, the menu button opens the drawer with focus on its close
    button, and Escape closes it with focus back on the menu button.
12. Under `prefers-reduced-motion`, a message's animation and a button's
    transition last 0.01 ms.

Screenshots (synthetic data, not committed): `/tmp/sprint17-shots/`,
`before-*` and `after-*` with the same names.

## Round 2 (2026-10-30)

Jeff saw round 1 side by side and asked for more: better performance
still and a higher bar. A design explorer works on fonts and colors
separately, so this round changes no font, color, token value or look.
The token structure stays as it is, so a chosen direction drops in by
replacing token values and the font files.

### The Muse Wonder review of round 1, closed

1. High, a failed chunk. `onDemand` parts now render as an error
   boundary, a Suspense and the part, the same on every render. A chunk
   that fails shows "This part of the page did not load. Check the
   connection, then try again." and Try again in the part's own space,
   and the shell stays. Try again starts a fresh load. A render reads the
   load as it stands, so a chunk that keeps failing is not fetched again
   on every render. The pages, sign-in and the import sheet use the same
   parts, and no bare `lazy()` is left. Tests: a rejecting import shows
   the failure, Try again loads it (`ui/sprint17.node.test.ts`).
2. High, a stale first read. `GET /api/boot` reads the case, the
   settings, the activity, Google and the stored chat together, of one
   live version (read again when the version moved during the reads). The
   page's first render shows it, and its first held live read
   (`?since=<that version>`) answers at once when the case moved, a
   Delete case included, so the page reads again. Local mode preloads only
   `/api/session` and `/api/boot`. `/api/chat` and the activity are no
   longer preloaded on their own. Tests: `test/live.test.ts` (a Delete
   case after the boot read answers the first held read at once) and
   `ui/useLiveRefresh.test.ts` (a page shown at an older generation
   refreshes at once).
3. Medium, a refusal folded away. Each new refused Undo opens its group
   again, even after the person closed it, and brings the reason into
   view. Test: close, refuse, open, close, refuse again.
4. Medium, slow outside changes. The poll is replaced by one held read:
   `GET /api/case/version?since=<generation>.<seq>.<calendar>`, which the
   server holds until the live version differs or 25 s pass, reading it
   every 250 ms (the MCP server writes the same file from its own
   process). The page asks again at once, backs off 1, 2, 4 up to 15 s
   after a failure, polls every 2 s a server that does not hold, drops the
   held read while the tab is hidden, and asks again on showing, `focus`
   and `pageshow`. In hosted mode each check opens the account's
   workspace briefly and asks again whether the session still holds, so a
   held read keeps no workspace open and never blocks Delete account. The
   request log leaves the route out, as before. Idle, the page makes one
   quiet request per 25 s. Measured: an archive written by another client
   showed in the open page 264 ms later.
5. Medium, skipped turns. A turn is skipped only after every turn was laid
   out once, so its measured size is kept (`contain-intrinsic-block-size:
   auto 280px` on every turn, `content-visibility: auto` only once the
   thread is `data-settled`), and never a turn with a reply, a question, an
   explanation, an Add it offer, an own-report question or facts that wait
   (`has-action`), so those stay in the focus order.
6. Medium, focus back from the sheet. It goes through `focusSoon`, which
   waits while the chip is not there yet or still inert.
7. Low, tests. The P2 wording now says what the stylesheet test checks
   (above). The browser check confirms the page's fetch reuses each
   preload: on the production build without the server render, one
   request each for `/api/session` and `/api/boot`, and none for
   `/api/state` or `/api/chat`. The hook's own wiring is tested in a page:
   one held read, dropped when the tab hides, asked again on showing,
   focus and pageshow, one read in flight at a time.
8. Low. The read back count is live text (`role="status"`), the folded
   summary counts actions (entries), and the waiting summary is never
   clamped.

### Writer decisions (proposed)

- P29. The on-demand parts read their chunk with `use()` on a tracked
  promise, so a loaded chunk renders at once and a server render and the
  page's hydration see one structure.
- P30. The server renders the case screen. In local mode with a
  production build, `pnpm build` also builds `dist/ssr/entry-server.js`,
  and the static server renders the case screen to HTML from the boot
  data for the current case, with the data after it as
  `<script id="boot" type="application/json">`. It is data, not code, so
  the CSP's `script-src 'self'` holds. Every `<` and both JSON line
  separators are escaped, so no message can close the block. The page is
  sent `no-store` and compressed as sent. The on-demand parts load before
  the render, so nothing waits during it and React writes no inline
  script. The page hydrates once the parts it shows are in, without a
  top-level await, because those chunks import the page's own chunk. The
  hosted site and the scripted chat render on their own (no account's
  HTML is ever rendered or kept for another), and a render that fails
  falls back to the plain page. Media queries read a laptop while
  hydrating, and the device then answers. The fold, the device zone and
  the online state are read after the first render, and the fold toggle
  is hidden by CSS below laptop width. Both renders draw the newest six
  messages, and the older ones follow in a transition.
- P31. A server-rendered thread opens at its end as a reversed column (a
  browser scrolls one from its end, with no script), with short content
  at the top. The page keeps it until the person scrolls or the thread
  changes, and then leaves it with the view where it was: leaving it at
  hydration would lay the thread out anew and repaint it. What the page
  opens with is not faded in. So a server-rendered page opens at the end
  of its thread. The stop at an answer's start (0017, E3) still applies
  when a turn ends and on a page the browser renders itself.
- P32. The modules the first screen shares with the on-demand chunks go
  in one chunk (`manualChunks` in `vite.config.ts`), not ten small ones.
- P33. The account button's name is its visible words and then "account
  menu" (screen reader text), with the person's words for screen readers
  only when it is folded to the rail.

### Measured, round 2

The same method as round 1: 390 x 844 mobile, Fast 4G, 4x CPU, cache
off, dark, the median of 5 loads, the production build. The 8-turn chat
is the recorded demo story in the database. "Before" is the round 1 end
(`3f90701`).

| Measure | Round 1 end | Round 2 | Target |
| --- | --- | --- | --- |
| Production, 8-turn chat: LCP | 1,980 ms | 848 ms | under 1,000 ms |
| Production, 8-turn chat: CLS | 0 | 0 | 0 |
| Production, 8-turn chat: typing INP | 96 ms | 112 ms | under 50 ms |
| Production, 8-turn chat: open a facts card INP | 72 ms | 80 ms | under 50 ms |
| Production, empty case: LCP | 1,308 ms | 704 ms | under 800 ms |
| Production, empty case: typing INP | 80 ms | 120 ms | under 50 ms |
| Check build, 30 turns: typing INP | 112 ms | 112 ms | under 50 ms |
| Check build, 30 turns: open a facts card INP | 112 ms | 104 ms | under 50 ms |
| Check build, 30 turns: CLS | 0 | 0 | 0 |
| Requests before LCP, 8-turn chat | 17 | 5 | |
| Entry script, gzipped | 97.8 KB | 97.9 KB | |
| Every chunk the first case screen hydrates with, gzipped | 112.5 KB | 113.1 KB | under 80 KB |
| Long tasks after the first paint while idle (after load) | not measured | none in 15 s | none |

Lighthouse 13.4.1 on the server-rendered production page with the stored
chat: accessibility, best practices and SEO 100, mobile and desktop, and
the desktop's agentic browsing audits all pass.

Not met, with the reason:

- INP under 50 ms. Each keystroke runs about 20 ms of script on the 4x
  slowed CPU (the controlled composer renders), and then waits for a
  frame. Typing goes through React state, so a key re-renders the
  composer. Getting under 50 ms would need an uncontrolled composer (its
  value read from the field, rendered only when it turns empty or
  non-empty) and a smaller page to lay out. Follow-up.
- First-load JS under 80 KB. React DOM alone is about 60 KB of the entry.
  The case screen hydrates with the entry (97.9 KB) and the cards, panel,
  their shared and copy button chunks it shows (15.3 KB), 113.1 KB in all. Under 80 KB would need the screen to
  stay static HTML until used, part by part, or a much smaller app.
  Server rendering moved the script off the paint's critical path: the
  page shows the case at 704 to 848 ms whatever the script's size.
- The load itself still has long tasks after the first paint: hydration
  (about 360 ms) and the older turns' transition (about 170 ms), on the
  4x slowed CPU. None while idle after.

### Browser check, round 2

The round 1 check passed again, all 26 steps (check build, port 5200).
On the production build with the server render: hydration logged
nothing to the console at 1440 and 390 px, the composer took text, the
phone got its phone layout after hydration, and no part was rendered
anew by the page (no client-made ids). With scripts off the page showed
the end of the thread. The preload reuse check and the outside-change
check are under findings 7 and 4.

## Round 3 (2026-10-30 and 31)

Jeff chose a mix of the explorer's Dusk and Signal directions, then asked
for "a black and grayish blue, kind of a unique palette", no purple. The
explorer's answer is "Steel" (d3a). The coordinator recommends it over
"Fog" (d3b), which stays in the explorer's folder as the fallback. This
round applies Steel, fixes the Muse Wonder round 2 review and works on the
INP and long-task targets round 2 missed. Behavior is unchanged. The
sign-in screen stays as it is (Steel's tokens reach it, nothing more):
sprint 18 replaces it on another branch.

### P34 (proposed): the Steel look

- Grounds: graphite near-black `#0b0c0d` with a cool steel blue that rises
  with the surfaces (`#131619`, `#1a1f24`, `#242b32`), or a cool off-white
  `#f3f5f7` with the graphite sidebar. The sidebar is night in both themes.
  Your words sit on a plate of brushed steel. Tangerine (`#ff6b2c`, light
  `#ff5a1f`) is the one action color, with night ink on it. The states:
  confirmed emerald, offered cobalt, requested signal yellow, a move rose
  pink, canceled stone, clash red, your calendar cyan, declined steel gray.
- Two signatures, each with one job: the aurora (steel blue to teal to
  amber) on the mark, the welcome line and the running step, where the AI
  is alive, and the spectrum (the states in order as one line) under the
  top bar and across each card that waits for you, where states matter.
- Type: Bricolage Grotesque names places (display,
  25,020 bytes), Instrument Sans is for reading (28,112 bytes, the one
  preloaded file), Martian Mono is for times (9,948 bytes). 63,080 bytes in
  all, self-hosted Latin subsets with their SIL OFL 1.1 licenses in
  `ui/fonts/OFL-*.txt` and metric-matched fallback faces, so the swap moves
  nothing. Inter and its license are gone.
- The explorer's `tokens.css` is the token block, and its `extra.css` is
  folded into the rules it styles (no layer of overrides). Its raw values
  became tokens (`--side-current`, `--mark-inset`, `--bubble-inset`,
  `--led-glow`, `--clash-tint`, `--clash-ring`), and its radii and spaces
  use the scales. `light-dark()` sits on each shadow layer's color, never
  on a whole list, and a test fails on `light-dark(` holding anything but
  two colors.
- The token block is declared on `:root, .sidebar`. A browser resolves
  `light-dark()` inside a token where the token is declared, so the
  sidebar, dark in both themes, would otherwise get tokens resolved for the
  light page (its text was invisible in the light theme until this).
- `ui/theme.ts`, the `theme-color` meta and the manifest use `#0b0c0d` and
  `#f3f5f7`. The app icon is the aurora tile with the mark in ink.
- The contrast guarantee is a test: `ui/contrast.node.test.ts` ports the
  explorer's check with its pair list (`ui/contrast-pairs.json`), 26 pairs
  checked in each theme they apply to, and fails on any pair below its minimum (4.5 for text, 3
  for large display type and icons).
- Changes to earlier choices. P8: the composer's area has no ground of its
  own and no fade. Steel lets the sky show through. It is still a row of
  the chat's column below the thread, never over it, and the test now says
  that. P14: Steel's durations are 120, 200 and 300 ms. The running step
  shows the aurora as a still gradient and breathes (opacity), instead of
  the explorer's sweep, which moved `background-position` and would break
  the transform-and-opacity rule. The welcome's ridge drawing is gone, as
  in the explorer's shots. Out of round 3's performance work: the composer
  has no backdrop blur, since nothing scrolls under it and the blur made
  each key press repaint the page.

### The Muse Wonder review of round 2, closed

1. High, a boot read for the wrong account. The first read lives in
   `ui/boot.ts`, kept for one session owner ("local" or one hosted
   account). `scopeBoot` drops it when the owner changes, a sign-out
   included, and `readBoot` never gives a kept read to another owner. The
   page's own JSON block is read only for "local". Tests: sign-out then
   sign-in as another account in one page, and a kept read refused to
   another owner (`ui/boot.test.ts`).
2. High, a mixed boot read. `bootOf` compares the calendar counter too,
   and after five attempts it returns no boot: the route answers 503
   `boot_unavailable`, the page reads each route on its own, and the
   server render serves the plain page. Tests: a calendar-only move during
   the read takes the reads again, and a case that keeps moving gives no
   boot (`test/live.test.ts`).
3. Medium, the live cursor. It moves only after a refresh succeeded.
   `refresh` returns false on failure, and the channel then keeps the old
   version and backs off. Test in `ui/useLiveRefresh.test.ts`.
4. Medium, skipped turns. Turns are skipped two frames after the whole
   thread rendered, so each was laid out once with its real size. A turn
   with slot chips or an action that can be undone is never skipped, as
   one with a card the person must act on was not. Tests in
   `ui/sprint17.node.test.ts`.
5. Medium, the same refusal again. The shell stamps each refusal with a
   count that only grows (`blockedAt`), and the receipt group reopens on
   it, so the same entry refused with the same words reopens the group.
6. Medium, a stray path. Only `/` is rendered on the server. The rendered
   page is compressed with the async zlib calls. Measured on this server:
   `bootOf` about 49 ms, the render about 44 ms for the 8-turn chat and 31
   ms for 30 turns (both draw the newest six messages).
7. Low, the boundary. It tells a failed load ("did not load. Check the
   connection, then try again.") from a part that loaded but threw ("could
   not be shown."), judged when the error is caught. A load that succeeds
   clears every load failure of its chunk, so siblings come back together.
8. Low, refused encodings. The rendered page uses the q-aware
   `pickEncoding`. A test sends `br;q=0, gzip;q=0` and gets a plain body.
9. Low, real tests. Hostile text (`</script>`, `<!--`, U+2028, U+2029,
   quotes in the office's name, a long subject) goes through the real
   `renderCase` and `bootBlock`. The hosted held read now uses
   `Workspaces.peek`: a look at an open workspace that does not count as
   use and opens none, so the idle sweep still closes a workspace only a
   held tab looks at, and a closed workspace reads as unchanged. Tested
   with a fake clock over two minutes of looks, then a sweep.

### Performance, round 3

- The composer keeps its text in the field, beside a small store. A key
  press renders nothing, not even when the text turns empty or non-empty:
  Send's disabled state follows the text on the element, and the render
  path reads the same emptiness. A test counts React commits while typing
  (none).
- The server renders the phone layout when the browser says it is mobile
  (`Sec-CH-UA-Mobile: ?1`, a default client hint) and names it in the
  boot, so hydration matches and a phone's first screen holds no hidden
  schedule. Hydration runs in a transition and waits only for the chunks
  the screen shows. The older messages join eight at a time, the view
  kept in place at each step.

Method as before (390 x 844, Fast 4G, 4x CPU, cache off, the median of 5,
the production build with the recorded 8-turn chat, the check build for
30 turns), with two refinements. The mobile device now sends a phone's
client hints. Typing INP is the key presses only, and the touch tap that
focuses the field is reported on its own (it used to be a mouse click
inside the typing number), and a facts card opens with a tap. The "round
2 method" column repeats round 2's method exactly, for a like-for-like
comparison. This server ran other jobs during the runs (load average 2 to
6), and one 8-turn run under load measured LCP 944 ms.

| Measure | Round 2 | Round 3, round 2 method | Round 3 | Target |
| --- | --- | --- | --- | --- |
| 8-turn chat: LCP | 848 ms | 776 ms | 684 ms | under 1,000 ms |
| 8-turn chat: CLS | 0 | 0 | 0 | 0 |
| 8-turn chat: typing INP | 112 ms | 112 ms | 72 ms | under 50 ms |
| 8-turn chat: open a facts card INP | 80 ms | 88 ms | 120 ms | under 50 ms |
| 8-turn chat: tap into the composer | | | 120 ms | |
| Empty case: LCP | 704 ms | 640 ms | 616 ms | under 800 ms |
| Empty case: typing INP | 120 ms | 88 ms | 56 ms | under 50 ms |
| 30 turns: typing INP | 112 ms | 104 ms | 64 ms | under 50 ms |
| 30 turns: open a facts card INP | 104 ms | 112 ms | 128 ms | under 50 ms |
| 30 turns: CLS | 0 | 0 | 0 | 0 |
| Requests before LCP, 8-turn chat | 5 | 7 | 7 | |
| Entry script, gzipped | 97.9 KB | | 98.1 KB | |
| CSS, gzipped | 12.0 KB | | 13.0 KB | |

Lighthouse 13.4.1 on the server-rendered production page with the stored
chat: accessibility, best practices and SEO 100, mobile and desktop, every
audit passed.

Long tasks after the first paint (4x CPU): the entry script's evaluation,
about 210 to 280 ms, starts just before the first paint and runs past it.
After it, one task is left on each screen: about 105 ms on the 8-turn chat
and 135 to 190 ms on the empty case, React committing the hydration of the
shell. None while idle after load (15 s observed).

First-screen JavaScript: the entry is 325.7 KB raw and 98.1 KB gzipped.
React DOM, React and the scheduler are 218.7 KB raw of it, about two
thirds, roughly 67 KB gzipped. The app's own first-screen code is about
107 KB raw, roughly 33 KB gzipped (ChatView 26.9 KB raw, App 14.9 KB,
format 9.0 KB, then receipts, the on-demand helper, the composer, the
model picker, the API and the icons, 3 KB or less each). The screen
hydrates with the entry plus the cards (7.0 KB) and their shared chunk
(3.5 KB), and on a laptop the panel (4.4 KB): about 109 KB on a phone and
113 KB on a laptop.

Not met, with the reason:

- INP under 50 ms. Every key after the first is under 16 ms. The first
  key, when the field stops being empty, runs about 5 ms of script and
  then waits about 50 to 70 ms on the browser's frame, a paint that
  includes the thread's off-screen content. The cause was not found this
  round. A tap into the composer (about 105 to 120 ms) and opening a facts
  card (about 120 ms) are rendering frames too, not script: a bare
  textarea types at 16 to 24 ms on the same throttle, so the cost is this
  page's painting.
- No task over 100 ms after the first paint: the hydration commit (105 to
  190 ms) is one task React does not slice.
- First-load JS under 80 KB counting the hydrated chunks. Out of reach
  without replacing React: with React's 67 KB, 80 KB would leave 13 KB for
  the app's own first screen, which now takes about 33 KB.

### Screenshots, round 3

`/tmp/sprint17-shots/steel-*.png` (synthetic data, not committed): the
`after-*` set's views (empty and the demo at 1440, 1280, 820 and 390,
dark and light; activity, checklist, schedule, reply card, drawer and
Connections at 390) plus Settings, Connections, Agent access and the
account menu at 1440 in both themes, the attach menu, a toast, the empty
Schedule, Checklist and Activity tabs at 390 in both themes, a failed part
(error boundary), the load error in both themes, and on the hosted site
the sign-in screen (1440 and 390, both themes) and Usage (1440, both
themes). Checked against the explorer's board.

### Browser check, round 3

The round 1 check passed again with the new look, all 26 steps (check
build, port 5200). On the server-rendered production build: hydration
logged nothing at 1440 and 390 px, a phone got the phone layout, an
archive written by another client showed 180 ms later, and the preloads
were each fetched once with no separate state or chat read.
