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
  Every color, space and radius outside the token block is a token, and
  a test fails on a raw color or a raw spacing value there.
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
  97.7 KB gzipped (was 111.7 KB), and the build fails above 100 KB.
- P19. Long transcripts. Finished turns out of view use
  `content-visibility: auto` with a remembered block size. Typing renders
  the composer only (its text is in a small store), a finished turn is
  memoized, and the thread reads layout once per frame in
  `requestAnimationFrame`.
- P20. The live poll asks every 2 seconds while a turn or an undo runs
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
  accounting: the 97.7 KB counts the scripts index.html loads. The cards
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
| First-load JavaScript, gzipped | 111.7 KB, 1 file | 97.7 KB, 2 files |
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
`format` chunk 8.6 (the 97.7 above, as `scripts/precompress.ts` counts
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
