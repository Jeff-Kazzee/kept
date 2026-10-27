# 0004: MCP core

Status: proposed, pending Jeff (2026-10-27)

This records how appointment records, grants and the MCP server work in
sprint 4. M-a to M-i came with the sprint. M-j to M-w are choices the
writer made while building it.

## Shape

- `src/records/` is the one domain service for records. The app and the MCP
  server both call `RecordsService`, so both use one store and one set of
  input rules (`src/records/inputs.ts`).
- `src/grants/` is the grant store and the `pnpm grant` command.
- `mcp/` is the MCP server. `mcp/main.ts` is the stdio entry. It opens no
  network port and makes no model calls.

## Decisions from the sprint

- M-a. A grant token is 32 random bytes in base64url. It is shown once at
  creation and stored only as a SHA-256 hash with the grant name and tier.
  A revoked grant stays as a record with a `grant_revoked` event.
- M-b. The stdio server reads its token from `APPT_GRANT_TOKEN`, set in the
  client's own config. It removes the variable from its environment at
  start and never logs it. The case history records the grant name and
  grant ID, never the token or its hash.
- M-c. No tool returns a full message body in this sprint. Read results
  carry quotes only, each as `{ "untrusted_quote": "...", "evidence_id": "..." }`.
- M-d. The app and the MCP server open the same SQLite file in WAL mode with
  a 5 second busy timeout. Every tool call reads current state. Nothing is
  cached across calls.
- M-e. 60 calls a minute per grant, in fixed one-minute windows. The count
  lives in a `rate_windows` table in the shared SQLite file, so every
  server process on the file shares it, and a restart does not reset it.
  The table holds counters, not history, so its rows are updated and
  removed. Notes are at most 2,000 characters. At most 20 tags of 40
  characters each.
- M-f. Access log entries are system events in the `access_log` stream.
  They are appended without an expected version (`EventStore.appendSystem`).
  Every record write by a user or an agent still states its expected
  version. The first call the rate limit denies in a window is logged on
  its own. The later denials of that window become one summary entry, with
  tool `*` and a `count`, written when the grant's next call arrives after
  the window. So a flood of calls adds at most two log entries a minute.
- M-g. A confirmed proposal becomes evidence with source
  `reported_by_user_via_agent` and `agent_name` from the grant, never from
  the client. The slot shows "reported by you through <grant name>".
- M-h. `pnpm grant create --name <name> --tier <tier>`, `pnpm grant list`
  and `pnpm grant revoke <id>` work on the app database until the sprint 6
  grant screen exists. `create` prints the token once to the terminal.
- M-i. The MCP library is `@modelcontextprotocol/server` 2.3.1. See
  `0001-stack.md` and "Library" below.

## Decisions made in the sprint

### Records

- M-j. An appointment record is one slot, keyed by its slot key, such as
  `2026-11-16T13:00`. The tools call it `appointment_id`. Notes, tags,
  archive and undo live in the `record:<key>` stream. The slot's state
  still comes only from accepted evidence. If a later claim changes a slot's
  key (a date-only slot gains a time), the old record does not follow it.
- M-k. Undo names one earlier event by its version: a note, a tag change or
  an archive. It appends `event_undone`, and the projection skips the
  reversed event. Undoing a tag change brings back the tags before it, so
  only the latest tag change still in effect can be undone. An undo cannot
  itself be undone. To redo, make the change again. Undo is app
  only. No tool undoes.
- M-l. Archive is app only, or an agent proposal the user confirms. An
  archived record leaves `list_appointments` unless `include_archived` is
  true. Its slot keeps its state and its conflicts stay open.

### Proposals

- M-m. `propose_change` takes one of four kinds:
  - `new_appointment`: a date, a time, an optional place and `offered` or
    `confirmed`. Refused when the slot already exists.
  - `user_report`: one claim with the same types and format rules as a
    manual entry. A date is required except for an office request. It has
    no event time, as a manual entry has none, so an agent cannot place its
    report ahead of office messages. Slot order uses the time the agent
    reported it.
  - `detail_edit`: a corrected place for one appointment. A changed date or
    time is a `user_report` instead, for example a confirm on the new slot
    and a cancel on the old one.
  - `archive`: one appointment.
  Every kind needs a `statement` of at most 500 characters, the agent's
  account of what the user said. It is kept as the evidence quote and
  returned only as `untrusted_text`.
- M-n. A proposal is its own stream, `proposal:<id>`. The domain review
  queue (`RecordsService.reviewQueue()`) returns pending claims from
  messages and pending proposals together. `confirmProposal` and
  `rejectProposal` are domain functions for the app. Their screen is
  sprint 6.
- M-o. Confirming a report writes an `agent_report_confirmed` evidence
  event, accepted when written, as an answer is. Its evidence time is when
  the agent proposed it, which is when the user reported it. A place edit
  becomes a `clarify` claim with the place, so the slot treats it like the
  user's answer about a place.
- M-p. `detail_edit` and `archive` state the record version the agent saw.
  The check and the proposal write are one transaction, and a stale version
  is refused. Confirming either one states the record version the user saw,
  checked in the same transaction as the confirmation.

### Server

- M-q. Each tool call is one transaction on the store (BEGIN IMMEDIATE):
  grant lookup, rate limit, tool name, grant active, tier, input, the
  tool's writes and the log entry. A revoke from the app commits either
  before the call, which then fails, or after it. The tool's writes run in
  a savepoint, so a failed tool writes nothing and its log entry still
  commits. Every call is logged, including denied, rate-limited and unknown
  tools. A call with an unknown token is logged with no grant name. The log holds the grant ID and name, the tool, the result
  and the appointment ID. It never holds the call's input.
- M-r. Errors are tool results with `isError: true` and a JSON text block:
  `permission_denied`, `stale_edit` (with the current record),
  `invalid_input`, `not_found`, `rate_limited`, `error`. An unknown tool
  name is a protocol error (invalid params). It is logged as
  `unknown_tool` with the name cut to 64 letters, digits and `_ . -`, and it
  counts toward the rate limit.
- M-s. `tools/list` results carry `ttlMs: 0` and `cacheScope: "private"`,
  so a client does not reuse a tool list after the grant changes.
- M-t. Imported or agent-written text is labeled, not only quotes. Places,
  request items, notes, proposal statements and model-written question text
  are returned as `{ "untrusted_text": "..." }`. Labels and conflict
  summaries are written by code from dates and times and are plain strings.
  Tags and grant names allow letters, digits and a few marks only. Every
  output string loses control characters and hidden direction marks.
- M-u. The stdio entry serves both the 2026-07-28 revision and older
  clients that open with `initialize`, which is the SDK default. The grant
  checks are the same for both.

### Grants

- M-v. A grant name is 1 to 60 characters of letters, digits, spaces and
  `. _ ' ( ) -`. Active grants have different names, compared without case.
  The name of a revoked grant can be used again.
- M-w. Grants and the access log live in the case's event log file, because
  revocation must reach a server the client launched. Sprint 5 decides
  whether Delete case removes grants too.

## Open questions for Jeff

- Notes and proposal statements are not checked for clinical words. The
  scope check covers model text only. An agent could write clinical text
  into a note.
- Proposals from agents do not show in the app's review list yet (sprint 6).
  A confirmed agent report shows in the evidence list with origin `agent`.

## Library

`@modelcontextprotocol/server` 2.3.1 is the v2 line of the TypeScript SDK.
Its README says it implements the 2026-07-28 specification, and its stdio
entry checks the per-request envelope of that revision. Its runtime
dependencies are `zod` and `@modelcontextprotocol/core` only. It bundles
`ajv` 8.18.0 (MIT) in its dist files. The v1 package
`@modelcontextprotocol/sdk` 1.32.1 was not chosen. It has 17 runtime
dependencies, among them `express`, `hono`, `cors` and `jose`. 2.4.0 was published 4
days before this check, so 2.3.1 is pinned. `@modelcontextprotocol/client`
2.3.1 is a dev dependency for tests only.
