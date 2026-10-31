# 0023: One shared judge code, a pool

Status: sprint 21, from the coordinator's handoff of 2026-10-31. Choices
marked (proposed) are the writer's and wait for Jeff. Every rule of 0014
and 0020 stands: J12 no recorded answers, money in integer micros, the
total and daily caps, nothing secret in logs.

Code: `src/hosted/store.ts`, `server/hosted.ts`, `src/hosted/rate-limit.ts`,
`scripts/admin.ts`, the sign-in screen and the account menu. Tests:
`test/hosted-judge-pool.test.ts` (new), and the copy in
`ui/hosted/hosted.test.ts` and `ui/shell/AccountMenu.dom.test.ts`.

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
- P5 At most 6 accounts an hour per pass (`POOL_ACCOUNTS_PER_HOUR`), a
  sliding hour counted in the database. Per client address, 2 an hour
  (`POOL_ACCOUNTS_PER_ADDRESS_PER_HOUR`, proposed), counted in memory like
  the other per-address limits. The address is the trusted proxy's, or the
  socket's. A loopback address is not counted, so a proxy that sends no
  header does not make every judge one address: the pass's own limit still
  holds. Over either limit: 429, `judge_pool_throttled`, nothing made.
- P6 A browser whose judge session is already an account from the same
  pass gets that account back, with no new account and no second share
  (proposed). Any other sign-in, with no session or another session,
  makes a new account.
- P7 Attaching a pass to an email account is refused
  (`judge_pool_attach`). A pass's account is a judge account, so it takes
  no code (`judge_judge_account`, as before).
- P8 `judges revoke --id p…` stops new sign-ins and revokes each account
  the pass made by the code rules: sessions end, the unspent share leaves
  the balance, or is owed while a call runs. `judges grant --id p…` raises
  the pool within the total cap. The accounts already made keep their
  share. Grant on one pass account's row is refused.
- P9 The sign-in hint reads "It signs you in to an account of your own",
  true for both kinds, and adds that with a code shared by several judges
  the workspace stays on this browser. A pass's account carries
  `pool: true` in the session view, and the account menu says signing out
  ends that workspace.
- P10 Migration: `judge_pools` is made if missing, and `judge_codes` gains
  `pool_id` (null) with `ALTER TABLE ADD COLUMN`. Every row is kept. The
  test builds a file with the schema of `dev` `058f69a`, 11 codes and real
  ledger rows, and opens it: every code, account, ledger row and balance
  is as it was, the old codes still sign in, a pass then works, and a
  second open changes nothing.

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
