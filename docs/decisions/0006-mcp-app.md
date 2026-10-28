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

## Review round 1

- R1 (coordinator decision, proposed, pending Jeff). The local HTTP API has
  no user login, and an agent with a shell or HTTP access can call it. A
  process that runs as the same OS user can also open the SQLite file
  directly, so no HTTP secret fully stops it. The real control is the
  agent client's own tool permissions. `docs/connect-agent.md` gives each
  client's settings for only the MCP tools, and the connect test starts by
  checking that the agent cannot run a shell command or write a file. Two
  checks add defense in depth (`server/guard.ts`):
  - Every request that changes state must carry `Sec-Fetch-Site:
    same-origin` or an `Origin` equal to the app's own origin, and the
    `X-Appointments-App: 1` header the page sends. Otherwise the server
    answers 403 `forbidden_source` before reading the body, and nothing
    runs. GET needs neither.
  - Creating a grant and confirming an agent's proposal also need the
    pairing code. The server makes it at start from 8 characters of a
    31-letter alphabet with no 0, O, 1, I or L (about 40 bits), keeps it in
    memory only and prints it once to its own stdout. The page asks for it
    once per tab and keeps it in sessionStorage. It sends the code only
    with those two requests. Case and dashes do not matter. A wrong or
    missing code is 403 and writes nothing. After 10 wrong codes both
    actions are locked until the app restarts, so the code cannot be
    guessed through the API. Rejecting a proposal, revoking a grant,
    archive and undo need no code, because they narrow what an agent
    changed or can do. `pnpm grant create` needs no code, because it opens
    the database file, which a process with a shell can do anyway.
- R2. Checklist items and sources, and reply field sources, carry
  `agentName` and `untrustedLabel` when the words are an agent's
  (`src/domain/untrusted.ts` builds the label). A reply field whose value
  only agents reported, such as a place from a confirmed detail edit,
  carries its own label. The labels are in the data, so the next UI shows
  them without new rules. A value an office message or the user also
  states is not labeled. Drafts stored earlier have no labels.
- R3 to R6. The secret scan reads every reachable object through
  `git cat-file --batch` instead of `git log -p`: blob bytes with no binary
  skip, commit and tag text, and tree entry names. It also reads every
  tracked path and ref name, prints names with the secret part replaced by
  `<redacted>`, and finds a prefixed token in hexadecimal and one split
  across two adjacent lines. This replaces A14's history scan. The exact
  guarantee, what it finds and what it does not, is in the README section
  "What the secret scan finds" and in the scanner's header comment. It
  takes about 7 seconds here.
- R7. `list_open_questions` leaves out a conflict that names an archived
  appointment, as the app's question queue does (A12).
- R8. The token file is opened with `O_NONBLOCK`, so a FIFO at the path is
  refused as not a regular file instead of hanging the server at start.

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
