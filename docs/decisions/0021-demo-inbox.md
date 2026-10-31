# 0021: A shared demo Gmail and Calendar for judges

Status: the shared demo connection itself is Jeff's (2026-10-31, through
the server coordinator's sprint 19 handoff). Choices marked (proposed) are
the writer's and wait for Jeff. Every rule of 0012, 0016 to 0018 and 0020
stands, except where this record says otherwise.

Code: `src/google/demo.ts` (new), `src/google/connection.ts`,
`src/google/calendar.ts`, `src/google/gmail.ts`, `src/google/tools.ts`,
`src/google/http.ts`, `src/hosted/config.ts`, `src/hosted/store.ts`,
`src/model/providers/secrets.ts`, `src/agent/agent.ts`, `server/hosted.ts`,
`server/workspace.ts`, `server/google.ts`, `server/api.ts`,
`scripts/admin.ts`, `ui/pages/Settings.tsx`, `ui/contract.ts`. Tests:
`test/sprint19-demo-inbox.test.ts` and `ui/pages/sprint19.test.ts` (new).

## Why: Jeff's decision

Jeff, 2026-10-31: "The agent should have access to Gmail for use of the
messages", and Google Calendar. On the public site the app is judges only
(0020, K7). The Google project is in testing mode with two made-up test
users, and Jeff will not go back into Google's console (0020, K1). So
judges cannot connect their own Google. Jeff approved one shared demo
connection: every judge's agent works against the made-up Dana account's
Gmail and Calendar, live, with no Google screen for the judge.

What this rests on:

- The Google client already lists
  `https://the-little-ai-co.tail374dd0.ts.net:10000/auth/google/callback`,
  the public site's own callback. So the hosted instance can run Google's
  normal consent there with no console change.
- In testing mode a consent lasts 7 days, then the refresh token stops
  working (`docs/google.md`, "Limits of testing mode"). The connection has
  to be renewable by Jeff in one step.
- The Gmail and Calendar code (0012, 0016 to 0018) assumed one connection
  per server for one person. Hosted mode has one workspace per account.

## D1. One shared connection, hosted only

`APP_DEMO_GOOGLE=on` turns it on. It is read only in hosted mode, default
off, and any value but `on` or `off` stops the app at start. It needs
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: without them the start log
says the demo is off.

The connection is an ordinary `GoogleConnection` (0012) in its own secrets
file, `hosted/demo-google.sqlite` beside the accounts database: the same
`SecretsStore` file rules (mode 600, owner check, no symbolic link,
`BEGIN IMMEDIATE` transactions), the same `google` row, and the same
refresh and reconnect logic. The file also keeps the waiting connect flow
(`google_demo_flow`) and pending calendar cleanups (`google_demo_cleanup`).
(proposed: a file of its own rather than a row of the accounts database,
so the admin command and the server share it the way the app and the MCP
server share `app-secrets.sqlite`.)

## D2. Connect, status and disconnect from the admin command

- `pnpm admin google demo-connect [--email <address>]` prints Google's
  authorize URL for the existing scopes (`openid email gmail.readonly
  calendar.events`), with PKCE S256, `access_type=offline` and
  `prompt=consent`. The redirect URI is `BETTER_AUTH_URL` plus
  `/auth/google/callback`. The flow (verifier, nonce, redirect URI) is
  stored in the demo file with only a SHA-256 of the state, and expires
  after 10 minutes. A newer demo-connect replaces a waiting one.
- The server's `/auth/google/callback` first asks whether the state is the
  waiting demo flow's. If it is, it takes the flow in one transaction, so
  the state works once, and finishes the connect with no app session: a
  plain page says it connected. Any other state goes on to the account's
  own connect as before, which still needs the session and the flow
  cookie. Nothing else can finish a demo connect: only the holder of the
  printed link has the state. (proposed: no browser cookie binds the demo
  flow, since the command runs on the server and the link is opened in
  Jeff's browser. The single-use state, its 10 minutes and PKCE are the
  guard.)
- `--email` refuses any other Google account at the callback, and revokes
  its grant (`wrong_account`). (proposed)
- Running demo-connect again renews the consent in place. The same Google
  account's old token is not revoked, as in 0012.
- `pnpm admin google demo-status` says connected, needs reconnecting or
  not connected, the account's email, when it was connected, and when
  Google ends the consent: the connect time plus 7 days. Never a token.
- `pnpm admin google demo-disconnect` revokes the grant at Google and
  deletes it, even when Google cannot be reached, and drops a waiting
  link.
- The command refuses to run unless the instance's accounts database is
  already in `APP_DB`'s folder, so a wrong `APP_DB` never makes a
  connection the site does not read. (proposed)

## D3. Who uses it

On the hosted site with `APP_DEMO_GOOGLE=on`, each workspace's tools see an
`AccountGoogle`: the account's own connection when it has one (connected,
or needing a reconnect), and the shared one otherwise. That covers
`gmail_search`, `gmail_import`, Add it, `calendar_list`, the clash checks'
calendar read (`check_calendar`, `get_schedule`), `calendar_sync_slot`,
`calendar_remove_slot` and their Undo. Connect and Disconnect in
Connections still act on the account's own connection only. An account
that connected its own Google (a test user) keeps it, and its events go
to its own calendar with no account mark.

While the account uses the shared connection, the tools are offered even
when the shared connection is not connected, so a tool can say that it
needs reconnecting (D7). (proposed)

## D4. Gmail stays read-only, and offers stay with their account

Searches and imports read the demo inbox with the same read-only scope
and query as 0012. The keys of the shared connection start with
`shared:` (the Gmail account in 0018's offers, the calendar account in
undo records and intents), so nothing made with it matches an own
connection of the same Google account. Offers, imported messages and
their activity live in each account's own workspace, so one judge never
sees or adds another judge's offers.

## D5. Calendar isolation

Every event the app writes for an account in the shared calendar carries,
beside 0017's case mark, the account's mark: `apptOwner`, the first 32
hex characters of a SHA-256 of the account id, never the id itself. It
joins the inputs of the event id, the private properties and the property
lookup. An event counts as the account's only when its mark matches.

A calendar read for the account (the clash checks, `calendar_list`, the
schedule's calendar line and Connections' read count) keeps the calendar's
own events, which the app did not write, and the account's own app
events. It leaves out every other app event: other accounts' and the
local demo's, which have no account mark. Two accounts writing the same
slot get two events with different ids, and each sees only its own.
Undo of another account's event is refused (`google_not_app_event`).

Outside the shared calendar an event with an account mark is not the
app's either, so the local demo never adopts or changes a judge's event.

## D6. Limits on the shared calendar

- At most 5 live app events per account (`MAX_LIVE_EVENTS`). A write that
  would add a sixth, a create or an Undo that puts an event back, is
  refused before it reaches Google: "Each account can keep at most 5
  events in the shared demo calendar, so this one was not added. Undo or
  remove one first. Nothing was added." Counted at Google by the
  account's mark.
- The per-turn Google read budget of 0016 (8 reads a turn) applies as
  before.
- 20 creates and updates per account in 10 minutes (`WRITE_LIMIT`), in
  memory. A remove is never limited, so cleaning up always works.
  (proposed: the numbers.)
- Delete case and Delete account remove the account's events at Google.
  If Google cannot be reached, a cleanup is kept (the account's mark and
  the time), and the sweep finishes it. Delete case still succeeds.
- The sweep runs at start and every hour while the shared connection is
  connected. It removes app events with an account mark whose account is
  deleted, whose judge code expired or was revoked (a judge sign-in
  account), that are older than 7 days by Google's `created` time, or that
  a pending cleanup names. It never touches an event without an account
  mark. It logs counts only. (proposed: an event made after a Delete case
  stays, and 7 days from creation.)

## D7. Expiry and failure

When the shared connection is expired or revoked, its errors become
`google_demo_reconnect`: "The demo Gmail and Calendar need reconnecting by
the site's owner, so the assistant cannot use them just now. Everything
else still works: paste a message, or load a calendar file." The rest of
the app works: the demo case, pasting and the calendar file.

`demo-status` and the start log show when the consent ends. Connections
shows one quiet line, "Demo Gmail and Calendar: a made-up account shared
by judges", with connected or needs reconnecting, and the calendar's last
read when connected. Never the address. A judge sees no Connect or
Disconnect, and the server refuses a judge's Connect (403,
`connect_not_offered`) while the demo is on. (proposed: an email account,
such as a test user, still sees Connect under the line.)

## D8. Saying it is shared

Connections says: "The inbox and calendar belong to a made-up person and
are shared with other judges, so add nothing private there." Settings'
"About this app" says the app reads only the demo inbox, and Delete case
says the case's demo calendar events went with it. While an account uses
the shared connection, each chat turn's instructions add: "The Gmail
inbox and Google Calendar here belong to a made-up person and are shared
with other judges. When you use them, say so, and tell the person not to
add anything private there."

## D9. Logs and privacy

No token, email address, subject or body in a log. The callback logs
"Demo Gmail and Calendar connected." or the failure code. Delete case,
Delete account and the sweep log counts. The page never receives the
shared account's address.

## D10. Local mode is unchanged

Local mode never reads `APP_DEMO_GOOGLE`, and its Google connection, MCP
server and calendar behave as before. Its app events carry no account
mark, so hosted accounts never see them in the shared calendar.

## Rules that stay

J12 no recorded answers. The agent never sends a reply or an email and
never deletes the case. Every action is logged and undoable. Email text is
untrusted and labeled. No key, token, code, session or secret anywhere
visible. Synthetic people only. The server key serves only entitled
accounts. Gmail read-only, Calendar events only.
