# 0014: Accounts, judge access and usage credits

Status: proposed, pending Jeff (2026-10-28). J13 to J20 are Jeff's
decisions. A1 to A32 are the writer's choices and are proposed.

Sprint 13 builds the hosted site's accounts, judge access and usage
credits, offline. Sprint 15 puts the site on the public internet. The paid
plans (sprint 14) wait until after the hackathon (J18). How to run it:
`docs/hosted.md`.

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

Jeff changed the plan on 2026-10-28, after the coordinator's live check:

- **J18.** Stripe and the paid plans wait until after the hackathon. The
  plan buttons stay "coming soon", with no payment code. Billing starts
  in the Stripe sandbox when it resumes. The order is sprint 13, hosting
  (sprint 15), testing, then the submission (sprint 16).
- **J19.** The $20 daily and $100 judge total defaults are not approved
  amounts, so neither cap has a default. In hosted mode
  `APP_DAILY_COST_CAP_USD` and `APP_JUDGE_TOTAL_CAP_USD` must both be set.
  While either is missing the server key is off: the start log names the
  missing setting, and every model step answers the plain usage-paused
  sentence. `pnpm admin judges create` and `grant` refuse while the total
  cap is unset.
- **J20.** Sign in with ChatGPT on the hosted site stays "not available
  here yet". Nothing depends on OpenAI's approval.

The coordinator's live check of `016be1b` (hosted mode, Jeff's Meta key, a
$1 judge code, one chat turn of two Spark calls): each charge matched
Meta's reported usage times 3 exactly, cached input included, and Meta
accepted `max_output_tokens`. The holds were about 10 times the real cost
(A20), which stays.

## Design item 1: two modes

`APP_MODE=local`, the default, keeps the app as it was: one case, no
sign-in, a Meta key in settings or `MODEL_API_KEY`, and Sign in with
ChatGPT. Every test from before this sprint passes unchanged.
`APP_MODE=hosted` turns on accounts, sessions, credits and judge codes.

- A1. In hosted mode a person's own Meta key is not offered.
  `POST /api/auth/meta-key` answers 403 `not_offered`, and the server key is
  reached only through credits. (proposed in the handoff)
- A2. A bad `APP_MODE` stops the app at start with exit code 2 in either
  mode. In hosted mode a bad `APP_MARKUP`, cap, `APP_SERVER_KEY` or
  `APP_TRUSTED_PROXY` value does too, so a typo cannot widen a cap or turn
  a guard off. A markup below 1 is refused, because it would sell usage
  below cost. Local mode does not read the hosted-only settings, as before
  sprint 13 (review round 1, finding 7).
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
  progress is never closed. Review round 1, finding 5: nor is one used in
  the last 10 minutes, or one with a Google connect waiting for its
  callback. A full cache with none to close grows past 64 instead. Final
  review, finding 2: never past 4 times 64. At that ceiling the least
  recently used workspace with no request running closes, even a recent
  one or one with a Google connect waiting, which the person can start
  again. When every one has a request running, a new workspace is refused
  with 503 `site_busy`, retryable, and a plain sentence.
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
  Review round 1, finding 6: sign-in and sign-out do not let the request's
  claim of HTTPS pick the cookie. They end the session of either cookie
  form the browser sent, and clear both forms.
- A13. HTTPS is read from `X-Forwarded-Proto: https`, which the tunnel
  sets. Final review, finding 3: in hosted mode only from a loopback
  socket, as Tailscale serve and cloudflared connect from loopback, and
  never from the page's Origin. Every request reads both session cookie
  forms, the `__Host-` one first, and so does the sign-in callback for its
  flow cookie, so a claimed scheme can neither hide nor pick a session. A
  new session is set in the form the trusted scheme supports. Local mode
  keeps its earlier rule.
- The host allowlist, the same-origin guard and the app header run on
  every route (`server/http.ts`).
- A14. Sign-in starts are limited to 10 per address in 10 minutes. Judge
  code tries, right or wrong, to 10 per address in 15 minutes. The counts
  live in memory. Review round 1, finding 4: the address is the socket's,
  unless `APP_TRUSTED_PROXY=cloudflare` is set. Then it is
  `CF-Connecting-IP`, and only from a loopback socket, since cloudflared
  runs on this server. `X-Forwarded-For` is never read. The default is
  `none`, and sprint 15 sets `cloudflare`.
- Delete account (`POST /api/account/delete` with `DELETE`) revokes the
  account's Google grant when there is one, removes the workspace folder
  and the account's sessions. Ledger rows stay for accounting. The account
  row keeps only its id, kind and dates: the email, name and Google
  subject are removed, so the same Google account signs up fresh next
  time.
- A15. Delete account is refused with 409 `account_busy` while a request
  of the account still runs, such as a chat turn. Review round 1, finding
  3: it finds that out first, and claims the workspace so no other request
  of the account starts. Only then does it revoke the Google grant, remove
  the folder and the sessions. A refusal changes nothing.

## Design item 4: usage credits

The ledger is in the accounts database. Amounts are integers in
micro-dollars, and every product is taken in BigInt.

- Rows: `grant` (a judge code or, once billing resumes, a purchase, with its
  source), `hold` (before a model call), `charge` (after it), `release`
  (the unused part of a hold), and `refund` and `adjust` (admin only).
- The balance is grants, refunds and adjustments, minus charges, minus
  open holds. A hold is taken only in the same transaction that checks the
  balance covers it.
- A16. A charge never takes more than its own hold, and its cost never
  more than the hold's cost (review round 1, finding 1). It never takes
  more than the balance either. A charge cut short keeps the rest on the
  row as `uncollected`. The balance never goes below zero.
- A17. A negative adjustment takes no more than the balance.
- A release is a record only. The balance counts the hold until it
  closes, then the charge.
- The price table is in `src/hosted/prices.ts`: model id, then input,
  cached input and output per million tokens, with a source note. Muse
  Spark 1.3 is $1.25, $0.15 and $4.25 (the eval's `PRICES_PER_MILLION`).
  Muse Wonder 1.0 is $4.00, $0.20 and $20.00 (Jeff's handoff, as the eval
  has no Wonder price yet).
- A18. Reasoning tokens count as output. The Responses API counts them
  inside `output_tokens`, as the live rows show (output 67 with reasoning
  13, output 62 with reasoning 40), so `output_tokens` alone is billed.
  Review round 1, finding 1: the hold and the charge use one rule
  (`usageBeyondHold` in `prices.ts`). A usage report the hold did not
  bound is charged the whole hold: reasoning above output, output above
  the call's `max_output_tokens`, input above the request's byte bound,
  cached input above input, or no input at all (this replaces A23).
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
- A23. Folded into A18.
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
  ceiling on Jeff's real model cost (`APP_DAILY_COST_CAP_USD`, no default,
  J19) and an off switch (`APP_SERVER_KEY=off`). When either stops a call, the
  person gets a plain sentence.
- A26. The daily ceiling counts every charge's real cost in the UTC day
  and every open hold's upper bound, across all accounts, in the same
  transaction as the hold. A server with no `MODEL_API_KEY`, or with
  either cap unset (J19), acts as off.
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
- A total cap across all judge grants (`APP_JUDGE_TOTAL_CAP_USD`, no
  default, J19) refuses new codes and grants beyond it. While it is unset,
  `create` and `grant` refuse.
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
  from the account. Review round 1, finding 2, and the final review,
  finding 1: with no hold open, the unspent part goes at once. With holds
  open, all of it is owed (`revoke_due`), because those holds may still
  spend it. No new hold may draw on it, and the shown balance leaves it
  out. What the holds that were open at the revoke charge counts against
  it first. Once the last of them closes, what is still owed leaves the
  balance. So the revoked credit is fully gone once they settle, and other
  credit on the account, granted before or after the revoke, is never
  taken. An expired code no longer signs in, and a judge
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
  Sign out. Moved by `0015-shell-layout.md` to the bottom of the sidebar,
  with Usage as its own page.
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

## Review round 1 (Muse Wonder, 2026-10-28)

Seven findings, each fixed with a test that failed before the fix, in
`test/hosted-review1.test.ts`:

1. High: a reasoning count above output was billed past the hold. Now
   `output_tokens` alone is billed, any count the hold did not bound is
   charged the whole hold, and the store caps every charge at its hold
   (A16, A18). A property test of 300 random reports, malformed ones
   included, checks that no charge or its cost exceeds its hold.
2. High: a revoke left credit inside open holds to come back on release.
   Now it is owed, refused to new holds and taken as the holds close (A31).
3. Medium: Delete account revoked Google before it found the account
   busy. Now the busy check and a claim come first (A15).
4. Medium: forwarding headers were trusted from any client. Now only
   behind `APP_TRUSTED_PROXY=cloudflare`, from a loopback socket (A14).
5. Low: eviction could drop a waiting Google connect. Now a workspace with
   one, or used in the last 10 minutes, stays (A5).
6. Low: sign-out read the cookie a header picked. Now both forms are ended
   and cleared (A12).
7. Low: local mode exited on hosted-only settings. Now they are read only
   in hosted mode (A2).

## Final review (Muse Wonder, 2026-10-28)

Round 1's findings 1 and 3 to 7 closed. Finding 2 and two new findings
were fixed, each with a test that failed before the fix, in
`test/hosted-review2.test.ts`:

1. High: a revoke could take other credit when an open hold settled for
   less than itself. Now the held judge credit is owed whole, lowered by
   what the open holds charge, and collected only once they have all
   closed (A31). Tests: Muse's case ($5 judge, $2 other, a $6 hold, a $1
   charge, which leaves $2), two holds released and charged in turn, and
   40 seeded runs of judge and other grants, holds, partial settles, a
   revoke and grants after it. They check that the balance never goes
   negative and that the removal is exactly the code's unspent credit less
   what its open holds charged.
2. Medium: the workspace cache could grow without limit. Now it has a
   ceiling of 4 times its size (A5). Tests: the ceiling closes the oldest
   idle workspace, recent or not, and a cache full of running requests
   refuses with 503 `site_busy`.
3. Low: the claimed scheme picked the cookie form. Now both forms are
   read, the `__Host-` one first, and `X-Forwarded-Proto` counts only from
   loopback (A13). Tests: the trust rule, a loopback session and a Google
   sign-in callback that wrongly claim HTTPS, and both forms sent at once.

## Not done in this sprint

- Live checks: a real Google sign-in and a Gmail connect inside a hosted
  account (coordinator). The live Meta check is done (above).
- Stripe and the plans, deferred until after the hackathon (J18), and the
  tunnel and public host names (sprint 15).
