# 0023: One shared judge code, a pool

Status: sprint 21, from the coordinator's handoff of 2026-10-31. Choices
marked (proposed) are the writer's and wait for Jeff. Every rule of 0014
and 0020 stands: J12 no recorded answers, money in integer micros, the
total and daily caps, nothing secret in logs.

Code: `src/hosted/store.ts`, `server/hosted.ts`, `src/hosted/rate-limit.ts`,
`scripts/admin.ts`, the sign-in screen and the account menu. Tests:
`test/hosted-judge-pool.test.ts` (new), and the copy in
`ui/hosted/hosted.test.ts` and `ui/shell/AccountMenu.dom.test.ts`.

Fix round 1 (Muse Wonder's review of `e3694d0`) changed P5, P6, P8, P9
and P10 and added P11 and P12. Fix round 2 (the second review, of
`434d6e8`, with the coordinator's decisions) changed P5, P6, P9, P10, P11
and P12 and added P13. The sections below give the state after both, and
"Fix round 1" and "Fix round 2" at the end list each finding.

## Why

The submission form is likely public, so per-judge codes cannot go in it.
Until now a judge code was its own sign-in: one account for every use. One
shared code would have put every judge in one workspace, with one balance.
A shared pass gives each judge their own account from one code, and a leak
can cost at most the pool.

## Decisions

- P1 A pass is a row of the new `judge_pools` table: its code's hash,
  label, pool, per-judge share, expiry and revoke time. Its code has the
  judge code's shape, so the sign-in screen and the secret scan need no
  change. `pnpm admin judges create-pool` makes one and prints it once.
- P2 Each account a pass makes is a row of `judge_codes` with `pool_id`
  set, its share as its cap, the pass's expiry, and a hash of random bytes
  that no code matches. So the session check, revoke, the hold rules of
  a revoked code (`revoke_due`) and the demo calendar sweep apply to it
  unchanged. These rows are listed with their pass, not as codes.
- P3 The whole pool counts against `APP_JUDGE_TOTAL_CAP_USD` while the
  pass stands, as a code's cap does. A revoked pass counts what its
  accounts spent. An expired pass still counts its pool until revoked, as
  an expired code does.
- P4 A sign-in with a pass is one `BEGIN IMMEDIATE` transaction: the check
  for one share left, the hourly limit, the new account, its row and its
  grant (`judge-pool:<id>`). Two sign-ins, in one process or several,
  never take the same share. Under 1 share left the answer is "The shared
  judge pass is used up. Email the address on the judges' page for your
  own code." Used up is checked before the hourly limit, so a spent pass
  says so.
- P5 At most 6 accounts an hour per pass (`POOL_ACCOUNTS_PER_HOUR`), and
  2 an hour per client address across all passes
  (`POOL_ACCOUNTS_PER_ADDRESS_PER_HOUR`, proposed). Both are sliding hours
  counted in the database, in the sign-in's transaction, so they hold
  across restarts and processes. Only a counted address (P12) is limited
  per address. Every other sign-in is bound by the pass's 6 an hour and
  its pool. The address is kept as an unsalted SHA-256 of its bucket (an
  IPv4 address, or an IPv6 address's /64), on the account's row. That is
  a rate-limit counter key, not a secret: the space is small enough to
  find an address from its hash by trying them all, and the same address
  gives the same value across passes by design. The minute sweep clears
  it once its hour is over, and the count reads only the last hour either
  way. Over either limit: 429, `judge_pool_throttled`, nothing made.
- P6 A browser gets back the account it already has from the same pass,
  with no new account and no second share: by its judge session, or by
  its sign-in key while that lasts (P11). Any other sign-in makes a new
  account. A sign-out, then a sign-in on the same browser, starts a fresh
  workspace (coordinator's decision, fix round 2).
- P7 Attaching a pass to an email account is refused
  (`judge_pool_attach`). A pass's account is a judge account, so it takes
  no code (`judge_judge_account`, as before).
- P8 `judges revoke --id p…` stops new sign-ins and revokes each account
  the pass made by the code rules: sessions end, the unspent share leaves
  the balance, or is owed while a call runs. `judges grant --id p…` raises
  the pool within the total cap. The accounts already made keep their
  share. Grant or revoke on one pass account's row is refused
  (`pool_member`), naming the pass: revoking one account alone would not
  stick, as the pass would make that browser a new one.
- P9 The sign-in hint reads "It signs you in to an account of your own",
  true for both kinds, and adds that with a code shared by several judges
  the workspace stays on this browser while you are signed in, and that
  signing out, or signing in on another browser, starts a fresh one. A
  pass's account carries `pool: true` in the session view, and the
  account menu says: "This workspace stays on this browser while you are
  signed in. Signing out ends it: a new sign-in with the shared judge pass
  starts a fresh one."
- P10 Migration: `judge_pools` is made if missing, and `judge_codes` gains
  `pool_id` (null) with `ALTER TABLE ADD COLUMN`. Every row is kept. The
  test builds a file with the schema of `dev` `058f69a`, 11 codes and real
  ledger rows, a session, open holds, a revoked code whose credit is owed
  behind an open hold, and a code on an email account. It opens it: every
  code, account, session, hold, owed credit, ledger row and balance is as
  it was, the holds settle as before, the old codes still sign in, a pass
  then works, and a second open changes nothing. Since fix round 1 the
  tables and added columns are made in one `BEGIN IMMEDIATE` transaction,
  each column checked inside it, and the pre-0020 accounts rebuild checks
  again inside its own. The switch to WAL runs only on a file not in WAL
  yet, as it takes the whole file: every file the app made is in WAL.
  Eight processes opening the old WAL file at once all succeed, and each
  column is added once. Several processes converting a file that is not
  in WAL yet, at the same moment, is out of scope: the app makes every
  accounts file in WAL from its first open, so no such file exists to
  migrate. The open has two transactions, the pre-0020 rebuild and the
  rest. Each is idempotent, and a crash between them is finished by the
  next open.
- P11 The sign-in screen makes a random key (32 bytes, base64url, kept in
  localStorage as `kept.judge-signin-key`, or one per page without
  storage) and sends it with a judge code sign-in. A pass stores
  `sha256("judge-pool-signin:<pass id>:<key>")` on the account's row in
  the sign-in's transaction (unique), never the key. A repeat with the
  same key, with or without a cookie, gets the same account and a new
  session, so a retried or doubled first sign-in takes one share. The key
  reaches no other pass's account, and a per-judge code ignores it. A key
  of another shape is refused (400). No key works as before.
  Since fix round 2 the key lasts only for the retry window and while the
  browser holds that account's session, so it is never a lasting
  credential for a workspace. The browser forgets it, with the account it
  opened (`kept.judge-signin-owner`), at sign-out, Delete account, an
  email or passkey sign-in, and a judge sign-in that ends in any other
  account, and makes a new one at the next sign-in. The server forgets the
  binding when that account's session ends by sign-out, or by a sign-in in
  that browser to another account. A sign-in that opens the same account
  again keeps it. If the key's account was deleted or is missing, the key
  moves to a new account. If its row was revoked, the sign-in is refused
  as revoked and the binding stays, so the key makes no account in its
  place.
- P12 The client address (rate-limit.ts): with `APP_TRUSTED_PROXY` none,
  the socket's address, and every forwarding header is ignored. Behind
  cloudflare or tailscale, from a loopback socket, the trusted header must
  hold one plain IP address that is not loopback, by one parser for both.
  A header that is there but holds anything else, a list, or a loopback
  address becomes `0.0.0.0`, one address all such requests share. Only a
  socket address with no forwarding header is loopback. Since fix round 2
  only a counted address (`countedAddress`: one plain client IP, never
  loopback and never `0.0.0.0`) has per-address limits. The shared and
  loopback requests are many visitors at once, so they are bound by the
  pass's 6 an hour and its pool for accounts, and by one wider shared
  ceiling for code tries (P13).
  The live Funnel header shape is not verified. `scripts/hosted/start.sh`
  sets `tailscale`, the coordinator reports that the public instance runs
  with no proxy set, and no request through the real Funnel was inspected
  in this sprint. The design no longer depends on it: whether Funnel sends
  one plain address, nothing, a list or one shared address, a visitor is
  either counted on its own address or bound by the shared limits. No
  shape lets one sender lock real judges out, or gives a sender more than
  the pass's 6 accounts an hour.
- P13 Judge code tries (`POST /api/session/judge` and
  `/api/account/judge-code`): 10 per counted address in 15 minutes, as
  before, and 300 in 15 minutes shared by every request with no counted
  address (`JUDGE_SHARED_TRY_LIMIT`, proposed). A code is 256 random
  bits, so this limit is against floods, not guessing. A try is one hash
  and one indexed read. 300 is about one try every 3 seconds, enough for a
  room of judges arriving at once through a proxy that hides their
  addresses, and high enough that one sender sending junk does not lock
  them all out quickly. Before, a site with no proxy set gave every
  visitor one loopback address and 10 tries in 15 minutes between them.

## Checks

- Tests: pool sign-ins make separate accounts and workspaces, the same
  browser keeps its own, used up, 12 sign-ins from 12 processes on a pool
  of 5 make exactly 5, the hourly and per-address limits, revoke with and
  without a call running, grant, expiry, attach refused, the admin
  commands, the migration, and per-judge codes beside a pass as before.
- Live, hosted mode on port 5330 with temporary data and the server key
  off: a $3 pass at $1 a judge. Two cookie jars got two accounts with
  $1.00 each. A's imported message was in A's case only. A signing in
  again kept its account and case. A third jar took the last share, and a
  fourth read the used-up message with no session. `judges list` showed 3
  accounts, $3.00 granted, $0.00 left, used up. The code was in no log line.

## Fix round 1

Muse Wonder's review of `e3694d0`, six findings, all fixed.

1. Medium, a claimed loopback or junk forwarded address skipped or spread
   the per-address limit. Both headers now go through one IP parser, a
   bad or loopback claim is the shared `0.0.0.0`, and with no proxy every
   header is ignored (P12).
2. Medium, a retried or doubled first sign-in took two shares. The
   browser's sign-in key makes it one account (P11).
3. Low, a turn begun before expiry could still hold credit. `hold`
   refuses a judge account whose code row is revoked or expired, for
   passes and per-judge codes alike.
4. Low, revoking one pass account did not stick. It is refused with
   `pool_member`, naming the pass (P8).
5. Low, the per-address count was a fixed window in one process. It is a
   sliding hour in the database (P5).
6. Low, the migration was not one transaction, and its test seeded too
   little. Now one transaction with columns checked inside, a fuller
   old file, eight processes opening it at once, and a race test where
   the hourly limit binds: 8 shares, 12 sign-ins, exactly 6 made (P10).

Live recheck on temporary data, server key off. On 5330 with
`APP_TRUSTED_PROXY=cloudflare`: two sign-ins with the same key and no
cookie gave one account. `CF-Connecting-IP` 127.0.0.1 and junk got one
account each, and ::1, the third claim in the shared bucket, was refused
with 429. A real address got its own account. On 5331 with no proxy set:
seven sign-ins with `CF-Connecting-IP: 127.0.0.1` and an
`X-Forwarded-For` gave six accounts, then 429 from the pass's own limit.
Neither code nor key was in a log line.

## Fix round 2

The second review, of `434d6e8`, closed findings 3 to 6 and raised two
items. The coordinator decided both.

1. The sign-in key was a lasting credential: with the public pass code,
   it opened a judge's workspace for the pass's whole life, and a shared
   browser offered the last judge's key by itself. The key now lasts only
   for the retry window and the signed-in time, on the browser and on
   the server, and a sign-out starts a fresh workspace (P6, P11). A key
   whose row is revoked is refused and keeps its binding.
2. Funnel addressing: with an unknown header shape, the shared `0.0.0.0`
   could have used up every judge's 2 accounts an hour and the judge
   route's 10 tries. Neither applies to it now, nor to loopback: the
   pass's limit, the pool and a shared 300 tries in 15 minutes do (P5,
   P12, P13).
3. Tests: the stored key column is the expected hash and not the key; a
   hold taken before expiry settles after it, with its charge, release
   and balance; the shared address is not limited per address, for
   accounts or code tries; the shared ceiling holds; a sign-out and a
   sign-in to another account end the key, on the server and in the
   browser. WAL conversion by several processes at once is out of scope
   (P10), and the address hash is a counter key, not a secret (P5).

Live recheck on 5330 with `APP_TRUSTED_PROXY=cloudflare`, temporary data,
server key off. A sign-in, a sign-out, then a sign-in on the same browser
gave a new account, and the old key with no cookie gave a third. Two
sign-ins with one new key and no cookie gave one account. On a fresh
pass, `CF-Connecting-IP` junk, 127.0.0.1, "a, b" and ::1 each got an
account, and twelve wrong codes with a junk header each got 404, none
429. A real address then got two accounts, and a seventh sign-in on that
pass was refused with 429, at the pass's 6 an hour. The code was in no
log line.
