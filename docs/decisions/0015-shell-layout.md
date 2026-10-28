# 0015: The agent app shell

Status: L1 to L4 are Jeff's decisions (2026-10-28). S1 to S9 are the
design in the sprint 13B handoff. Z1 on are the writer's choices and are
proposed, pending Jeff.

Sprint 13B gives the web app the shape of an agent app: a left sidebar
for navigation, the account and settings, and the work (the chat and the
schedule) to the right of it.

This supersedes 0008 W1 and W2, and the parts of 0011 that put account and
settings controls in the top bar or the schedule panel (V8's Settings tab,
V10's place, and 0014 design item 6's top bar account menu). The rest of
0008 and 0011 holds.

Code: `ui/shell/` (`shell.ts` the model, `Sidebar.tsx`, `AccountMenu.tsx`,
`Pages.tsx`), `ui/App.tsx`, `ui/pages/Settings.tsx` (moved from
`ui/schedule/`), `ui/schedule/SchedulePanel.tsx`, `ui/styles.css`.

## Jeff's decisions

- L1. The app looks like an agent app. Account, settings and navigation
  sit in a left sidebar. The work, the chat and the schedule, sits to the
  right of it.
- L2. Three columns at laptop width: the sidebar, the chat and the
  schedule panel. Jeff chose this over a sidebar beside one tabbed
  workspace.
- L3. The bottom of the sidebar shows the person: an avatar and a name
  they click to open the account menu.
- L4. The demo recording (sprint 16) waits for this sprint.

## The shell's types

Written before the UI and checked against what `ui/App.tsx` held: a
`PanelTab` of four tabs, `sheetOpen` and `railed` for the schedule, and
`openPanel("settings")` for every way into Settings. Settings and Usage
were places inside the panel, not views of their own.

```ts
type Mode = "local" | "hosted";
type View = "case" | "connections" | "access" | "settings" | "usage";
type SidebarItem = {
  id: "case" | "connections" | "access" | "settings" | "usage" | "theme" | "signout";
  label: string;
  icon: IconName;
  place: "nav" | "account"; // the sidebar's list, or the account menu
  view: View | null;        // Theme and Sign out act where they are
  modes: readonly Mode[];
};
type Person = { initials: string | null; name: string; line: string };
```

`SIDEBAR` is the one registry. `itemsFor(mode, place)` gives the items a
mode shows, and `viewIn(mode, view)` falls back to the case for a view the
mode does not have. The shell keeps `view` beside the schedule's own state
(`tab` with three tabs, `sheetOpen`, `railed`), plus `folded` for the
sidebar and `drawer` for the phone's drawer.

| Item | Place | Opens | Local | Hosted |
| --- | --- | --- | --- | --- |
| Case | nav | the chat and the schedule | yes | yes |
| Connections | nav | Google, the provider and the model | yes | yes |
| Agent access | nav | how an agent connects over MCP | yes | no (Z2) |
| Settings | account | time zone, theme, about, Delete case | yes | yes |
| Usage | account | balance, charges, judge code | no | yes |
| Theme | account | switches in place | yes | yes |
| Sign out | account | signs out in place | no | yes |

## Design

- S1. Laptop, 1024 px and up: the sidebar is fixed on the left, 248 px,
  and folds to a 64 px icon rail. The folded state is kept in this
  browser's localStorage (`appointments-sidebar`), every access in
  try/catch. The chat is the middle column. The schedule panel stays on
  the right at its 0011 width and keeps its own fold to a rail, with three
  tabs: Schedule, Checklist and Activity.
- S2. The sidebar, top to bottom: the mark and the app name, then Case
  (the default view), Connections and Agent access, and the account button
  at the bottom.
- S3. The account button opens a menu: Settings, Usage (hosted), the theme
  switch and Sign out (hosted). On the hosted site the menu also says who
  is signed in and the balance, as 0014's top bar menu did. The top bar
  copy is gone.
- S4. The avatar shows initials from the account name, else the email.
  Local mode has no account: the connected Google email's initials when
  Google is connected, else a person icon, with "You" and "This computer".
  A judge account shows "Judge access" and never its code. Follow-up, not
  built: a Google photo needs the `profile` scope in the Google console and
  the server, and sign-in asks for name and email only (0014 J16).
- S5. A sidebar page opens in the work area, in place of the chat and the
  schedule, with "Back to your case". The case stays mounted under the
  page, hidden and inert, so its chat, scroll position and draft are there
  when the person comes back.
- S6. Tablet, 768 to 1023 px: the sidebar is the icon rail. The schedule
  stays a side sheet opened from the top bar.
- S7. Phone, up to 767 px: a menu button with the avatar at the top left
  opens the sidebar as a modal drawer. Escape, the backdrop and the close
  button close it. While it is open the rest of the page is inert, so
  focus stays inside, and focus goes back to the menu button when it
  closes. It follows the schedule sheet's pattern.
- S8. Settings left the schedule panel's tabs. Every way in moved in the
  same change: the composer's model pill and the setup notice open
  Connections (`openConnections`), the setup toast opens Connections, and
  a credits toast and `openUsage` open Usage. `openSettings` is gone.
- S9. The sidebar's surface is one step darker than the work area in both
  themes (`--sidebar`). The work area's top bar and the schedule panel's
  head share one 56 px line.

W6 holds: no new dependency, system fonts, inline SVG icons, CSS custom
properties, 44 px touch targets, visible focus rings and reduced motion. P2
holds: under 150 KB of JavaScript gzipped on first load.

## Writer decisions (proposed)

- Z1. The handoff names "the Access tab today". There is none: 0011 V13
  removed the Access tab and its grants with sprint 8 (0009 J2). Agent
  access is a new, read-only page: what an agent connected over MCP can
  and cannot do, that its actions show in Activity with Undo (with a
  count and a link to Activity), and how to connect one, from
  `docs/connect-agent.md`, with the path left as a placeholder.
- Z2. Agent access shows in local mode only, because the MCP server
  refuses to start in hosted mode (0014, A4). The registry says so.
- Z3. The handoff says the phone's Chat and Schedule bottom tab bar stays.
  There is none: 0011 U18 replaced it with the bottom sheet opened from the
  top bar. The bottom sheet stays as it is.
- Z4. Settings split by what each part is. Connections holds the model
  provider and the model, and Google. Settings holds the time zone, the
  theme, About this app, Delete case and, on the hosted site, Delete
  account. Usage is its own page on the hosted site.
- Z5. The code-written sentences that named Settings now name the new
  place: the no-provider sentence says "Add one in Connections", the
  credits sentence says "open Usage from your account menu", the ChatGPT
  and Google sign-in errors say Connections, and so do the scripted chat's
  Gmail sentences. The behavior is the same. One place is left as it was:
  the assistant's instructions still tell it to say Google is connected
  "in Settings", because the instructions are part of each recorded chat's
  key, and changing them needs new recordings on the live model. Follow-up
  for the next live session.
- Z6. The work area's top bar shows the view's title as the page's one
  h1 ("Your case", "Connections", ...). The app name sits in the
  sidebar's head.
- Z7. The theme switch in the account menu and the one in Settings are the
  same control, and stay in step through one window event.
- Z8. Opening a view, a page or the case through "Back to your case",
  puts focus on the top bar's heading, which names the view. The heading
  draws no focus ring, because only code focuses it (review C1). Every
  Tab stop keeps its ring.
- Z10. Focus is tried again each frame, up to about half a second
  (`focusSoon` in `ui/layout.ts`), because a sheet or the drawer that just
  opened refuses focus for a frame or two while it slides in. The schedule
  sheet uses it too: it waited two frames, the same wait that left the
  drawer's close button without focus in the browser check.
- Z9. `ui/schedule/Settings.tsx` moved to `ui/pages/Settings.tsx`, because
  it is no longer part of the schedule panel.

## Review round 1 (Muse Wonder and the coordinator)

- R1. The toasts are inert while the phone drawer or the schedule sheet is
  modal, so Tab stays inside the modal. `shellModes` in `shell.ts` says
  which parts are modal and inert, and the shell uses it for every part.
- R2 and R3. The openers (the model pill, the setup notice, Open Usage and
  each toast link) and the account menu are rendered, opened and clicked
  in tests, with recorders in place of the shell's `openView`.
  `ui/test-dom.ts` is a small DOM for these tests, so react-dom renders
  into it with no new dependency (W6). `openersFor(openView)` builds the
  openers the shell gives every part.
- R4. The laptop schedule rail's Schedule button names the waiting count,
  as the sidebar's Case item does.
- C2. The product names no docs path. When the server has no Google
  client, Connections says "Google is not set up on this server yet, so
  it cannot be connected here." The server's Google messages, the Google
  sign-in errors and the scripted chat say the same in plain words, and
  "Connect it in the app's settings" became "Connect it in Connections".
  Agent access no longer names `docs/connect-agent.md`. A test reads every
  page source for a docs path.
- Z11 (C3). The sidebar's fold toggle sits at the left of the work area's
  top bar, where the phone's menu button sits, so "Appointment assistant"
  fits the 248 px head on one line at the items' size (14 px). The rail
  shows the mark in its head.
- C4. The suggestion row above the composer still scrolls sideways (0011,
  U19). A chip cut at the edge fades out over 48 px, and space after the
  last chip lets it scroll clear of the fade.
