# 0006: MCP in the app and the connect test

Status: proposed, pending Jeff (2026-10-28)

This records how the app manages agent access and shows agent changes in
sprint 6 (D5, part 2). G-a to G-h came with the sprint. A1 to A16 are
choices the writer made while building it.

Code: `ui/AgentPanels.tsx` (grant screen, proposals, notes, live refresh),
`ui/App.tsx` (review queue, slots, archive), `server/api.ts` (routes),
`src/grants/` (token shape, `--token-file`, last use), `mcp/token.ts` and
`mcp/main.ts` (token file), `scripts/mcp-stdio.sh` (launcher),
`scripts/scan-secrets.ts` (secret scan), `src/case/service.ts` and
`src/reply/` (archive rules), `docs/connect-agent.md` (connect guide).

## Coordinator decisions

- G-a. Grant screen. Create a grant with a name of 1 to 60 characters and a
  tier (read, annotate, propose). The list shows name, tier, created, last
  used and status. Revoke asks for a confirmation in the row. The new token
  is shown once, with a copy button and the text "Shown once. Anyone with
  this token can use the access you chose. Your agent's model provider may
  receive the case data it reads." Grants stay app settings and survive
  Delete case.
- G-b. A token is `appt_` and then 43 base64url characters (32 random
  bytes). The prefix lets a scanner find a token with no false hits on
  ordinary text. No unprefixed token is in use, so there is no migration.
  The server accepts only a token whose SHA-256 hash is stored, prefix or
  not.
- G-c. `pnpm scan:secrets` scans every tracked file and every line of
  `git log --all -p`. It exits 1 on a hit and prints only the place, never
  the match. A test plants tokens in a temporary repository, which must
  fail, and runs the scan on this repository, which must pass.
- G-d. Live refresh. The page polls `GET /api/case/version` every 2 seconds
  while the tab is visible and reloads the case view when the version
  changes. No WebSockets.
- G-e. Review queue. Agent proposals show beside extracted claims, labeled
  "Proposed by <grant name>", with the statement in an untrusted-text box
  and the change in plain words. Confirm and reject are HTTP routes that
  state the expected versions and carry the generation header. A confirmed
  report shows "reported by you through <grant name>". No MCP tool
  confirms.
- G-f. Archive. Archived appointments leave the default slot list, the
  question queue and the reply panel. "Show archived" lists them with an
  Undo button. Undo uses the existing reversing event.
- G-g. Connect test setup: `pnpm grant create --token-file <path>`,
  `APPT_GRANT_TOKEN_FILE` for the stdio server, `scripts/mcp-stdio.sh`,
  `docs/connect-agent.md` for Grok Build, OpenCode and Claude Code, and an
  automated stand-in that runs the launcher with the SDK client. Jeff runs
  the real client.
- G-h. README sections on the split between model and code, and on what
  the server cannot control once data reaches the agent's client.

## Choices made in the sprint

### Grants

- A1. Last used is the time of the grant's latest entry in the case's
  access log. Refused calls count. Delete case erases the access log, so
  after a delete the column says "not in this case" until the grant calls
  again. No grant event is written per call.
- A2. The grant routes are `POST /api/grants` and
  `POST /api/grants/<id>/revoke` with `expectedVersion`. Like every other
  write they need the `X-Case-Generation` header, so a page opened before
  a Delete case is refused. The token is in the create response only. It
  is held in the grant panel's own state until the user hides it, so a
  live refresh does not clear it and a reload does not show it again.
- A3. Grant times, proposal times and note times show in America/Denver
  with MDT or MST, so the repeated hour on 2026-11-01 reads clearly.

### Token file

- A4. `--token-file` creates missing folders with mode 700 and the file
  with `O_EXCL` and mode 600. It refuses an existing path, a symbolic link
  included. It creates the file before the grant, so a path that cannot
  be written leaves no grant behind. A relative path is taken from the
  folder the user ran `pnpm` in (`INIT_CWD`).
- A5. The stdio server refuses to start when both `APPT_GRANT_TOKEN` and
  `APPT_GRANT_TOKEN_FILE` are set, when the file is not a regular file,
  when the group or others have any permission on it, when it is larger
  than 1 KB, and when it is empty. It checks the opened file, so a symbolic
  link to a mode 600 file works. No message holds the token. Both
  variables are removed from its environment.
- A6. `scripts/mcp-stdio.sh` uses `APPT_NODE` for the Node binary when it
  is set, for a host where `node` on a non-interactive PATH is not Node 24.
  It prints nothing on stdout.

### Live refresh

- A7. The version is the case generation and the highest event number in
  the file. Grant events and access log entries count, so an agent's read
  refreshes the page too. That keeps the history and the last-used column
  current. `/api/state` returns the version it was read at, read before
  the rest, so a write during the read causes one more poll instead of a
  missed change.

### Proposals and agent text

- A8. The change in plain words is built by code from the kind, the claim
  type, dates and times only (`describeChange` in
  `src/records/types.ts`). A place or an item the agent wrote shows in its
  own untrusted box.
- A9. The statement of a confirmed agent report is its evidence quote. It
  shows in an untrusted box wherever it appears: the slot list, conflict
  sources and the reviewed list. Found in the browser check, where it
  first showed as a plain quote.
- A10. The app's confirm for an archive or a place edit sends the record
  version from the state on screen.
- A11. The MCP appointment summary carries `state_meaning`, written by
  code from the state, for example "You asked the office for this time.
  The office has not confirmed it yet." An agent answering "Am I booked
  for Monday?" then needs no guess about what "requested" means.

### Archive

- A12. A conflict that names any archived appointment is not asked. It
  stays in the conflicts list with "Not asked while <slot> is archived".
  An open question on such a conflict is hidden while the archive lasts
  and comes back with undo. Asking and answering check the archive again
  inside their transaction.
- A13. Archived slots leave the reply options and the slot list the model
  sees. With nothing archived the model's input is the same as before, so
  recorded responses still match. A draft for an archived slot cannot be
  built or approved (`slot_archived`). Starting, suggesting and approving a
  reply check the archive inside the write's transaction, so an archive
  from another tab that commits after the read still stops the approval.
  After undo the same draft is valid again.

### Secret scan

- A14. The bare 43-character rule runs on every file and every line of
  history, not only fixtures, logs and docs, because the repository and
  its history have no other hit. It needs an upper-case letter, a
  lower-case letter and a digit, skips a run next to `+` or `/` or
  followed by `=` (standard base64, such as lockfile hashes), and skips
  runs that start with `mcp__`, which are MCP tool names in session
  checkpoints. `git log --all` includes `refs/entire/checkpoints/*`, which
  hold session transcripts of several hundred megabytes, so the scan
  reads the history as bytes in one pass. It takes about 9 seconds here.

### Other

- A15. A store that stays busy through every retry now answers HTTP 503
  `busy` from the app, instead of 500. The MCP server and the app share
  the file more often now.
- A16. `ui/AgentPanels.test.ts` builds its state through the real API, so
  it imports Node code. It is type-checked by its own config,
  `ui/tsconfig.node-tests.json`, which `pnpm typecheck` runs.

## For Jeff

- When the propose grant reports that the office confirmed Monday by
  phone and you confirm it, Monday shows "Confirmed · reported by you
  through <grant name>, change proposed". Thursday stays "Confirmed ·
  office message, change proposed". Rule 3 (S4) holds both, because no
  evidence says Thursday moved, and the app asks which one stands. This is
  the existing slot rule, not a sprint 6 change. The optional demo beat
  stops at the proposal waiting for review, before this.
- Grok Build, OpenCode and Claude Code are documented in
  `docs/connect-agent.md`. Nothing here ran `grok`. The coordinator runs
  the real Grok connect test.

## Supersedes

- M-a's token shape: tokens now carry the `appt_` prefix.
- M-b: the server also reads `APPT_GRANT_TOKEN_FILE`.
- M-h: grants are created and revoked in the app's grant screen as well as
  with `pnpm grant`.
