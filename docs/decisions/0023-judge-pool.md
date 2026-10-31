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
and P10 and added P11 and P12. The sections below give the state after
it, and "Fix round 1" at the end lists each finding.

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
  across restarts and processes. The address is kept only as a hash of its
  bucket (an IPv4 address, or an IPv6 address's /64), on the account's
  row, and the minute sweep clears it once its hour is over. Over either
  limit: 429, `judge_pool_throttled`, nothing made.
- P6 A browser gets back the account it already has from the same pass,
  with no new account and no second share: by its judge session, or by
  its sign-in key (P11) (proposed). Any other sign-in makes a new account.
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
  the workspace stays on this browser. A pass's account carries
  `pool: true` in the session view, and the account menu says the
  workspace stays on this browser: signing in with the pass again here
  opens it, and another browser starts a fresh one.
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
  Eight processes opening the old file at once all succeed, and each
  column is added once.
- P11 The sign-in screen makes one random key per browser (32 bytes,
  base64url, kept in localStorage as `kept.judge-signin-key`, or one per
  page without storage) and sends it with every judge code sign-in. A
  pass stores its hash, bound to the pass's id, on the account's row in
  the sign-in's transaction (unique). A repeat with the same key, with or
  without a cookie, gets the same account and a new session, so a
  retried or doubled first sign-in takes one share. The key reaches no
  other pass's account, and a per-judge code ignores it. A key of another
  shape is refused (400). No key works as before. If the key's account
  was deleted, the key moves to a new account.
- P12 The client address (rate-limit.ts): with `APP_TRUSTED_PROXY` none,
  the socket's address, and every forwarding header is ignored. Behind
  cloudflare or tailscale, from a loopback socket, the trusted header must
  hold one plain IP address that is not loopback, by one parser for both.
  A header that is there but holds anything else, a list, or a loopback
  address becomes `0.0.0.0`, one address all such requests share, counted
  like any other. Only a socket address with no forwarding header is
  loopback, and only loopback is not counted per address. The coordinator
  reports that the public instance runs with no proxy set, though
  `scripts/hosted/start.sh` sets `tailscale`. With none, Funnel connects
  from loopback, so the pass's own 6 an hour is the working limit there.

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
