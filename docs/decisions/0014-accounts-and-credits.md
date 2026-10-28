# 0014: Accounts, judge access and usage credits

Status: proposed, pending Jeff (2026-10-28). J13 to J17 are Jeff's
decisions. A1 to A32 are the writer's choices and are proposed.

Sprint 13 builds the hosted site's accounts, judge access and usage
credits, offline. Sprint 14 adds the paid plans through Stripe, and sprint
15 puts the site on the public internet. How to run it: `docs/hosted.md`.

Code: `src/hosted/` (`config.ts`, `prices.ts`, `store.ts`, `metered.ts`,
`signin.ts`, `rate-limit.ts`), `src/model/usage.ts` and `usage-text.ts`,
`server/workspace.ts`, `server/workspaces.ts`, `server/hosted.ts`,
`server/http.ts`, `scripts/admin.ts` and `ui/hosted/`. Tests:
`test/hosted-*.test.ts`, `test/scan-secrets-hosted.test.ts` and
`ui/hosted/hosted.test.ts`, against the fake Google endpoints of
`test/google-fake.ts` and a fake Meta endpoint.

## Jeff's decisions (2026-10-28)

- **J13.** Judges use Jeff's Meta Model API key, and his credit goes only
  to judges. Access is through codes Jeff issues, each with a cap.
- **J14.** Sign in with ChatGPT stays the other choice, at no cost to
  Jeff. OpenAI's self-serve path covers only locally run apps. A hosted or
  paid app needs OpenAI's approval through their interest form, so on the
  hosted site ChatGPT shows as "not available here yet". It keeps working
  in local mode.
- **J15.** Meta usage is the paid service. People buy credit in plans ($20
  and $100, which sprint 14 adds through Stripe). Every model call on the
  server key is charged at 3 times that model's token cost. The plans must
  be profitable, so metering must be exact and fail closed.
- **J16.** Accounts sign in with Google (name and email only).
- **J17.** The public site runs on this server through a Cloudflare Tunnel
  (sprint 15). Sprint 13 builds everything it needs offline.

## Design item 1: two modes

`APP_MODE=local`, the default, keeps the app as it was: one case, no
sign-in, a Meta key in settings or `MODEL_API_KEY`, and Sign in with
ChatGPT. Every test from before this sprint passes unchanged.
`APP_MODE=hosted` turns on accounts, sessions, credits and judge codes.

- A1. In hosted mode a person's own Meta key is not offered.
  `POST /api/auth/meta-key` answers 403 `not_offered`, and the server key is
  reached only through credits. (proposed in the handoff)
- A2. A bad `APP_MODE`, `APP_MARKUP`, cap or `APP_SERVER_KEY` value stops
  the app at start with exit code 2, so a typo cannot widen a cap or turn
  a guard off. A markup below 1 is refused, because it would sell usage
  below cost.
- A3. `GET /api/session` answers `{ mode: "local" }` in local mode too, so
  the page learns the mode with one read. It is the only route local mode
  gained.
- A4. The MCP stdio server refuses to start with `APP_MODE=hosted`. No MCP
  client is tied to an account.

## Design item 2: one workspace per account

`server/workspace.ts` builds every service of one case from an event log
path and a secrets path: the event store, intake, case, reply, records,
actions, agent, chat, the Google connection, the provider client and the
API. `serveApi` answers an /api request for one workspace, after the
server's checks, in both modes. Local mode builds one workspace at
`data/app.sqlite` and `data/app-secrets.sqlite`. Hosted mode builds one
per account at `data/accounts/<account id>/`.

- A5. The cache (`server/workspaces.ts`) keeps up to 64 workspaces open
  and closes one idle for 30 minutes, longer than a Google connect flow's
  10 minutes, whose state lives in the workspace's memory. A full cache
  closes the least recently used idle one. A workspace with a request in
  progress is never closed.
- A6. A workspace is reached only through the account id of the request's
  session. The id must match `^a[0-9a-f]{32}$`, and its folder must sit
  directly inside the accounts folder. A symbolic link in its place is
  refused.
- A7. The Gmail and Calendar callback (`/auth/google/callback`) is served
  in the workspace of the session that arrives with it. A connect started
  by one account and finished in another's session finds no flow and is
  refused with `invalid_state`. A signed-out browser is sent to
  `/?google_error=signed_out`.

Tests (`test/hosted-isolation.test.ts`): account B tries to read A's case,
undo A's activity entry, answer A's message, delete its own case, connect
Google with A's flow, and chat. Each is refused or stays in B's own
workspace, and each account's files are its own.

## Design item 3: accounts and sessions

Accounts and sessions are in `data/hosted/accounts.sqlite`
(`src/hosted/store.ts`): mode 600, owned by the app's user, a symbolic
link refused before and after the open, WAL with a busy timeout, and every
change one `BEGIN IMMEDIATE` transaction, as the secrets store does.

- Sign in with Google uses the authorization code flow with PKCE, a
  single-use `state` bound to the browser by an HttpOnly cookie, and a
  `nonce`, with the scopes `openid email profile` only. The redirect is
  `/auth/signin/callback`. It reuses 0012's code exchange and ID token
  checks (issuer, audience, expiry, nonce, verified email).
- A8. It adds the signature check: RS256 against Google's published keys
  at `https://www.googleapis.com/oauth2/v3/certs`, kept for their
  `max-age` between 1 minute and 24 hours, and loaded again for an
  unknown key id at most once a minute. 0012 skipped the signature for the
  Gmail connection because the token comes from Google over TLS. Here the
  token decides who the account is, so it is checked as well.
- A9. No refresh token is asked for (`access_type` is not sent), and the
  access token is dropped once the ID token is checked. `prompt` is
  `select_account`.
- A10. Pending sign-ins are kept in memory, at most 2,000, each for 10
  minutes. Only the hashes of the state and the cookie are kept.
- A11. The same Google subject reopens the same account. Its email and
  name follow what Google last said.
- A session is a random 256-bit token, kept only as its SHA-256 hash. The
  cookie is `__Host-appt_session` over HTTPS and `appt_session_<port>` on
  loopback: HttpOnly, SameSite=Lax, Secure on HTTPS, Path=/, 30 days. Sign
  out deletes it.
- A12. A session lasts 30 days from sign-in and is not extended by use.
  A judge account's session also ends when its code is revoked or expires.
- A13. HTTPS is read from the page's Origin or `X-Forwarded-Proto: https`,
  which the tunnel sets.
- The host allowlist, the same-origin guard and the app header run on
  every route (`server/http.ts`).
- A14. Sign-in starts are limited to 10 per address in 10 minutes. Judge
  code tries, right or wrong, to 10 per address in 15 minutes. The address
  is `CF-Connecting-IP`, else the first `X-Forwarded-For` entry, else the
  socket's. The app binds 127.0.0.1, so these headers come from a proxy on
  this server. The counts live in memory.
- Delete account (`POST /api/account/delete` with `DELETE`) revokes the
  account's Google grant when there is one, removes the workspace folder
  and the account's sessions. Ledger rows stay for accounting. The account
  row keeps only its id, kind and dates: the email, name and Google
  subject are removed, so the same Google account signs up fresh next
  time.
- A15. Delete account is refused with 409 `account_busy` while a request
  of the account still runs, such as a chat turn.

## Design item 4: usage credits

The ledger is in the accounts database. Amounts are integers in
micro-dollars, and every product is taken in BigInt.

- Rows: `grant` (a judge code or, in sprint 14, a purchase, with its
  source), `hold` (before a model call), `charge` (after it), `release`
  (the unused part of a hold), and `refund` and `adjust` (admin only).
- The balance is grants, refunds and adjustments, minus charges, minus
  open holds. A hold is taken only in the same transaction that checks the
  balance covers it.
- A16. A charge never takes more than the balance and its own hold. A
  charge the usage puts above that is cut to what is there, and the rest
  is kept on the row as `uncollected`, with the model's real cost, so
  Jeff's cost stays on record. The balance never goes below zero.
- A17. A negative adjustment takes no more than the balance.
- A release is a record only. The balance counts the hold until it
  closes, then the charge.
- The price table is in `src/hosted/prices.ts`: model id, then input,
  cached input and output per million tokens, with a source note. Muse
  Spark 1.3 is $1.25, $0.15 and $4.25 (the eval's `PRICES_PER_MILLION`).
  Muse Wonder 1.0 is $4.00, $0.20 and $20.00 (Jeff's handoff, as the eval
  has no Wonder price yet).
- A18. Reasoning tokens count as output. The Responses API counts them
  inside `output_tokens`. A report whose reasoning count is above its
  output count is read as counting them apart, and both are charged.
- A19. A cost is rounded up to the next micro-dollar once, over the whole
  product with the markup, so rounding never sells below cost and is off
  by at most one micro-dollar.
- The markup is `APP_MARKUP`, default 3, kept as hundredths.
- Before every call on the server key the metered client
  (`src/hosted/metered.ts`) holds an upper bound: the input bound at the
  input price plus the call's max output tokens at the output price,
  times the markup.
- A20. The input bound is the request body's UTF-8 bytes. A token stands
  for at least one byte, so a request never has more tokens than bytes.
  This holds about four times the real input, and the charge after the
  call gives the rest back.
- A21. Every call on the server key sets `max_output_tokens`: 4,096 for a
  JSON call (extraction, explanations, questions, templates) and 8,192 for
  a chat tool call. Local mode's requests are unchanged.
- If the balance cannot cover the hold, the call is refused with a
  code-written `credits_exhausted` sentence that says how to get more, and
  nothing else is written. A refusal is a `UsageRefusedError`, not a
  model failure, so extraction and the conflict calls do not record a
  failed attempt. A model route answers 402 `credits_exhausted`.
- After the call, the charge comes from the usage the provider reported,
  and the rest of the hold is released.
- A22. A call that failed after it may have run is charged its reported
  usage, or the whole hold when it reported none: a timeout, a network
  error after the request went out, a 5xx answer, a 408, or a stream that
  ended early. A stream that ended with `response.incomplete` or
  `response.failed` carries its usage, which `ModelCallError.usage` now
  keeps. A call refused with any other 4xx answer did not run, and is
  released. So is a call the turn's token meter stopped before it was
  sent.
- A23. A reply that reports no input tokens is charged the whole hold: a
  real call always has input.
- A24. A hold left open by a process that stopped mid-call is charged in
  full after 10 minutes. The app checks at start and every minute.
- Every charge carries the account, the workspace, the route, the chat
  turn, the model and the token counts.
- A25. A chat turn's nested calls (an extraction inside an import, an
  explanation) carry the turn of its first call, through the request's
  usage scope. The usage page shows a turn as one line with its call
  count.
- Calls through a person's ChatGPT sign-in or their own Meta key in local
  mode are not charged: local mode has no metered client.
- Guards on every server-key call, whatever the balances say: a daily
  ceiling on Jeff's real model cost (`APP_DAILY_COST_CAP_USD`, default 20)
  and an off switch (`APP_SERVER_KEY=off`). When either stops a call, the
  person gets a plain sentence.
- A26. The daily ceiling counts every charge's real cost in the UTC day
  and every open hold's upper bound, across all accounts, in the same
  transaction as the hold. A server with no `MODEL_API_KEY` acts as off.
- A27. Before a chat turn saves the person's message, the agent asks the
  hosted guards once (`AgentOptions.admit`): off, no key, the ceiling
  already reached, or a balance of zero refuse the turn with nothing
  saved. A refusal later in the turn ends it with the sentence. Every
  action before it is whole and in the activity log, and the stored answer
  says so: "I stopped before finishing. Check the cards above." and the
  reason.
- A28. The chat codes `credits_exhausted` and `usage_paused` are new. The
  page shows the sentence as written by code, with an Open Usage button
  for credits.

Tests (`test/hosted-ledger.test.ts`, `test/hosted-credits.test.ts`): the
price math against exact BigInt sums, holds and releases, 25 seeded runs
of random grants, holds, charges, releases and adjustments with the
balance checked after every step, concurrent holds from two connections
and twenty concurrent metered calls, the stale hold sweep, the daily
ceiling by UTC day, credits exhausted before and during a turn, a 402 from
a model route with nothing written, the off switch, a missing key and
streams that fail with and without usage.

## Design item 5: judge access codes

- The admin command runs on the server only (`pnpm admin judges ...`):
  `create --label --cap-usd --expires` prints the code once and stores
  only its hash, `list` shows label, cap, spent, status and expiry and
  never a code, `revoke --id` and `grant --id --usd`.
- A29. A code is `judge_` and 43 base64url characters (256 random bits),
  and its id is `j` and 12 hex characters. The secret scan knows the
  code's shape. Lookup is by hash, with a constant-time compare of the
  found hash.
- A total cap across all judge grants (`APP_JUDGE_TOTAL_CAP_USD`, default
  100) refuses new codes and grants beyond it.
- A30. The total counts each standing code's cap, and what a revoked code
  already spent. A code works through the end of its expiry day, UTC.
- The code can be the judge's sign-in on its own (proposed in the
  handoff). The first use makes one judge account tied to the code and
  grants the cap once. Later uses open the same account. A judge who
  signs in with Google can attach the code to that account instead, from
  Usage.
- A31. Each account takes one code, and a judge account takes none. A
  code attached to a Google account does not sign in on its own. Revoke
  ends the judge account's sessions and removes the code's unspent credit
  from the account. An expired code no longer signs in, and a judge
  account's session ends with it. Credit already on a Google account
  stays after expiry.
- A32. "Spent" for a code is its account's charges, up to the code's cap.

Tests (`test/hosted-judges.test.ts`): create, list without the code, the
hash alone in the file, redeem once, sign in again with the same code,
attach to a Google account, the total cap, grant, revoke, expiry, the rate
limit, and no code in any log line.

## Design item 6: usage page and UI

On the hosted site only, to the existing design system:

- A sign-in screen with "Sign in with Google" and "I have a judge code".
  `/judge` opens the code form at once. The code field is a password
  field, cleared after every try.
- An account menu in the top bar with the account, the balance, Usage and
  Sign out.
- Settings has a Usage section: the balance, each recent charge (time,
  what it was, model, cost), the $20 and $100 plans as disabled "coming
  soon" buttons, a field to add a judge code to a Google account, and the
  rough cost of a turn per model. The provider choice reads "Usage
  credits (Meta models)" or "Sign in with ChatGPT (not available on the
  hosted site yet)". Delete account sits under Delete case.
- The model picker and the model select show each model's rough cost per
  turn at the person's price ("about $0.09 a turn"): three calls of 6,000
  input and 600 output tokens, `TYPICAL_TURN` in `prices.ts`.
- When credits run out the chat shows the code-written sentence with the
  way to get more, and no model is called.

## Rules that stay

J12 (no recorded answers), the agent never sends a reply or deletes the
case, every action is logged and undoable, code checks quotes, grounding,
scope and slot states, message text is untrusted and labeled, and each
write states its expected versions and the case generation. No key, token,
code or session goes in a log, an error, the browser, the event log or the
repository. The secret scan now also finds judge codes, the accounts
database by name (`accounts.sqlite` and its WAL, shared memory and
journal files) and a copy of it under any name.

## Not done in this sprint

- Live checks: a real Google sign-in, a real Meta call with
  `max_output_tokens`, and the usage Meta reports for it (coordinator).
- Stripe and the plans (sprint 14), and the tunnel and public host names
  (sprint 15).
