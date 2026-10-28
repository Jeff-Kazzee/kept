# The hosted site

The app runs in one of two modes. The design and every choice behind it
are in `docs/decisions/0014-accounts-and-credits.md`.

## Modes

- **Local** (the default, `APP_MODE` unset or `local`): the app as it runs
  on your own computer. One case, no sign-in, your Meta key in Settings or
  `MODEL_API_KEY`, and Sign in with ChatGPT. Nothing below applies.
- **Hosted** (`APP_MODE=hosted`): the public site. Each person signs in
  with Google or a judge code and gets a workspace of their own: a case,
  settings and a Google connection that no other account can reach. The
  assistant uses Meta's Muse models on the server's key, paid from the
  person's usage credit. A person's own Meta key is not offered, and Sign
  in with ChatGPT shows as not available here yet, because OpenAI allows
  it only for apps that run on the person's computer for now.

The MCP server runs in local mode only.

## Running hosted mode

```sh
APP_MODE=hosted MODEL_API_KEY=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  APP_DAILY_COST_CAP_USD=<amount> APP_JUDGE_TOTAL_CAP_USD=<amount> \
  APP_ALLOWED_HOSTS=appointments.example.com pnpm start
```

| Setting | Default | What it does |
| --- | --- | --- |
| `APP_MODE` | `local` | `hosted` turns on accounts, sessions, credits and judge codes. |
| `MODEL_API_KEY` | none | The Meta key that usage credits pay for. Without it every assistant step is refused with a plain message. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Sign in with Google, and the Gmail and Calendar connection. Without them only judge codes sign in. |
| `APP_ALLOWED_HOSTS` | none | The site's public host name, for the host check and the HTTPS redirect URIs. |
| `APP_MARKUP` | `3` | What a person pays per unit of model cost. At least 1, at most two decimals. |
| `APP_DAILY_COST_CAP_USD` | none, required | The most the server key may cost in one UTC day, across all accounts. |
| `APP_JUDGE_TOTAL_CAP_USD` | none, required | The most all judge codes together may grant. |
| `APP_SERVER_KEY` | `on` | `off` stops every call on the server key, whatever the balances say. |
| `APP_TRUSTED_PROXY` | `none` | `cloudflare` reads the client's address from `CF-Connecting-IP`, only on a connection from this server, as cloudflared makes. `none` uses the connection's own address, and no forwarding header counts. |

Neither cap has a default (J19). While either is unset the server key is
off: the start log names the missing setting, and every assistant step
answers that Meta usage is paused. A value that does not parse stops the
app at start. Local mode reads none of these settings but `APP_MODE`.

At start the app prints the Google redirect URIs to register in the OAuth
client: `/auth/signin/callback` for sign-in and `/auth/google/callback` for
the Gmail and Calendar connection, on each host. Sign in with Google asks
for `openid email profile` only: the account learns the person's name and
email.

The data lives beside `APP_DB` (default `data/`):

- `data/hosted/accounts.sqlite`: accounts, sessions, the usage ledger and
  judge codes. Mode 600. Session tokens and judge codes are stored as
  hashes only.
- `data/accounts/<account id>/`: one workspace per account, with its own
  `app.sqlite` and `app-secrets.sqlite`.

## Judge codes

Each judge gets a code with a cap. The code signs them in on its own, so
they need no Google account. A judge who signs in with Google can add the
code to that account in Settings, Usage. Each code grants its cap once.

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
  signed out, and its unspent credit is removed. Credit held for a step
  already running is removed as that step finishes, and no new step may
  use it.
- The total cap counts each standing code's cap and what revoked codes
  already spent. A new code or a grant past it is refused.

Judges open the site, choose "I have a judge code", or go straight to
`/judge`. Code tries are limited to 10 per address in 15 minutes, and
Google sign-in starts to 10 per address in 10 minutes. Behind the tunnel,
set `APP_TRUSTED_PROXY=cloudflare`, or every visitor shares the tunnel's
one address.

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

The usage page in Settings shows the balance, each recent charge (a chat
turn is one line with its calls), the $20 and $100 plans (coming soon:
billing waits until after the hackathon) and a rough cost per turn for each model.

## Delete account

Settings, Delete account, erases the account's workspace (its case, chat,
activity, settings and Google connection, after revoking the Google grant)
and every session. It is refused, with nothing changed, while a step of
the account is still running. The ledger keeps its rows for accounting, with the
email, name and Google subject removed.
