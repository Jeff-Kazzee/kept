# 0012: Gmail and Google Calendar

Status: proposed, pending Jeff (2026-10-28)

On 2026-10-28 Jeff decided that email and calendar access matter for the
app to work, in two ways: through the person's own agent and its own
Gmail and Calendar connectors, and through a built-in Google connection in
the app. Sprint 11 builds the built-in connection. Items 1 to 7 came with
the sprint. Choices marked (proposed) are the writer's.

Code: `src/google/` (`oauth.ts`, `connection.ts`, `secrets.ts`,
`gmail.ts`, `calendar.ts`, `tools.ts`, `http.ts`), `server/google.ts` and
the wiring in `server/main.ts`. Tests: `test/google.test.ts` and
`test/google-http.test.ts`, against the fake of Google's endpoints in
`test/google-fake.ts`. Setup: `docs/google.md`.

## Google pages read (2026-10-28)

- "Using OAuth 2.0 for Web Server Applications": the authorization endpoint
  `https://accounts.google.com/o/oauth2/v2/auth` with `client_id`,
  `redirect_uri`, `response_type=code`, `scope`, `access_type=offline`,
  `state`, `prompt`, `include_granted_scopes`. The token endpoint
  `https://oauth2.googleapis.com/token` for the code and for refresh. The
  answer carries `access_token`, `expires_in`, `scope`, `refresh_token`.
  A refresh token comes back only with `access_type=offline`, and again
  only with `prompt=consent`. People can uncheck scopes, so read the
  granted `scope`. Revoke at `https://oauth2.googleapis.com/revoke` with
  `token`, form encoded, 200 on success, and revoking one token revokes
  every scope of the grant. `invalid_grant` means the token expired or was
  revoked. Redirect URIs must use HTTPS except for localhost, and raw IP
  hosts are refused except loopback.
- "OAuth 2.0 for Mobile and Desktop Apps": PKCE. A verifier of 43 to 128
  unreserved characters, an S256 challenge in base64url without padding.
  Loopback redirect `http://127.0.0.1:<port>`.
- "Using OAuth 2.0 to Access Google APIs": testing mode with an external
  audience issues refresh tokens that expire in 7 days unless only basic
  profile scopes are asked. 100 refresh tokens per account per client,
  the oldest dropped. Gmail-scoped tokens end on a password change.
- Google Cloud help, "Manage app audience": up to 100 test users, the
  unverified-app warning, authorizations that expire 7 days after consent,
  the lifetime cap of 100 users for an unverified app.
- "OpenID Connect": an ID token from the token endpoint over HTTPS comes
  straight from Google. Still check `iss` (`https://accounts.google.com`
  or `accounts.google.com`), `aud` (the client id) and `exp`, and present
  the `nonce` only once.
- Gmail API reference, `users.messages.list` (`q` with Gmail search
  syntax, `maxResults` up to 500, ids only) and `users.messages.get`
  (`format`, the Message and MessagePart fields, base64url part bodies,
  `internalDate` in epoch milliseconds). Gmail help, "Refine searches in
  Gmail": `newer_than:`, `from:`, `{ }` for any of, `-` to exclude,
  `category:`. Gmail scopes page: `gmail.readonly` is restricted, and a
  server that stores or sends restricted-scope data needs a security
  assessment.
- Calendar API reference, Events resource and `events.list`, `get`,
  `insert`, `patch`, `delete`: `status` is `confirmed`, `tentative` or
  `cancelled`, `extendedProperties.private` is visible only on this
  calendar's copy, `events.list` filters with
  `privateExtendedProperty=name=value`, `timeMin` and `timeMax` are
  RFC 3339 with an offset, `singleEvents=true` expands recurring events,
  `calendar.events` covers every call used. "Version resources": send the
  ETag in `If-Match` to update or delete only an unchanged event, and
  Google answers 412 otherwise.

## Items from the handoff

1. OAuth 2.0 authorization code flow with PKCE (S256) and `state`, as a
   web server application. Scopes `openid email` and only the ones the
   person turns on: `gmail.readonly`, `calendar.events`. `fetch` only, no
   Google library, so no dependency was added.
   Tests: "asks only for the scopes the person turned on", "connects,
   stores the refresh token", "refuses a reused state", "Google refuses a
   code exchanged with the wrong verifier", the ID token cases.
2. Redirect: `/auth/google/callback` on `http://127.0.0.1:<APP_PORT>`, on
   `http://localhost:<APP_PORT>`, and on `https://<name>` for each
   `APP_ALLOWED_HOSTS` name. The server prints the list at start when the
   client is set. Tests: "picks the redirect URI from the page's host",
   "an HTTPS page gets a Secure flow cookie", the server test.
3. Secrets: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the
   environment, declared optional and sensitive in `.env.schema`. The
   refresh token was first in its own file, `google-secrets.json` beside
   the event log. Since the integration it is the `google` row of sprint
   10's secrets database (see "Integration" below). Refresh a
   minute before expiry. `invalid_grant` on refresh, or a second 401 after
   a refresh, marks the connection as needing a reconnect. Tests: "refreshes
   a minute before expiry, and once after a 401", "a refresh Google refuses
   marks the connection", "sets a token file readable by others back to
   mode 600", "a damaged token file is an error that does not quote the
   file".
4. Gmail: a fixed query built by code, a window of 1 to 60 days (30 by
   default), optional senders that must be plain addresses. Each message
   becomes the paste import shape with source "Gmail", channel `email`, and
   the sender and sent time from its headers, not suggested. It goes
   through the same intake as a paste. Tests: "builds the query in code",
   "prefers text/plain", "uses Google's receipt time", "becomes the paste
   import shape", "gmail_import extracts with the header sender", "runs
   the same intake checks as a paste", "instructions inside an email stay
   data".
5. Calendar: list a window in the case time zone for clash checks. One
   event per slot in the chosen calendar (default `primary`), with private
   extended properties `apptAssistant=1` and `apptSlotKey=<slot key>`.
   Tentative while requested, confirmed when confirmed, deleted when
   canceled. Each write returns an undo record that reverses it at Google.
   Tests: "maps slot states to event status", "creates a confirmed event
   ... then undo deletes it", "updates the event ... undo puts the earlier
   fields back", "calendar_remove_slot deletes ... undo creates it again",
   "calendar_list reads a window in the case time zone and feeds the clash
   check".
6. Tools for sprint 8's registry in `src/google/tools.ts`: `gmail_search`,
   `gmail_import(message_id)`, `calendar_list(window)`,
   `calendar_sync_slot(slot_key)`, `calendar_remove_slot(slot_key)`, in
   the shape of `src/agent/tools.ts`. Each needs the connection and its
   scope and records one activity entry through `GoogleActivityLog`.
   `undoGoogleActivity` is the activity log's Undo for a calendar write.
   Tests: "each tool needs the connection and its scope", "exports the five
   tools in the agent tool shape".
7. `docs/google.md`: the setup, the limits of testing mode and the agent
   path.

## Writer's choices

- G1 (proposed). The contract's `GET /api/google` fields come first, and
  three fields are added: `configured` (the client id and secret are set),
  `needsReconnect` (a refresh failed, while `email`, `gmail` and
  `calendar` still say what was connected) and `version`. `connected` is
  false while `needsReconnect` is true. The coordinator should confirm the
  added fields with sprint 9.
- G2 (proposed). The expected version for connect and disconnect is the
  connection's own `version` from `GET /api/google`. It changes on connect,
  disconnect and when a reconnect becomes needed, not on a token refresh.
  A stale version gets 409 `google_stale` with the current status. The
  case generation header is required and must match, as on every write.
- G3 (proposed). Connect body: `{ expectedVersion, gmail, calendar,
  calendarId? }`, at least one of `gmail` and `calendar` true.
  Disconnect returns the status and `revoked`.
- G4 (proposed). The state is single use, expires after 10 minutes, at
  most 5 flows wait at once, and only hashes of the state and the cookie
  are kept, in memory. The connect route sets an HttpOnly, SameSite=Lax
  cookie, and the callback needs it, so a code from another browser is
  refused. Lax is needed because the callback is a top-level navigation
  from Google. The cookie is `appt_google_flow_<port>` on `/auth/google`
  over plain http, and `__Host-appt_google_flow_<port>` on `/` with Secure
  over HTTPS. The callback reads the `__Host-` name first. Cookies are not
  separated by port, so another page on the same host can still set the
  plain name. The server's state is the second factor, and the cookie is
  not tied to pairing or a session, which sprint 8 removes. The flow
  records its scheme, and the callback reads only the cookie form the flow
  started with. Each flow also
  keeps the connection version it started at. The callback refuses a flow
  whose version moved (`stale_flow`), and a disconnect drops every open
  flow.
- G5 (proposed). Every connect sends `prompt=consent`, so Google always
  returns a refresh token, and leaves out `include_granted_scopes`, so the
  grant holds exactly the scopes turned on.
- G6 (proposed). A `nonce` is sent and checked, and the ID token's email
  must be verified. The signature is not checked, because the token comes
  from the token endpoint over TLS (Google's OpenID Connect page). A
  failed check revokes the new grant, so no token is left at Google that
  the app does not hold.
- G7 (proposed). Reconnecting the same account does not revoke the old
  token, because revoking it would revoke the new grant too. Connecting a
  different account revokes the previous account's grant.
- G8 (proposed). The callback lands on `/?connected=google`, or on
  `/?google_error=<code>` with a fixed code, and sends
  `Referrer-Policy: no-referrer`. It logs the code only.
- G9 (proposed). The redirect URI follows the host the page used, so the
  browser sends the flow cookie back. An allowed host reached over plain
  `http` is refused, because Google allows `http` only for loopback.
- G10 (proposed, changed in review round 3). The last access token is
  kept in memory and in the `google` row, so another process that shares
  the file uses it instead of refreshing again (R3-7). It never reaches
  the status, a log or the browser.
- G11 (proposed, coordinator decision in review round 2). Each event's id
  is `appt` and the base32hex of a SHA-256 over a fixed app namespace, the
  account's Google id (`sub`), the calendar id and the slot key: 56
  characters from a to v and 0 to 9, which Google accepts as a client id.
  No secret is stored, so the id is the same after the token file is lost
  or the account reconnects. Only someone who can write to the calendar
  could predict an id and take it, and the property check refuses such an
  event. Each event carries three private properties: `apptAssistant=1`,
  `apptSlotKey` and `apptAccount=<sub>`. An event is the app's only when all
  three match. The app reads the slot's id first. Without a live event
  there, it asks Google once by all three properties (at most 10 results)
  and adopts a verified event under another id, so an event made under an
  earlier id scheme is updated, not doubled. More than one verified event
  is `google_duplicate`, and the person removes the extra one. An event
  that copies only the first two properties, or sits at the app's id
  without them, is left alone (`google_not_app_event`). Every patch and
  delete sends `If-Match` with the ETag, and one without an ETag is refused
  as `google_changed`, never sent. Every patch sends the three properties
  again and its answer must pass the same check.
- G12 (proposed). Creates are idempotent. A create that gets 409 reads the
  event at that id: a live one is taken as the slot's event and brought in
  line, so two syncs at once or a retry after a timed-out create make one
  event. An event of the app's that was removed in Google Calendar is not
  put back by a sync: the sync reports `google_changed` ("removed in
  Google Calendar") and writes nothing. It comes back only through Undo or
  `calendar_sync_slot` with `restore_removed: true`, which the agent sets
  only after the person asks. Undo of a create deletes the event, undo of
  an update patches the earlier fields back, undo of a delete puts the
  event back (by patching the removed event, or by a new create at the
  slot's id when Google no longer has it). Undo finds the event by the id
  in its record and checks its properties, so a record from an earlier id
  scheme still works. Each is refused when the event changed at Google
  since the write (`google_changed`), when it is not the app's for that
  slot, when the connection now points at another account or calendar,
  or, for a delete, when the slot already has a live event. An undo
  records its own activity entry with no undo. Putting a removed event
  back with a patch of its status is checked only against the fake until
  Jeff's real connect test.
- G13 (proposed). A slot in state `change_proposed` keeps a tentative
  event. `offered` and `declined` get none, the same as `canceled`. A slot
  with no time gets an all-day event. A timed event lasts 60 minutes, the
  same assumption as the clash check.
- G14 (proposed). Event titles and descriptions are written by code
  ("Appointment", "Appointment (requested, not confirmed)"). Only the
  place comes from the office's message, as the slot shows it.
- G15 (proposed). The imported text starts with `Subject: <subject>` and a
  blank line, as a person would paste an email, so a date given only in
  the subject can be quoted. The Gmail message id becomes
  `gmail-<id>`, so importing it again finds the same message. A body
  longer than 20,000 characters, the paste limit, is not imported.
- G16 (proposed). The sent time is the `Date` header, unless it is
  missing, not a date or more than 5 minutes after Google's own receipt
  time, then the receipt time. A sender can write any `Date` header, and
  a time in the future would make the email look newer than later ones.
- G17 (proposed). `gmail_search` returns at most 10 messages, each body
  cut to 4,000 characters for the model, and imports nothing. The query
  leaves out chats, spam, trash, promotions and social mail.
- G18 (proposed). Google errors become fixed codes (`google_*`) with
  fixed sentences. A 429 or a rate-limit reason is `google_unavailable`,
  a 403 with an insufficient-scope reason is `google_scope_missing`.
  Nothing from a response body reaches an error, a log or the browser.
- G19 (proposed). Activity entries hold code-written summaries only: no
  email text, no event title, no token. The interface is
  `record(entry) -> { activityId }`, and `undo` is plain JSON. Each entry
  has a `kind`, matching sprint 9's U15: `calendar_event_added`,
  `calendar_event_updated`, `calendar_event_removed` for a calendar write
  or an undo that did one, `gmail_message_imported` for a new Gmail
  import (only when this call recorded the message), and null for reads,
  no-ops and failed calls.
- G20 (proposed). The Google tools take their own context
  (`GoogleToolContext`: the Google services, intake, the case, the
  activity log, the extraction effort) and return the fields of
  `ToolResult`. Since the integration they take sprint 8's `ToolContext`
  and join its registry (see "Integration" below).
- G21 (proposed). A Gmail import is recorded with `imported_from: "gmail"`
  on its `message_imported` event, and the message view has
  `importedFrom: "gmail"`, as sprint 9's U15 assumes. A paste has no such
  field. It is not read from the message id, because a pasted message may
  also have an id that starts with `gmail-`.
- G22 (proposed). A token file that is not JSON or not of the current
  shape, such as one from an earlier build, reads as no connection that
  needs a reconnect, at the version it states. Status, connect and
  disconnect still work. A connect writes a new file in its place, and a
  disconnect writes a new empty file in its place and revokes the refresh
  token when it can read one. No real token file exists yet, so no
  migration is written. A link, a FIFO or a file of another user is still
  refused.

## Review round 1 (Muse Wonder, xhigh, 2fc3063..3801bb3)

1. A refresh for one account could land after another account connected.
   The cached access token and the refresh in progress now carry the
   account and a hash of the refresh token, and a refresh result is kept
   only while the stored connection still has that identity. A failed
   refresh marks only its own connection.
2. An open flow could finish after a disconnect. Flows keep their start
   version, the callback refuses a moved version, and a disconnect drops
   open flows. A stale flow for the account already stored is not revoked,
   because that would end the live grant.
3. The token file followed symbolic links. Reads use lstat, O_NOFOLLOW
   and O_NONBLOCK, check the descriptor with fstat (regular file, owned by
   the server's user) and fix the mode with fchmod.
4. The size cap was checked after the whole body was read. The body is
   now read as a stream and counted, the stream is canceled past the cap,
   and a declared length past the cap is refused before any read.
5. Creates were not idempotent. See G11 and G12.
6. The lookup read one page of a property search. It is now a read by id.
7. The flow cookie name was shared. See G4.
8. The MIME walk took any shape. The part tree is rebuilt from string
   fields only, at most 20 levels and 200 parts, and any failure while
   reading a message is `google_invalid_response`.
9. A subject-only email was refused as empty. The import shape is built
   first and checked for text and length.

## Review round 2 (Muse Wonder, 3801bb3..141c1b0)

Findings 1 to 9 were confirmed. New items:

- 10. A token file of another shape broke status, connect and
  disconnect. See G22.
- 11, 12, 16, 17. The stored HMAC secret made ids unrecoverable after the
  file was lost, and events under other ids were not found. Coordinator
  decision, see G11 and G12.
- 13. The restore patch did not resend the properties. Every patch sends
  them, and its answer is checked.
- 14. A missing ETag led to an unguarded write. It is now `google_changed`.
- 15. A removed event was put back silently. See G12.
- 18. The reader lock was not released on a read error. A try and finally
  cancels on error and always releases it.
- 19. The callback took either cookie form. It reads only the flow's own.
- 20. The import kind was set when an existing message was extracted. It
  is set only when this call recorded the message.

## Integration with sprints 8, 9 and 10 (2026-10-28, on dev 2db4521)

- I1. The five tools are in sprint 8's shared registry
  (`AGENT_TOOLS` in `src/agent/tools.ts`), so the in-app agent and the MCP
  server both list them. They take sprint 8's `ToolContext`. The Google
  services ride in `ToolServices.google`. Without them a tool answers
  `google_not_configured`. `gmail_search` and `calendar_list` are read
  only. Labels follow sprint 8's form ("Searching your email").
- I2. Activity. A change goes through `CaseActions` and writes one entry
  with sprint 9's kind. `gmail_import` uses the same import as a paste,
  with kind `gmail_message_imported` and the paste's undo (it removes the
  message and its facts). A new message is read as part of the import, as
  for a paste, and one already in the case is read as its own
  `message_read` entry. A calendar write is recorded by
  `CaseActions.recordGoogle` with kind `calendar_event_added`,
  `calendar_event_updated` or `calendar_event_removed`, target the slot,
  and an undo spec `google_calendar` that holds the undo record. Reads,
  no-ops and refused calls write no entry (proposed: sprint 8 logs
  actions, not reads).
- I3. Undo. `CaseActions.undoEntry` serves sprint 8's undo route and its
  `undo` tool. For a `google_calendar` entry it checks the activity
  version and that the entry is in effect, refuses while a later Google
  entry for the same appointment is in effect, reverses the write at
  Google with `undoGoogleActivity` outside the store transaction (a
  network call), then writes sprint 8's `undo` entry and marks the entry
  undone in one transaction. Since review round 3 an intent comes first
  (R3-1 to R3-3). A Google refusal is `undo_blocked` with its sentence.
  Any other entry goes to sprint 8's `undo` unchanged.
- I4. Time zone. `GoogleCalendar` takes the case's zone
  (`kase.timeZone()`) at each call. The America/Denver default is gone.
  Event times, list windows and labels use it, through sprint 8's
  `src/domain/zone.ts`.
- I5. Clashes. `CaseService` takes an `externalCalendar` source. The
  Google Calendar events the app last fetched, without the app's own,
  join the loaded `.ics` events in the case view, so `get_schedule`,
  `check_calendar` and the slots' clashes read both. The view names both
  ("dana.ics and Google Calendar"). The events are read at start when a
  calendar connection exists, after a connect, and by
  `POST /api/google/calendar/refresh`, for 31 days from the earliest of
  today and the case's appointments. `calendar_list` only reads (R3-5). A
  disconnect and the start of a connect clear them (R3-6).
- I6. Sprint 8's rules. In a paste turn (D2') `gmail_import` counts as an
  import, and its claims may be reviewed in that turn
  (`ChatTurnState.gmailImported`). `calendar_sync_slot` and
  `calendar_remove_slot` are refused that turn with `waits_for_person`.
  Gmail messages keep their header sender and sent time, are office
  messages and are never offered as the person's own report (D1').
  Only a message the call itself imported counts, and a message from an
  earlier turn is not read in a paste turn (R3-4). Grounding counts
  `gmail_message_imported` for "I imported", `calendar_event_removed` for
  "I removed", and `calendar_event_added` for "I added", "I created" and
  "I put" (R3-9).
- I7. Secrets. The Google state moved from its own JSON file into sprint
  10's `app-secrets.sqlite`, as the `google` row of a new `rows` table
  (`SecretsStore.readRow` and `updateRow`). It gets that file's mode 600,
  link and owner checks, WAL and busy timeout, and every Google write is
  one BEGIN IMMEDIATE read-check-write, so the app and the MCP server,
  which share the file, do not lose each other's refresh or disconnect.
  `src/google/secrets.ts` is removed. A row that is not valid JSON or of
  the current shape still reads as needing a reconnect (G22).
- I8. Routes. No pairing or session (sprint 8). `/api/google` and its
  writes are behind the host allowlist, the same-origin guard and the app
  header, and the writes need the case generation. Connect and disconnect
  both need `expectedVersion`, the `version` of `GET /api/google`
  (R3-8). Connect turns on both permissions and the primary calendar
  unless the body says otherwise. The page sends `{}` to connect today, so
  sprint 9 adds the version.

## Review round 3 (Muse Wonder, xhigh, cfe9ee4)

- R3-1 to R3-3. A Google write and its entry cannot share a transaction.
  So each calendar write and each Google undo first records an intent on
  the `google_intents` stream, in a store transaction: the plan (event
  id, the fields before and the fields wanted) or the entry to undo. Then
  it calls Google. Then one transaction writes the entry and closes the
  intent. While an intent for an appointment is open, another Google
  write or undo for it is refused with `google_busy`, in this process and
  in the MCP process, which share the store. A refused Google call closes
  its intent. A lost answer (`google_unavailable`,
  `google_invalid_response`) leaves it open. An intent left open is
  finished by `CaseActions.reconcileGoogle`, which every calendar write
  runs first: it reads the event at Google and writes the entry with its
  undo when the write is there, drops the intent when it is not, and
  writes an entry with no undo when the event changed since. An undo
  intent is finished by retrying the undo, or by reconcile when Google
  shows the change reversed. `GoogleCalendar.undo` treats an undo that
  already happened as success: the earlier fields back for an update, or
  the app's event live again with the deleted fields for a delete. The
  commit transaction checks again that the entry is not undone and that
  no later Google entry for the appointment is in effect, and aborts if
  either changed. A moved activity version alone does not abort, because
  Google has already reversed the change and the open intent kept every
  other Google write for the appointment out (proposed). Reconcile skips
  an intent this process is still running, and one another process
  opened less than two minutes ago.
- R3-4. `gmail_import` counts a message as imported in a paste turn only
  when this call imported it, and does not read a message from an
  earlier turn in a paste turn.
- R3-5. `calendar_list` no longer writes the clash events.
- R3-6. The clash events carry the account and calendar they were read
  for and a generation. A clear starts a new generation, so a fetch in
  flight is dropped, and the snapshot is empty as soon as the connection
  names another account or calendar.
- R3-7. A refresh holds the `google_refresh` lease of the secrets
  database. A process that waited uses the access token the other stored,
  or refreshes with the rotated refresh token. A successful refresh for
  the same connection clears a reconnect mark set while it ran.
- R3-8. Connect needs `expectedVersion` again.
- R3-9. The grounding verbs "added", "created" and "put" need an entry
  that added something: `calendar_event_added`, an import, a note, tags or
  a draft.

## Not done here

- No real Google account was used. Every test runs against the fake.
  Restoring a deleted event by patching its status still needs Jeff's
  real connect test.
