# Gmail and Google Calendar

The app can use a person's Gmail and Google Calendar in two ways.

1. Through the person's own agent. Agents such as Claude, Grok or ChatGPT
   often have their own Gmail and Calendar connectors. The agent reads the
   email itself and passes each appointment message to this app's MCP
   import tool, and it uses its own calendar connector for the calendar.
   This app adds no Google code for that path. See "Use your agent's own
   connectors" below and `docs/connect-agent.md`.
2. Through the app's built-in Google connection, described here. It reads
   Gmail (read only) for likely appointment emails, reads Google Calendar
   for clash checks, and keeps one calendar event per appointment.

The design and its reasons are in `docs/decisions/0012-google.md`.

## What the built-in connection does

- Gmail, read only. The app searches recent mail for appointment words,
  optionally only from chosen senders, in a window of up to 60 days. Code
  builds the search, never the model. An email becomes the same import a
  pasted message does, with the sender and the sent time taken from the
  email's own headers. It then goes through extraction, the quote check and
  the clinical scope rules, and the person reviews each claim on a card.
  Email text is untrusted data and never an instruction.
- Google Calendar, read. The app lists events in a window, in the case
  time zone, to check for clashes.
- Google Calendar, write. The app adds one event per appointment in the
  calendar you choose (your primary calendar by default): tentative while
  you have only requested it or while a change is proposed, confirmed once
  the office confirms, and removed when it is canceled or declined. It
  edits only events it created. Every change appears in the activity list
  with Undo, which reverses it at Google. If you changed the event in
  Google Calendar after the app wrote it, the app leaves your version and
  says so. If you deleted it there, the app does not add it back until you
  undo the removal or ask the assistant to put it back.
- The assistant in the app and an agent connected over MCP have the same
  Google tools: `gmail_search`, `gmail_import`, `calendar_list`,
  `calendar_sync_slot` and `calendar_remove_slot`. In a chat message that
  may contain a paste, the assistant may import from Gmail but makes no
  calendar change until your next message. The clash checks read the
  Google Calendar events the app last fetched, beside a loaded `.ics`
  file: at start, after Connect, and on
  `POST /api/google/calendar/refresh`. Before the assistant answers a clash
  question, it reads Google again when that copy is more than a minute old
  or does not cover the date, and says so when Google cannot be read
  (`docs/decisions/0016-live-run-fixes.md`, H1). Connections shows when the
  app last read the calendar.

The app asks Google only for the permissions you turn on: Gmail, Calendar,
or both. It also asks for your email address, to show which account is
connected.

## What stays on the server

- The Google client id and secret come from the environment
  (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), loaded through varlock from
  `.env.local`.
- The refresh token is stored in the app's secrets database,
  `data/app-secrets.sqlite` (beside the event log, or beside `APP_DB` if you
  set it), as its own `google` row. That is the same file, mode 600 and
  transactions as the model provider settings (`docs/sign-in.md`). It is
  not in the event log, so it is never part of a case, a Delete case or an
  export. The last short-lived access token is kept there too, so the app
  and an MCP server that share the file refresh it only once.
- No token, secret or email body is written to a log, an error message or
  the browser. The page sees only the status: whether Google is connected,
  the account's email, which permissions are on and the calendar id.

## Setup (Jeff's steps)

These steps create a separate demo Google account and a Google Cloud OAuth
client in testing mode. Use made-up clinic emails and made-up events only.
The Google Cloud console calls the OAuth section "Google Auth Platform" (in
older layouts, "OAuth consent screen"). The names below follow the current
console and may move.

### 1. Create the demo Google account

1. Create a new Google account for the demo, for example
   `appointments.demo.<something>@gmail.com`. Do not use a personal account.
2. From another made-up address, send it a few appointment emails, for
   example a confirmation ("This confirms your appointment on Thursday,
   November 12 at 10:30 AM at Lantern Hill Clinic") and a change ("We need
   to move your visit to Monday, November 16 at 1:00 PM"). The words
   appointment, confirm, reschedule, cancel or reminder help the search
   find them.
3. In its Google Calendar, add one or two made-up events, such as a work
   call on the same day as an appointment, so the clash check has
   something to find.

### 2. Create a Google Cloud project

1. Sign in to <https://console.cloud.google.com> with the demo account (or
   with the account you use for Google Cloud).
2. Open the project picker and choose New project. Name it, for example,
   `appointments-demo`. Billing is not needed for these APIs at demo scale.

### 3. Turn on the Gmail and Calendar APIs

1. In the project, open APIs & Services, then Library.
2. Search for "Gmail API" and choose Enable.
3. Search for "Google Calendar API" and choose Enable.

### 4. Set up the consent screen in testing mode

1. Open Google Auth Platform (APIs & Services, then OAuth consent screen)
   and choose Get started.
2. App information: an app name such as "Appointment change assistant
   (demo)" and the demo account as the user support email.
3. Audience: External.
4. Contact information: your email. Agree to the policy and create.
5. Under Audience, leave the publishing status as Testing. Under Test
   users, choose Add users and add the demo account.
6. Under Data Access, choose Add or remove scopes and add:
   - `openid`
   - `.../auth/userinfo.email`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/calendar.events`

   Save. In testing mode this list documents the scopes. The app still
   asks only for the ones you turn on.

### 5. Create the OAuth client

1. Under Clients, choose Create client.
2. Application type: Web application. Name: `appointments-demo-server`.
3. Authorized JavaScript origins: none.
4. Authorized redirect URIs. Add each address you open the app at, with
   the path `/auth/google/callback`:
   - `http://127.0.0.1:5180/auth/google/callback`
   - `http://localhost:5180/auth/google/callback`
   - for each name in `APP_ALLOWED_HOSTS`, such as a Tailscale serve name:
     `https://<name>/auth/google/callback`

   Use the port you run the app on if it is not 5180. Google allows plain
   `http` only for `localhost` and `127.0.0.1`, so a proxy name must use
   `https`. When the client id is set, the app prints the exact list at
   start ("Google redirect URIs for the OAuth client: ..."). Compare it with
   what you registered.
5. Choose Create. Copy the client id and the client secret. The console
   may show the secret only now, so store it at once (next step) or use
   Download JSON and delete that file after you copy the values.

### 6. Put the id and secret in `.env.local`

On the server, in the app's folder, add two lines to `.env.local` with an
editor. The file is ignored by git. Keep it readable by you only
(`chmod 600 .env.local`).

```sh
GOOGLE_CLIENT_ID=<the client id>
GOOGLE_CLIENT_SECRET=<the client secret>
```

`.env.schema` declares both as optional and sensitive. Never put the values
in git, a chat, a screenshot or a log. Start the app through varlock so it
loads them, for example:

```sh
pnpm exec varlock run -- pnpm dev
```

Check that the start lines include "Google redirect URIs for the OAuth
client". If they do not, the app did not see both values.

### 7. Connect

1. Open the app at one of the registered addresses.
2. In the app's Google settings, turn on Gmail, Calendar or both, and choose
   Connect. The page asks the server for a Google sign-in address
   (`POST /api/google/connect`) and opens it.
3. Sign in with the demo account. Google says the app is not verified,
   because it is in testing mode. Choose Continue.
4. Google lists the permissions with a box for each. Leave the ones you
   want checked. The app reads which ones you granted and turns the rest
   off.
5. Google returns to the app at `/?connected=google`. The settings show the
   account's email and which permissions are on.

If something fails, the app returns to `/?google_error=<code>`. Codes:
`invalid_state` (the sign-in was started in another browser, took more
than 10 minutes, was used twice, or Google was disconnected meanwhile),
`stale_flow` (another connect finished first), `access_denied` (you chose
Cancel),
`no_permission_granted` (every box was unchecked), `code_exchange_failed`
(usually a client secret or redirect URI that does not match),
`google_unavailable`, and the ID token checks (`id_token_audience`,
`id_token_issuer`, `id_token_expired`, `id_token_nonce`,
`email_unverified`). Start Connect again after fixing the cause.

### 8. Disconnect

Choose Disconnect in the app's Google settings
(`POST /api/google/disconnect`). The app revokes the grant at Google and
deletes the token from the secrets database, even when Google cannot
be reached. You can also remove the app's access in the demo account at
<https://myaccount.google.com/permissions>.

## Limits of testing mode

- Up to 100 test users can be listed, and only listed test users can sign
  in. Each sees the unverified-app warning.
- A test user's authorization expires 7 days after consent when the app
  asks for more than the basic identity scopes, and the refresh token
  expires with it. The app then marks the connection as needing a
  reconnect and its Google tools say so. Choose Connect again.
- Google keeps at most 100 refresh tokens per Google account per OAuth
  client and drops the oldest without warning. Each Connect makes a new
  one.
- A refresh token with a Gmail scope stops working when the account's
  password changes.
- A public launch needs Google's verification. `gmail.readonly` is a
  restricted scope: it needs the restricted-scope verification, and
  because this app keeps or sends Gmail data on a server, a security
  assessment as well. `calendar.events` is a sensitive scope and needs
  verification. An unverified app that shows the warning is limited to
  100 users over the project's lifetime.
- Locally, the app holds one Google connection per server, for the one
  person whose case it is. On the hosted site each account has its own,
  and with `APP_DEMO_GOOGLE=on` an account without one uses the shared demo
  connection below.

## The hosted site's shared demo connection

Judges cannot be added as test users without Google's console, so the
hosted site can share one made-up account's Gmail and Calendar with every
account that has no Google connection of its own
(`docs/decisions/0021-demo-inbox.md`, `docs/hosted.md`, "The demo Gmail
and Calendar"). It uses the redirect URI already registered for the
public site, `https://the-little-ai-co.tail374dd0.ts.net:10000/auth/google/callback`,
so the OAuth client needs no change.

- Connect it with `pnpm admin google demo-connect --email <the demo address>`
  on the server (only that account, with both Gmail and Calendar), and open
  the link it prints signed in as the demo account. No app session is
  needed. `pnpm admin google demo-status` shows when the consent ends.
- **Renew it every 7 days**, before that date, with the same command: the
  testing-mode limit above applies to it like any test user's consent.
- `pnpm admin google demo-disconnect` revokes and deletes it.
- Gmail stays read-only. Each account's calendar events carry its own
  mark, each account sees only its own app events, and the site keeps at
  most 5 live events per account and sweeps old ones.

## Use your agent's own connectors

If your agent already has Gmail and Google Calendar connectors, you do not
need the built-in connection.

1. Connect the agent to this app over MCP (`docs/connect-agent.md`).
2. Ask the agent to find the appointment emails with its own Gmail
   connector and to pass each one, with its sender and sent time, to this
   app's MCP import tool. The app extracts the claims and you review them
   in the app, as for a paste.
3. Use the agent's own calendar connector to add or move events. The app
   does not see those changes, so tell it about a change, or paste the
   office's message, to keep the case up to date.

The agent's provider then sees the emails it reads, under that agent's own
terms. Give it only the access you are comfortable with.
