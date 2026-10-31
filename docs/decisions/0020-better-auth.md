# 0020: Accounts through Better Auth, and a hosted app that works end to end

Status: K1 to K5 are Jeff's (2026-10-30, through the server coordinator's
sprint 18 handoff and its correction the same day). K6 to K9 are Jeff's
(2026-10-31, during fix round 1). Choices marked
(proposed) are the writer's and wait for Jeff. This replaces 0014's J16
(sign-in with Google) and the Cloudflare part of J17. Every other rule of
0014 stands.

Code: `src/hosted/auth.ts` (new), `src/hosted/db-file.ts` (new),
`src/hosted/store.ts`, `src/hosted/config.ts`, `src/hosted/rate-limit.ts`,
`server/hosted.ts`, `server/main.ts`, `server/request-log.ts`,
`scripts/admin.ts`, `scripts/scan-secrets.ts`, `scripts/hosted/start.sh`
(new), `scripts/hosted/appointments-hosted.service` (new), `.env.schema`,
`ui/hosted/SignIn.tsx`, `ui/hosted/session.ts`, `ui/shell/AccountMenu.tsx`,
`ui/shell/Sidebar.tsx`, `ui/App.tsx`. Removed: `src/hosted/signin.ts` and
its test. Tests: `test/hosted-better-auth.test.ts` (new),
`test/webauthn-soft.ts` (new), and every other `test/hosted-*.test.ts`
now signs in through Better Auth.

## Why: Jeff's decisions

- **K1.** Jeff will not go through Google's console again ("I don't want
  to use Google's process, I hate their interface"). Putting the site on a
  public address with Sign in with Google would need new redirect URIs
  there. So hosted accounts no longer sign in with Google.
- **K2.** Jeff chose Better Auth instead, and signed up for its dashboard.
  He wants "the actual Better Auth stuff to work and the agent fully
  functional".
- **K3.** The site goes live somewhere people can use it. The public
  address is `https://the-little-ai-co.tail374dd0.ts.net:10000`: Tailscale
  Funnel on port 10000, proxying to `127.0.0.1:5300`. Funnel's ports 443
  and 8443 on this server are taken (443 by Jeff's Hermes dashboard).
  Jeff registered that URL in the Better Auth dashboard, with the API path
  `/api/auth`.
- **K4.** The secrets are Jeff's. He enters them himself, and they live in
  a separate env file on the server that the coordinator loads at go-live.
  No writer reads or prints that file.
- **K5.** Going live, the `tailscale funnel` command and installing the
  unit, is the coordinator's step after Jeff's approval. The writer
  changes no Tailscale configuration.
- **K6.** The Better Auth dashboard plugin stays off for the hackathon.
  `BETTER_AUTH_API_KEY` stays unset at go-live, and the docs say it is off
  by default. It comes back only "if deemed worthy" later (B7).
- **K7.** At launch, judges get in with their judge codes only. One
  setting, `APP_PUBLIC_SIGNUP`, off by default. While it is off, email
  sign-up is refused on the server, the sign-in screen leads with "I have
  a judge code", "Make an account" is not shown, and email and password
  sign-in and passkeys stay for accounts that already exist, made with
  `pnpm admin users create`, through a small "Sign in to an existing
  account" link. With it on, everything works as before (B9a).
- **K8.** The product's name is Kept. Final. Nothing is renamed in this
  sprint. The coordinator renames after sprints 17 and 18 merge.
- **K9.** The public goes to a marketing page with a waitlist, and the
  app stays judges only. While `APP_PUBLIC_SIGNUP` is off, the sign-in
  screen shows "Not a judge? Kept is coming soon. Join the waitlist."
  under the judge code form, linked to `APP_WAITLIST_URL`, a new optional
  setting the coordinator fills in with the here.now page. Unset, the
  line is hidden (B9a).

## B1. Better Auth on node:sqlite

- Better Auth 1.7.14 runs on Node's built-in `node:sqlite` (`DatabaseSync`,
  through Better Auth's own Kysely dialect for it). Its file is
  `data/hosted/auth.sqlite`, beside `accounts.sqlite`, with the same
  checks (`src/hosted/db-file.ts`, now shared with the accounts store):
  mode 600, owned by the app's user, a regular file and never a symbolic
  link, before and after the open. WAL, a 5 second busy timeout, and
  foreign keys on, so deleting a user deletes its sessions, password and
  passkeys.
- Better Auth's migrations run at every start (`getMigrations`). A
  database that cannot be brought up to date stops the app with exit
  code 2 and a sentence that names the file only.
- Its handler is mounted with `better-auth/node`'s `toNodeHandler` at
  `/api/auth/*`, in hosted mode only. Local mode is unchanged and has no
  accounts.
- The app's own provider routes under `/api/auth` stay the app's:
  `/api/auth/meta-key` and `/api/auth/chatgpt/*` are refused in hosted
  mode with their own sentences, as before (`isBetterAuthPath`).
- (proposed) A separate file, not tables in `accounts.sqlite`: the
  dashboard plugin can read and write every table Better Auth knows
  (below), and it never learns of the credits ledger or the judge codes.
- Better Auth's telemetry is off (`telemetry: { enabled: false }`, and it
  is off by default too).

## B2. Email and password

- Sign-up and sign-in with an email and a password of 10 to 128
  characters, hashed by Better Auth (scrypt). (proposed: 128, Better
  Auth's default upper bound.) A new account is signed in at once.
- No email verification and no password reset email: the site has no
  mail service. Known limit. A person who forgets their password asks the
  coordinator, who runs
  `pnpm admin users reset-password --email <email>`. It sets a new random
  password (20 characters), prints it once, and ends every session of that
  account. Its passkeys keep working. `pnpm admin users list` shows each
  account's email, when it was made and how many passkeys it has.
- Better Auth's routes are an allowlist (fix round 1, item 4,
  `authRouteServed`): email sign-in and sign-up, the session read, and the
  passkey routes, plus `dash/*` only while the dashboard plugin is on.
  Every other path under `/api/auth` answers 404 before Better Auth sees
  it, so a route a later version or plugin adds is never served by
  accident. Behind it, Better Auth's own `DISABLED_PATHS` also refuses
  social sign-in, account linking, email change, password change and
  reset, email verification, session lists and revokes, user update and
  delete (the app's Delete account does that), passkey rename, and its
  own sign-out (item 1: the page signs out through the app, which ends a
  judge session too). Better Auth matches that list as literal paths, so
  the two entries with a parameter, `/callback/:id` and
  `/reset-password/:token`, are refused by a small plugin
  (`disabledPatterns`). Found by the fix round's test of every entry.
  (proposed: password change waits for a sprint that adds its page.)
- Rate limits, both on:
  - Better Auth's own, on, with its defaults: 3 sign-in or sign-up tries
    per address in 10 seconds, 100 requests per address a minute on
    every other route. Kept in memory per app instance.
  - The app's own, per address, on top (proposed): 20 sign-in tries
    (password or passkey) in 10 minutes, 10 sign-ups an hour, and judge
    codes as before, 10 in 15 minutes.
  - Both see the visitor's address as the app's trusted-proxy rules give
    it (B11). The app writes it into `x-appt-client-address` after
    removing any copy a client sent, and Better Auth reads that header
    only.

## B3. Passkeys

- Better Auth's passkey plugin is the package `@better-auth/passkey`,
  pinned at 1.7.14 (new: better-auth 1.7.14 no longer ships it). Its
  import path is `@better-auth/passkey`. The page uses
  `@simplewebauthn/browser` 13.3.0 (new, pinned, the version the plugin
  already depends on) for the browser's passkey prompt.
- The relying party ID is the public origin's host name without the port,
  `the-little-ai-co.tail374dd0.ts.net`. The expected origin is the public
  origin with its port, `https://the-little-ai-co.tail374dd0.ts.net:10000`.
  Both come from `BETTER_AUTH_URL`.
- Adding a passkey needs a session younger than a day (Better Auth's fresh
  session rule). The account menu has "Add a passkey" for an email account.
  "Use a passkey" on the sign-in screen signs in with a passkey alone.
- No attestation is asked for (`none`), and user verification is
  preferred.

## B4. Google is no longer an account sign-in

- Removed: `POST /api/session/google`, `/auth/signin/callback`, the
  `GoogleSignIn` flow and its key cache (`src/hosted/signin.ts`), the
  button and its error sentences on the sign-in screen, the
  `googleSignIn` field of the session view, and the Sign in with Google
  redirect URI from the start log.
- Kept as it was: the Gmail and Calendar connection for test accounts
  (0012), with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The start log
  still prints its redirect URIs when a Google client is set.
- An account made with Google before 0020 keeps its row and ledger
  (kind `google`), but cannot sign in. There were no public Google
  accounts: hosted mode never went live.

## B5. Better Auth's user and the app's account

The mapping (proposed):

- `accounts` gains `auth_user`, the Better Auth user id, unique, and the
  kind `user`. A database from before 0020 is rebuilt once, in one
  transaction with foreign keys off, keeping every row, because SQLite
  cannot change a CHECK.
- The app's account is made the first time the app sees a Better Auth
  session for a user it does not know (`AccountsStore.userAccount`), in
  one `BEGIN IMMEDIATE` transaction, and its email and name follow Better
  Auth's after that. Nothing else of Better Auth's is kept in
  `accounts.sqlite`. One account per user, one workspace per account.
- Every request reads the session in this order: Better Auth's session
  cookie, then a judge code's own session cookie (both forms, `__Host-`
  first, as before). A cookie Better Auth refreshes is set on the answer.
- Judge codes: a code still signs in on its own (kind `judge`). An email
  account adds a code at sign-up (the sign-up form's optional field, sent
  right after the account is made) or later from Usage. Each account
  takes one code, each code grants its cap once, a code added to an email
  account no longer signs in on its own, and revoke and expiry work as in
  0014. A failed code at sign-up leaves the account made and says so.
- Credits, holds, the 3 times metering, the daily and total caps,
  `account_busy` and the store's single transaction rules are unchanged.
- Delete account claims the workspace (refusing with `account_busy` while
  a step runs, before anything changes), revokes the Google grant, removes
  the workspace, closes the account in `accounts.sqlite`, then deletes the
  Better Auth user, which takes its password, passkeys and every session
  with it, and clears both cookies. The email may sign up again as a new,
  empty account.
- A user deleted outside the app, such as from Better Auth's dashboard,
  closes its app account too (Better Auth's user delete hook). If its
  workspace is busy just then, the account is closed and the workspace's
  files stay until removed by hand, with a log line that names no one.
- Sign-out ends both kinds of session and clears both cookies. A judge
  code sign-in ends a Better Auth session the browser had. An email or
  passkey sign-in, or a sign-up, that succeeds ends the browser's judge
  session and clears its cookie (fix round 1, item 1), so a shared
  browser never falls back to a judge's account.
- Fix round 1, item 2: every request checks again, as it enters its
  workspace and before any workspace is built, that its account still
  exists and is not deleted. A request that read its session just before
  Delete account finished is answered as signed out, and never makes a
  fresh workspace for the deleted account.
- Fix round 1, item 3: an expired judge code takes no more credit from
  `pnpm admin judges grant`, as it redeems no more.

## B6. Sessions and the origin check

- Better Auth's session cookie: `__Secure-appt.session_token` over HTTPS,
  with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 30 days (proposed,
  as 0014's sessions). On `http://localhost:<port>` for local checks it is
  `appt-<port>.session_token`, without `Secure`, so two instances on one
  host keep their own cookies.
- No session token reaches the page's script: Better Auth's JSON answers
  carry the token for bearer clients, which this site does not have, and
  an after hook removes `token` and `session.token` from every answer.
- The public origin is Better Auth's only trusted origin. Its origin and
  CSRF checks run on every write to `/api/auth/*`, and refuse a request
  whose `Origin` is not the public origin (with its port) with 403
  `INVALID_ORIGIN`, and a cross-site form navigation. Better Auth turns
  these checks off by itself when `NODE_ENV` is `test` or `TEST` is set.
  The app sets `disableOriginCheck: false` and `disableCSRFCheck: false`,
  so they stay on whatever the environment says. Found while testing.
- The app's same-origin guard and app header still run on every other
  `/api` route.
- The app adds what Better Auth leaves to the server on `/api/auth/*`: the
  API security headers, `Cache-Control: no-store`, and a body with a
  stated `Content-Length` of at most 64 KB. A chunked or larger body is
  refused with 413 before Better Auth reads it.

## B7. The dashboard plugin, and Sentinel

- `dash()` from `@better-auth/infra` 0.4.25 is on only when
  `BETTER_AUTH_API_KEY` is set. `BETTER_AUTH_API_URL` and
  `BETTER_AUTH_KV_URL` are optional. The start log says whether it is on,
  never the key.
- What it sends to Better Auth's cloud, read from its source
  (`node_modules/@better-auth/infra/dist/index.mjs`, `dash`,
  `initTrackEvents`, the `events-*` modules), to
  `https://dash.better-auth.com` by default, with the API key:
  - An event for each sign-up, sign-in, failed email sign-in, sign-out,
    session made or revoked, password account linked or changed, user
    deleted, and passkey sign-in or registration (`POST /events/track`).
    Each holds the user's id, email and name, the session id, the login
    method, the browser's user agent, who triggered it, and the visitor's
    IP address (the address the app gives Better Auth, B11). A failed
    email sign-in sends the email that was typed. Never a password, a
    password hash or a session token (tested with a fake key).
  - When the dashboard calls the site: a request for its signing keys
    (`/api/auth/jwks`) and a replay check of each older token
    (`/api/auth/check-jti`).
  - It calls the KV address only when a request carries `X-Request-Id`
    or its cookie, from Better Auth's own browser script. The site does
    not use that script, and the app drops `X-Request-Id` and
    `X-Visitor-Id` from every request before Better Auth sees it.
- What it lets Better Auth's dashboard do on this site: it adds routes
  under `/api/auth/dash/*` that accept a token signed by Better Auth's
  cloud for this API key. Through them the dashboard can list, export,
  make, update, ban and delete users, set a password, end sessions, sign
  in as a user (impersonation), and read and write any table of the
  sign-in database (`/dash/execute-adapter`). It cannot reach
  `accounts.sqlite`: credits, the ledger and judge codes stay out of its
  reach (B1). Without a valid token those routes answer 401 (tested).
  Turning it on is trusting Better Auth's cloud as root over
  `auth.sqlite`: whoever holds a token it signs for this key can read and
  change every user, password hash, passkey and session, and sign in as
  anyone. K6: it stays off for the hackathon. Fix round 1 tests a forged,
  a wrong-key and an expired token, and a token past the replay grace
  period, refused, with no network.
- The privacy line on the sign-in screen says, when the plugin is on,
  that sign-in events, with the email and network address, also go to
  Better Auth.
- Sentinel (`sentinel()`, the same package) checks every sign-in and
  sign-up against Better Auth's hosted security API (`/security/check`,
  breached-password checks, impossible travel and more), one call to
  their cloud per protected request, on the same key. It needs that
  service, and its cost was not shown, so it stays off. Better Auth's own
  rate limits and the app's per-address limits stay on.

## B8. Settings

In `.env.schema` (varlock) and `src/hosted/auth.ts`:

- `BETTER_AUTH_SECRET`, sensitive, required in hosted mode, at least 32
  bytes. Hosted mode does not start without it (exit code 2, a sentence
  that names the setting, never the value).
- `BETTER_AUTH_URL`, the public origin, required in hosted mode: https,
  no path, its port when it has one. `http://localhost:<port>` is allowed
  for local checks. `127.0.0.1` is refused: a passkey needs a host name.
- `BETTER_AUTH_API_KEY`, sensitive, optional, unset at go-live (K6).
  `BETTER_AUTH_API_URL`, `BETTER_AUTH_KV_URL`, optional, https.
- `APP_PUBLIC_SIGNUP`, `on` or `off`, default `off` (K7). Any other value
  stops the app.
- `APP_WAITLIST_URL`, optional, https only (K9). Any other value stops the
  app.

None of them is logged or returned. The secret scan looks for each one
assigned with a value, and for `auth.sqlite` and any copy of it.

## B9. The sign-in screen

Email and password, with sign-in and "Make an account", "Use a passkey",
and "I have a judge code" (and `/judge` opens it, as before). A judge
code may be added at sign-up. Every refusal reads as the page's own plain
sentence, never Better Auth's text. A password or a code is cleared from
the page as soon as it is sent. Built with the existing classes only, for
sprint 17's restyle.

## B9a. Judges only at launch (K7, K9)

- `APP_PUBLIC_SIGNUP` off: the app answers `POST /api/auth/sign-up/email`
  with 403 `signup_closed` and the sentence "New accounts are not open on
  this site yet. Judges, choose I have a judge code.", and Better Auth's
  own sign-up route is disabled too, so no request makes a user. The
  sign-in screen opens on the judge code form, with "Sign in to an
  existing account" as a small link to email and password and "Use a
  passkey", and no "Make an account".
- `pnpm admin users create --email <email> [--name <name>]` makes an
  account with a random password, printed once, for someone who should
  sign in by email while sign-up is off.
- `APP_WAITLIST_URL` set and sign-up off: "Not a judge? Kept is coming
  soon. Join the waitlist." under the judge code form, linking there. The
  page shows the link only for an https address. The session view sends
  no link while sign-up is on.
- Both states are tested through HTTP (`test/sprint18-fix1.test.ts`), and
  the screen in both (`ui/hosted/hosted.test.ts`).

## B10. A hosted instance beside the local demo

`scripts/hosted/start.sh` runs hosted mode on `127.0.0.1:5300`, with its
own data folder (default `~/.local/share/appointments-hosted`, mode 700),
`APP_TRUSTED_PROXY=tailscale`, the request log on and the production
build. It refuses to start without `BETTER_AUTH_SECRET` (32 bytes),
`BETTER_AUTH_URL`, both caps and `MODEL_API_KEY`, and never prints a
value. `scripts/hosted/appointments-hosted.service` is a systemd user
unit for it, not installed. (proposed: `MODEL_API_KEY` is required by the
script, though the app itself starts without it, because the hosted
instance exists to serve the agent.)

## B11. Tailscale Funnel

From Tailscale's source (`ipn/ipnlocal/serve.go`): Serve and Funnel proxy
with Go's `ReverseProxy`, which drops a client's own `X-Forwarded-*`
headers, then set `X-Forwarded-For` to the one address the connection came
from, `X-Forwarded-Proto: https` and `X-Forwarded-Host` to the request's
host. Funnel traffic also gets `Tailscale-Funnel-Request: ?1` and no
identity headers. So:

- `APP_TRUSTED_PROXY=tailscale` trusts `X-Forwarded-For` only on a
  connection from loopback, and only as one plain address. Anything else,
  and every other header, gives the connection's own address.
- HTTPS is trusted from `X-Forwarded-Proto` on a loopback connection, as
  before.
- The public host with its port, `the-little-ai-co.tail374dd0.ts.net:10000`,
  is added to the allowed hosts from `BETTER_AUTH_URL`. The host without
  the port is refused, and so is the origin without the port.

## B12. Backups and logs

- `pnpm admin backup --to <new folder>` copies `accounts.sqlite` and
  `auth.sqlite` with SQLite's `VACUUM INTO`, safe while the app runs, into
  a new folder of mode 700, each file mode 600. It refuses a folder that
  exists.
- The request log is on in the hosted instance (`APP_REQUEST_LOG=1` from
  the start script). It writes the method, the path with every segment
  that is not a route word as `*`, the status and the time: never a body,
  a header, a cookie, a query string, an email, a password or a token.
  Better Auth's route words were added.
- Better Auth's own log lines go through the app's log at warn level and
  up, with every email address replaced by `[email]` and no extra values.

## Known limits

- No password reset by email, and no email verification. While
  `APP_PUBLIC_SIGNUP` is on, anyone may sign up with any email address,
  so an email can be taken by someone else (squatting) and a sign-up can
  learn that an email is in use (enumeration). Accepted for now (fix
  round 1, item 6): public sign-up grants no credit, so it cannot spend
  money, it is off at launch (K7), and a refused sign-up says only "That
  email cannot be used here." (`EMAIL_UNAVAILABLE`), never that an account
  has it. Email sign-in answers the same sentence for a wrong password and
  an unknown email.
- Better Auth keeps session tokens in `auth.sqlite` as they are, not
  hashed, unlike the app's judge sessions. The file is mode 600 and in
  the backups' private folder.
- Rate limit counts live in memory and reset on restart.
- Sign-in is per device: a passkey made on one device works there, or
  wherever the person's passkey manager syncs it.

## Tests

Fix round 1: `test/sprint18-fix1.test.ts` (items 1 to 6, K7, K9) and
`test/sprint18-place-quote.test.ts` (item 8: the reply card's Place field
quotes the place's own words, "our Elm Street office", not the time's
quote, in `src/reply/draft.ts`). Item 7 and K6 are the docs.

`test/hosted-better-auth.test.ts`: sign-up, sign-out, sign-in, a wrong
password, short passwords and repeated emails, disabled routes, the body
limit, the cross-origin refusal (and a cross-site form post), Better
Auth's and the app's rate limits, a passkey added and used to sign in with
a software authenticator (`test/webauthn-soft.ts`), a passkey answer for
another site or origin refused, judge codes on an email account and
revoked, judge sessions beside email sessions, Delete account (user,
password, passkeys and sessions gone), a dashboard deletion, the
`__Secure-` cookie and the port-bound host and origin behind Funnel,
passkeys with the public relying party, Tailscale's address rules, the
dashboard plugin off and on with a fake key (no network), the settings'
refusals, no secret, password, token or email in a log or an answer, an
old accounts database migrated, and the admin reset and backup. Every
other hosted test (credits, ledger, isolation across accounts, judges,
the review rounds) now runs with Better Auth accounts.

## Round 2 lows, closed in sprint 19 (2026-10-31)

- **A request could make a new account during Delete account.** Closing an
  account now keeps a hash of its Better Auth user (`closed_user`, a column
  the accounts database gains at open), and `userAccount` gives a session
  of that user the closed account, never a new one. The session then reads
  as signed out. A new Better Auth user with the same email is a new
  account.
- **`placeWords` gave up at the first occurrence.** It reads every
  occurrence and takes the first that starts and ends on word boundaries:
  "Suite 20 is closed, come to Suite 2" quotes "Suite 2".
- **Tests**: a user deleted through a signed `/api/auth/dash/delete-user`
  request closes the app account and its session reaches nothing, and the
  admin-made password appears exactly once in the command's output. The
  dashboard's `delete-many-users` route deletes through Better Auth's
  adapter without its hooks, so it would leave the app accounts open. The
  plugin is off (K6).
- **The merge with sprint 17**: the session view carries `account.owner`,
  and a signed-in view carries `waitlistUrl`, so the sign-in screen after
  a sign-out shows the waitlist line again. The Better Auth page code is
  its own chunk (0019, "Merged into sprint 19").

Hosted browser check on port 5310: the judge code form first, the
waitlist line, Make an account not offered, sign-up refused on the server
(403), a judge code signs in, sign-out shows the judge form again, an
account made with `pnpm admin users create` signs in, Add a passkey saves
one (a CDP virtual authenticator) and Use a passkey signs the same account
in. 13 of 13 steps pass.
