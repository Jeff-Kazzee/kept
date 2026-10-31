# The hosted site

The app runs in one of two modes. The design and every choice behind it
are in `docs/decisions/0014-accounts-and-credits.md`, accounts through
Better Auth in `docs/decisions/0020-better-auth.md`, and the shared demo
Gmail and Calendar in `docs/decisions/0021-demo-inbox.md`.

## Modes

- **Local** (the default, `APP_MODE` unset or `local`): the app as it runs
  on your own computer. One case, no sign-in, your Meta key in Connections or
  `MODEL_API_KEY`, and Sign in with ChatGPT. Nothing below applies.
- **Hosted** (`APP_MODE=hosted`): the public site. Each person signs in
  with an email and password, a passkey or a judge code, and gets a
  workspace of their own: a case,
  settings and a Google connection that no other account can reach. The
  assistant uses Meta's Muse models on the server's key, paid from the
  person's usage credit. A person's own Meta key is not offered, and Sign
  in with ChatGPT shows as not available here yet, because OpenAI allows
  it only for apps that run on the person's computer for now.

The MCP server runs in local mode only.

## Running hosted mode

The hosted instance runs from `scripts/hosted/start.sh`, beside the local
demo: port 5300 on 127.0.0.1, its own data folder, Tailscale as the
trusted proxy, the request log on, and the production build (`pnpm build`
first). It will not start without `BETTER_AUTH_SECRET` (32 bytes or more),
`BETTER_AUTH_URL`, both caps and `MODEL_API_KEY`, and it never prints a
value. For a check on this computer:

```sh
BETTER_AUTH_SECRET=... BETTER_AUTH_URL=http://localhost:5300 MODEL_API_KEY=... \
  APP_DAILY_COST_CAP_USD=<amount> APP_JUDGE_TOTAL_CAP_USD=<amount> \
  APP_HOSTED_DATA=/tmp/hosted-check scripts/hosted/start.sh
```

| Setting | Default | What it does |
| --- | --- | --- |
| `APP_MODE` | `local` | `hosted` turns on accounts, sessions, credits and judge codes. The start script sets it. |
| `BETTER_AUTH_SECRET` | none, required | Signs the session cookies. At least 32 random bytes, such as `openssl rand -base64 32`. Never logged or returned. |
| `BETTER_AUTH_URL` | none, required | The site's public origin, with its port: `https://the-little-ai-co.tail374dd0.ts.net:10000`. The only trusted origin, the passkey origin, and its host name is the passkey relying party. Its host, with the port, is allowed by the host check. `http://localhost:<port>` for a local check. |
| `BETTER_AUTH_API_KEY` | none, keep it unset | Turns the Better Auth dashboard plugin on. Off without it, and off for the hackathon (0020, K6). See below. |
| `APP_PUBLIC_SIGNUP` | `off` | `on` lets anyone make an account with an email and password. `off`, the launch setting (0020, K7), refuses sign-up on the server: judges come in with their codes, and accounts made with `pnpm admin users create` still sign in. |
| `APP_WAITLIST_URL` | none | An https address, the waitlist on Kept's marketing page (K9). While sign-up is off, the sign-in screen links it under the judge code form: "Not a judge? Kept is coming soon. Join the waitlist." Unset hides the line. |
| `BETTER_AUTH_API_URL`, `BETTER_AUTH_KV_URL` | Better Auth's | The dashboard's addresses, only to change them. |
| `MODEL_API_KEY` | none | The Meta key that usage credits pay for. Without it every assistant step is refused with a plain message. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | The Gmail and Calendar connection for test accounts (0012), and the shared demo connection. Not a sign-in. |
| `APP_DEMO_GOOGLE` | `off` | `on` shares one made-up person's Gmail and Google Calendar with every account that has no Google connection of its own (0021). Needs the Google client. See "The demo Gmail and Calendar" below. |
| `APP_ALLOWED_HOSTS` | none | More host names for the host check. The public origin's host is added on its own. |
| `APP_MARKUP` | `3` | What a person pays per unit of model cost. At least 1, at most two decimals. |
| `APP_DAILY_COST_CAP_USD` | none, required | The most the server key may cost in one UTC day, across all accounts. |
| `APP_JUDGE_TOTAL_CAP_USD` | none, required | The most all judge codes together may grant. |
| `APP_SERVER_KEY` | `on` | `off` stops every call on the server key, whatever the balances say. |
| `APP_TRUSTED_PROXY` | `none` | `tailscale` reads the visitor's address from `X-Forwarded-For`, only on a connection from this server and only as one plain address, as Tailscale serve and Funnel set it. `cloudflare` reads `CF-Connecting-IP` the same way. `none` uses the connection's own address. The start script sets `tailscale`. |
| `APP_HOSTED_DATA` | `~/.local/share/appointments-hosted` | The start script's data folder, mode 700. |

Neither cap has a default (J19). While either is unset the app turns the
server key off, and the start script does not start at all. A value that
does not parse stops the app at start. Local mode reads none of these
settings but `APP_MODE`.

The data lives in the data folder (`APP_DB`'s folder):

- `hosted/auth.sqlite`: Better Auth's users, password hashes, passkeys and
  sessions. Mode 600.
- `hosted/accounts.sqlite`: the app's accounts (each linked to its Better
  Auth user by id), judge sessions, the usage ledger and judge codes. Mode
  600. Judge sessions and codes are stored as hashes only.
- `hosted/demo-google.sqlite`: the shared demo Gmail and Calendar
  connection, its waiting connect link and its calendar cleanups (0021).
  Mode 600.
- `accounts/<account id>/`: one workspace per account, with its own
  `app.sqlite` and `app-secrets.sqlite`.

## Accounts

- **Judges only at launch.** With `APP_PUBLIC_SIGNUP` off, the default,
  the sign-in screen opens on the judge code form, sign-up is refused on
  the server, and "Make an account" is not shown. A small "Sign in to an
  existing account" link leads to email and password and passkeys, for
  accounts the coordinator makes:

  ```sh
  pnpm admin users create --email person@example.com --name "Pat Example"
  ```

  It prints the account's password once.
- **Email and password.** With `APP_PUBLIC_SIGNUP=on`, "Make an account"
  takes an email, an optional name and a password of at least 10
  characters, and signs in at once. There is no email verification and no
  reset email: the site sends no mail. A refused sign-up says only that
  the email cannot be used. A person who forgot their password asks the
  coordinator:

  ```sh
  pnpm admin users list
  pnpm admin users reset-password --email person@example.com
  ```

  `reset-password` prints a new password once and signs that account out
  everywhere. Its passkeys keep working.
- **Passkeys.** After signing in, "Add a passkey" in the account menu
  saves one on the device. "Use a passkey" on the sign-in screen signs in
  with it alone.
- **Judge codes.** As below. A code may also be added in the sign-up form.
- An email or passkey sign-in ends a judge session the browser had, and
  signing out ends both. Better Auth serves only its sign-in, sign-up,
  session and passkey routes here. Every other path under `/api/auth`
  answers 404.
- Better Auth allows 3 sign-in or sign-up tries per address in 10
  seconds. The app adds its own limits per address: 20 sign-in tries in 10
  minutes and 10 sign-ups an hour. Better Auth refuses any write to
  `/api/auth/*` whose origin is not `BETTER_AUTH_URL`.
- The session is an HttpOnly cookie, `__Secure-appt.session_token` over
  HTTPS, `SameSite=Lax`, for 30 days. No answer the page reads holds its
  token.

## The Better Auth dashboard plugin

**Off by default, and off for the hackathon (0020, K6): leave
`BETTER_AUTH_API_KEY` unset at go-live.** It comes back only if Jeff deems
it worthy later. Turning it on means trusting Better Auth's cloud as root
over `auth.sqlite`: whoever holds a token it signs for the key can read and
change every user, password hash, passkey and session, and sign in as
anyone. That is Jeff's decision alone. The start log says whether it is on.
When it is on (read from `@better-auth/infra` 0.4.25's source):

- **What it sends** to `https://dash.better-auth.com`: an event for each
  sign-up, sign-in, failed email sign-in, sign-out, session made or
  ended, password set, passkey sign-in and user deleted, each with the
  user's id, email and name, the session id, the sign-in method, the
  browser's user agent and the visitor's IP address. A failed sign-in
  sends the email that was typed. Never a password, a password hash or a
  session token.
- **What it lets the dashboard do**: routes under `/api/auth/dash/*`
  accept a token signed by Better Auth's cloud for this key. Through them
  the dashboard can list, make, change, ban and delete users, set a
  password, end sessions, sign in as a user, and read and write any table
  of `auth.sqlite`. It cannot reach `accounts.sqlite`, so credits and
  judge codes are out of its reach. A user deleted there loses its app
  account and workspace too.
- The sign-in screen's privacy line says that sign-in events, with the
  email and network address, also go to Better Auth.

Sentinel, Better Auth's abuse protection, is off: it calls Better Auth's
hosted security service on every sign-in, a separate service with a cost
that was not shown. Better Auth's and the app's own rate limits are on.

## Judge codes

Each judge gets a code with a cap. The code signs them in on its own, so
they need no account. A judge with an email account can add the code in
the sign-up form, or later on the Usage page, from the account menu at the
bottom of the sidebar. Each code grants its cap once, and a code added to
an email account no longer signs in on its own.

```sh
pnpm admin judges create --label "Judge Ada" --cap-usd 5 --expires 2026-11-30
pnpm admin judges list
pnpm admin judges grant --id j0123456789ab --usd 2
pnpm admin judges revoke --id j0123456789ab
```

- `create` prints the code once. It is `judge_` and 43 characters. Give it
  to the judge. It is not stored and cannot be shown again. The code works
  through the end of the expiry day, UTC.
- `list` shows each code's id, label, cap, what it spent, its status
  (unused, redeemed, revoked or expired) and expiry, and how much of the
  total cap is committed. Never a code.
- `grant` raises a code's cap. A redeemed code's account gets the credit
  at once.
- `create` and `grant` refuse while `APP_JUDGE_TOTAL_CAP_USD` is unset.
- `revoke` stops a code: it no longer signs in, its judge account is
  signed out, and its unspent credit is removed. While a step that was
  already running holds credit, the code's credit cannot be spent, and
  what is left of it is removed once those steps finish. Other credit on
  the account is never taken.
- The total cap counts each standing code's cap and what revoked codes
  already spent. A new code or a grant past it is refused.

Judges open the site, choose "I have a judge code", or go straight to
`/judge`. Code tries are limited to 10 per address in 15 minutes. Behind
Funnel, `APP_TRUSTED_PROXY=tailscale` (the start script sets it), or every
visitor shares one address. The site counts a request as HTTPS only when a
proxy on this server says so in `X-Forwarded-Proto`, as Tailscale does.

The app keeps the workspaces of recent visitors open, up to 256. When all
of them are busy at once, a new visitor reads that the site is busy and
can try again in a minute.

## The demo Gmail and Calendar

Judges cannot connect their own Google: the Google project is in testing
mode with made-up test users only, and Jeff does not go back into Google's
console. With `APP_DEMO_GOOGLE=on`, the site holds one connection to the
made-up demo Google account, and every account without its own Google
connection uses it: the agent searches and imports from its Gmail (read
only) and reads and writes its Google Calendar, live, with no Google screen
for the judge (`docs/decisions/0021-demo-inbox.md`).

- Each account's calendar events carry that account's mark. An account
  sees the demo calendar's own events and its own app events, never
  another account's or the local demo's.
- At most 5 live app events per account, 20 calendar creates or updates
  per account in 10 minutes, and the usual 8 Google reads per chat turn.
  All accounts together: 400 Google calls in 5 minutes through the shared
  connection, and 30 calendar refreshes a minute. A calendar window read
  is shared by every account for a minute.
- Delete case and Delete account remove the account's events. Every hour,
  and at start, a sweep removes the events of deleted accounts and of
  expired or revoked judge codes, and every app event older than 7 days.
  The local demo's events are never touched. The log shows counts only.
- Connections shows one line, "Demo Gmail and Calendar: a made-up account
  shared by judges", connected or needs reconnecting, and never the
  address. Judges get no Connect or Disconnect. The agent is told the inbox
  and calendar are a made-up person's, shared with other judges.
- When the connection has expired, the agent's Google tools say the demo
  Gmail and Calendar need reconnecting, and the rest of the site works.

The commands, on this server, with the instance's env file and `APP_DB`
(the data folder plus `/app.sqlite`). They need `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` and `BETTER_AUTH_URL`, and refuse a folder with no
accounts database:

```sh
set -a; . <the instance's env file>; set +a
export APP_DB="${APP_HOSTED_DATA:-$HOME/.local/share/appointments-hosted}/app.sqlite"
pnpm admin google demo-connect --email <the demo account's address>
pnpm admin google demo-status
pnpm admin google demo-disconnect
```

`--email` is required. Once a demo account is connected, only that same
Google account can renew it: to change accounts, run `demo-disconnect`
first. The link must be allowed with both Gmail and Calendar checked.

- `demo-connect` prints a link, good once for 10 minutes. Open it in a
  browser signed in as the demo Google account and choose Allow (Google
  says the app is not verified: choose Continue). Google returns to the
  site's `/auth/google/callback`, which stores the connection and shows
  "The demo Gmail and Calendar are connected for every judge." No sign-in
  to the site is needed. With `--email`, any other Google account is
  refused. The site must be running with `APP_DEMO_GOOGLE=on`.
- `demo-status` shows whether it is connected, the account's email, when
  it was connected and when Google ends the consent. The start log shows
  that date too.
- `demo-disconnect` revokes the grant at Google and deletes it here.

**Renew it every 7 days.** In testing mode Google ends the consent 7 days
after it was given, and the connection stops working. Run `demo-connect`
again before the date `demo-status` shows, open the new link as the demo
account and choose Allow. The same connection is renewed in place, and
judges notice nothing. If it lapses, judges read that the demo Gmail and
Calendar need reconnecting until it is renewed.

## How credits are priced

Every model call on the server key is charged at `APP_MARKUP` times its
token cost, from the usage Meta reports. Prices are per million tokens:

| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| Muse Spark 1.3 | $1.25 | $0.15 | $4.25 |
| Muse Wonder 1.0 | $4.00 | $0.20 | $20.00 |

Output is billed from `output_tokens`, which counts the reasoning tokens
inside it. Amounts are kept as whole micro-dollars, and a cost is rounded
up once.

Before each call the app holds the most the call can cost: the request's
size as an upper bound on its input, plus its `max_output_tokens` (4,096
for a JSON step, 8,192 for a chat step), at the person's price. If the
balance cannot cover it, the call is not made, and the person reads that
their credit has run out and how to get more. After the call the app
charges what Meta reported and gives back the rest. A charge never exceeds
its hold. A call that may have run but reported no usage, such as one that
timed out, is charged the whole hold, and so is a usage report the hold
did not bound, such as more output than `max_output_tokens`. A call Meta refused before it ran is not charged. The balance
never goes below zero.

The daily cap counts the real model cost of every charge that day and
every hold still open. When it is reached, or the server key is off, every
step is refused with a plain message and nothing is charged.

The Usage page, from the account menu, shows the balance, each recent charge (a chat
turn is one line with its calls), the $20 and $100 plans (coming soon:
billing waits until after the hackathon) and a rough cost per turn for each model.

## Delete account

Delete account, in Settings from the account menu, erases the account's workspace (its case, chat,
activity, settings and Google connection, after revoking the Google grant,
and its events in the shared demo calendar),
then the Better Auth user with its password, passkeys and every session.
It is refused, with nothing changed, while a step of the account is still
running. The ledger keeps its rows for accounting, with the email and name
removed. The same email may sign up again, as a new, empty account.

## Backups and logs

```sh
pnpm admin backup --to ~/appointments-backups/2026-10-31
```

copies `accounts.sqlite`, `auth.sqlite` and `demo-google.sqlite` (the
shared demo Google connection: a secret, its tokens open the demo Gmail
and Calendar) with SQLite's `VACUUM INTO`,
safe while the app runs, into a new folder of mode 700, each file mode
600. Run it with the instance's `APP_DB` (the start script's data folder
plus `/app.sqlite`). It refuses a folder that already exists. Keep the
backups on this server: they hold emails, password hashes and session
tokens.

The request log is on in the hosted instance: one line per API request
with the method, the path (every value in it as `*`), the status and the
time. Never a body, a header, a cookie, a query string, an email, a
password or a token. Better Auth's own warnings go to the same log, with
every email address replaced by `[email]`.

## Going live

The coordinator's step, after Jeff's approval. The writer changed no
Tailscale configuration.

1. Jeff's env file for the instance, mode 600, outside git, holds
   `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=https://the-little-ai-co.tail374dd0.ts.net:10000`,
   `MODEL_API_KEY`, `APP_DAILY_COST_CAP_USD`, `APP_JUDGE_TOTAL_CAP_USD`,
   `APP_WAITLIST_URL` (the here.now waitlist page), and for the demo Gmail
   and Calendar `APP_DEMO_GOOGLE=on` with `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`. Leave
   `BETTER_AUTH_API_KEY` unset (K6) and `APP_PUBLIC_SIGNUP` unset or `off`
   (K7). Optionally `APP_HOSTED_DATA` and `NODE_BIN` (Node 24 or later, if
   `node` is not on the unit's PATH).
2. In the checkout the unit names: `pnpm install --frozen-lockfile` and
   `pnpm build`.
3. Copy `scripts/hosted/appointments-hosted.service` to
   `~/.config/systemd/user/`, set its `EnvironmentFile` to the env file
   and its paths to the checkout, then
   `systemctl --user daemon-reload` and
   `systemctl --user enable --now appointments-hosted.service`.
   `journalctl --user -u appointments-hosted` shows the start lines: hosted
   mode, the caps, whether the dashboard plugin is on.
4. Check it on this server: `curl -s -H 'Host: the-little-ai-co.tail374dd0.ts.net:10000' http://127.0.0.1:5300/api/session`
   answers `{"mode":"hosted","signedIn":false,...}`.
5. Turn Funnel on for port 10000 to the instance (Tailscale 1.104 on this
   server, with `sudo` unless `jeff` is Tailscale's operator):
   `tailscale funnel --bg --https=10000 http://127.0.0.1:5300`.
   `tailscale funnel status` checks it, and
   `tailscale funnel --https=10000 off` stops only this one. Never
   `tailscale funnel reset`: it would also stop the Hermes dashboard on 443.
6. From outside the tailnet, open the public address: the judge code form
   comes first, with the waitlist line under it. Sign in with a judge code
   made with `pnpm admin judges create`, and check that sign-up answers
   403. For an email account, run `pnpm admin users create` with the
   instance's `APP_DB`, sign in through "Sign in to an existing account",
   and add a passkey.
7. Connect the demo Gmail and Calendar: run
   `pnpm admin google demo-connect --email <the demo account's address>`
   as in "The demo Gmail and Calendar" above, and send Jeff the link it
   prints. It works once, for 10 minutes. Jeff opens it signed in as the
   demo Google account and chooses Allow. Then
   `pnpm admin google demo-status` shows it connected with the date the
   consent ends, and a judge's Connections shows the demo line as
   connected. Set a reminder to renew it (the same steps) before that
   date, every 7 days.

