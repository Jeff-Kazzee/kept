# 0010: Model providers, models and sign-in

Status: proposed, pending Jeff (2026-10-28)

Jeff decided on 2026-10-28 that the user chooses what powers the agent.
Meta's Model API is the main way to use the app and the default
everywhere. Sign in with ChatGPT is the alternative, so people without a
Meta key can use the app too. Later the same day he added that the user
also chooses the model, per provider. Items 1 to 7 and M1 to M4 came with
the sprint. P1 to P32 are choices the writer made while building it. All
are proposed until Jeff confirms them.

Code: `src/model/providers/` (the secrets file, the OpenID Connect checks,
the ChatGPT sign-in, the ChatGPT Responses client, the model lists, the
provider factory and the fixed messages), `server/auth.ts` (the settings
and sign-in routes), `server/main.ts` (wiring), `src/eval/cli.ts`
(`--provider`, `--model`) and `scripts/scan-secrets.ts` (new patterns).
`docs/sign-in.md` is the guide for someone running the app locally.

## The contract as built

Shared with sprints 8 and 9.

- `GET /api/settings` is one answer, served by sprint 8's
  `server/settings.ts` with this sprint's part from `server/auth.ts`
  (P32). It returns `settingsVersion`, `timezone`,
  `timezoneSource`, `provider` (`"meta"`, `"chatgpt"` or `null`), `meta`
  (`keySet`, `source`), `chatgpt` (`signedIn`, `name`, `email`,
  `planUsage`), `model`, `models` (each `id`, `label`, `costHint`) and
  `modelNotice`. It never returns a key or a token. `model` is `""` and
  `models` is empty when no provider is set up. `modelNotice` is an
  addition (P15).
- `PUT /api/settings/provider` with `{ provider, expectedVersion }`. A
  stale version answers 409 `stale_edit` with the current view. A provider
  that is not set up answers 422 `provider_not_ready` (P5).
- `PUT /api/settings/model` with `{ model, expectedVersion }`. The id must
  be in the current provider's `models`, else 422 `unknown_model`.
- `POST /api/auth/meta-key` with `{ key, expectedVersion }` and
  `DELETE /api/auth/meta-key` with `{ expectedVersion }` answer the
  settings view. A malformed key answers 400 `invalid_key` with a fixed
  message that never repeats the key.
- `POST /api/auth/chatgpt/start` answers `{ authorizeUrl }`. OpenAI's
  sign-in not being reachable answers 503 `sign_in_unavailable`.
- `GET /auth/callback` is the loopback redirect (P1). It always redirects
  to `/?signedIn=chatgpt` or to `/?signInError=<code>`, where the code is
  one of `state_mismatch`, `expired`, `access_denied`,
  `authorization_failed`, `registration_incomplete`, `client_mismatch`,
  `exchange_failed`, `identity_unavailable`, `identity_invalid`,
  `account_mismatch` or `server_error`.
- `POST /api/auth/chatgpt/signout` with `{ expectedVersion }` answers the
  settings view plus `notice`: null, or a fixed sentence when OpenAI did
  not confirm the revocation (P13).
- Every settings write except the sign-in start carries the
  `settingsVersion` the page read (from the sprint 9 review). A stale one
  answers 409 `stale_edit` with the current view and writes nothing, so a
  stale tab cannot remove a key or sign out an account another tab just
  set up. The version is checked in the same read as the write, and for
  sign-out under the sign-out lock. A missing or malformed version answers
  400 `invalid_body`.
- The settings routes need the page's source checks, as every `/api`
  write does, but no case generation header (P6).

## 1. The provider factory

`ProviderModelClient` (`factory.ts`) is the one `ModelClient` and
`ToolModelClient` the app hands to extraction, explanations, questions,
templates and the chat agent. They do not change. Each call reads the
settings and goes to the active provider:

- the provider the user chose, else
- Meta when a Meta key is set (the user's own, else the server's
  `MODEL_API_KEY`), else
- none: the call fails with a fixed sentence that says how to set one up
  (P4).

The Meta client is unchanged. It still refuses contributor models and
requests without `store: false`. The ChatGPT client
(`chatgpt-client.ts`) takes the same requests and gives the same reply
shapes. On the way out it sets the connection's model, `store: false`
and `stream: true`, turns a string `input` into one user message, puts
the function tools inside one namespace and sends effort `minimal` as
`low` (P8). A JSON call reads the stream to `response.completed` like a
tool turn does. Function calls come back with the namespace and their own
name, and go back to the API as they came, so the agent's tool loop reads
them unchanged.

**The seam for later providers.** A provider is one `ProviderDefinition`
entry: a kind, a check that says when it cannot take a call, and the
client for the current settings. A hosted-credit provider (the app's own
Meta key, with per-user metering, for a paid plan where users pay Jeff)
or a Meta sign-in, if Meta ever offers one for Muse, would be a new
`ProviderKind` value and a new entry. The usage meter in
`src/model/meter.ts` already wraps every call in a unit of work, so
per-user metering can sit in that entry. Callers would not change. None of
this is built.

## 2. Secrets

`data/app-secrets.sqlite` (beside the event log, from `APP_DB`) holds the
provider choice, the user's Meta key, the model choices and the ChatGPT
connection, as one settings row of JSON (P31). It is its own SQLite file,
outside the event log, so Delete case leaves it. "Remove key" and "Sign
out" clear their parts.

- Mode 600. A missing file is made empty with mode 600 before SQLite opens
  it, and SQLite gives its `-wal` and `-shm` files the same mode. A wider
  file is narrowed to 600 when opened. A file owned by another user is
  refused. The folder is made with mode 700.
- Never opened through a symbolic link: the path is checked with `lstat`
  before and after the open.
- Every write is one `BEGIN IMMEDIATE` transaction that reads the row,
  applies the change and writes it, so a check on the settings version or
  the session id and the write are one compare-and-swap, across processes
  too. WAL and a 5 second busy timeout let a writer wait for another.
- Read from the database on every use, so the app and `pnpm eval:live`
  see each other's refreshes.
- Never logged, returned, put in an error or written to the event log. An
  unreadable row is named by the file's path and the failing fields, never
  its values.
- A session saved without an id is read as it is and given one on the
  next write.
- The ID token is checked and not kept (P2).
- `pnpm scan:secrets` finds the database's name and side files in any
  tracked path or tree, local env file names, the settings rows of any
  SQLite file it reads, and the token fields in any content (P20, P30).

## 3. The ChatGPT sign-in

Built on `fetch` and Node's crypto, with no new dependency (P14). Each
step and its source in OpenAI's guide for open-source apps:

| Step | What the guide says | What the app does |
|---|---|---|
| Host id (overview) | Choose and persist an opaque `ext_agent_host_id` before the first sign-in. A `urn:uuid:` UUIDv4 is supported. | Made once with `randomUUID()`, saved before the first authorize URL, kept through sign-out. |
| Authorize (sign-in, step 2) | Fresh `state`, `nonce` and PKCE verifier per attempt. `client_id=dynamic_agent_client` with `agent_name_hint` and `ext_agent_host_id` for a first registration, the issued client id without `agent_name_hint` later. `response_type=code`, the scopes, `resource=https://api.openai.com/v1`, `code_challenge_method=S256`. Redirect to `127.0.0.1`, never `localhost`. Only the port may change. | All of these. 32 random bytes each for state, nonce and verifier, kept in memory only, one use, ten minutes. `login_hint` from the saved email on a returning sign-in. No `id_token_hint` (P2). |
| Callback (step 3) | Validate `state` and handle an OAuth error first. `access_denied` stops with no exchange. A new registration returns the issued client id, and none means registration is incomplete. A returning sign-in may omit it, and a different one is refused. | State first, then the error, then the client id. The issued id stays with the attempt and is saved only after the exchange and the ID token check succeed with it. If another registration was saved meanwhile, this one is refused (P26). |
| Exchange (step 3) | POST a form-encoded `authorization_code` grant with the issued client id, the code, the verifier, the same redirect URI and the same resource. No client secret. | As written. |
| ID token (step 4) | Verify the signature against OpenAI's JWKS, the issuer, the audience against the issued client id, the expiry and the nonce. Use `sub` as the identity. A returning account must match. Check the granted scopes for `chatgpt.tokens.use.direct`. | The discovery document at `https://auth.openai.com/.well-known/openid-configuration` must name OpenAI's issuer, with every endpoint on that origin. RS256 or ES256 only, the key by `kid`, 5 seconds of clock tolerance, `iat` and `nbf` checked too (P14). The keys expire (P27). A different `sub` is refused. |
| Store (step 5) | Atomic, owner-only, never committed or logged. Replace the access token, expiry, scopes and rotated refresh token together after a refresh. | The secrets file (item 2). |
| Models (models and inference, step 1) | `GET https://api.openai.com/v1/models` with the access token. Keep `visibility: "list"`, in the server's order. Show `display_name`, send `slug`. | Listed at sign-in when plan usage is granted, and saved. |
| Inference (step 2 and 3, preview limitations) | `POST https://api.openai.com/v1/responses` with `store: false` and `stream: true`. Success only at `response.completed`. `input` is an array. Function tools in namespaces. A list of unsupported fields. | Item 1. The unsupported fields are removed if a later change adds one. |
| Refresh (accounts and sessions, token reference) | Refresh near expiry with `grant_type=refresh_token`, the issued client id, the refresh token and the resource, without `scope`. Serialize refreshes. Access tokens live one hour, refresh tokens 30 days and rotate. | Item 4. |
| Sign-out (accounts and sessions) | Revoke the refresh token at the discovered `revocation_endpoint`, then clear the tokens. Keep the client id and host id. Retry a network failure or 5xx. Say so if revocation was not confirmed. | As written, with one retry (P13). |
| Errors (errors and recovery) | Plan usage not granted: keep the sign-in, mark plan usage off, offer to ask again with `prompt=consent` and the full scope set. Documented codes for usage limits, eligibility and unsupported capabilities. Never switch billing silently. | `planUsage` is false in settings, calls fail with a fixed sentence, and the next start sends `prompt=consent`. Each documented code has a fixed sentence (`messages.ts`). |

The callback lands on the app's own server at
`http://127.0.0.1:<APP_PORT>/auth/callback`. So the sign-in finishes when
the browser runs on the same computer as the app, or reaches it through
an SSH tunnel on the same port. It cannot finish from a phone over the
private Tailscale address: the browser would try to open `127.0.0.1` on
the phone. After one sign-in, every device uses the stored connection.

Model calls are gated on `chatgpt.tokens.use.direct`. Without it the
call is refused before any request with: "You are signed in with ChatGPT,
but this app may not use your ChatGPT plan. Sign in with ChatGPT again
and allow plan usage, or switch to Meta in settings."

## 4. Refresh and failure

- Before a call, a token within 2 minutes of expiry is refreshed, unless
  the token endpoint's `earliest_refresh_at` holds it back while the token
  still works (P11).
- A 401 from the Responses API refreshes once and tries once more. A
  second 401 fails with a sign-in-again sentence and keeps the tokens,
  since a 401 alone does not confirm revocation (P12).
- A refresh and a sign-out hold the `chatgpt_session` lease row while
  they call OpenAI (P31). A process claims it in a transaction with its
  holder id and an expiry 30 seconds ahead, renews it every 10 seconds
  while it works and releases it after. A process that finds another's
  live lease waits and reads the settings again, and uses that holder's
  refresh when it lands instead of refreshing. A lease past its expiry,
  whose holder stopped, is taken over in a transaction. Sign-in completion
  is one compare-and-swap transaction and takes no lease.
- Each session has an id made at sign-in and kept through refreshes. A
  refresh stores its result in one transaction only if the lease is still
  its own and the stored session is still the one it refreshed. Otherwise
  the new refresh token is revoked and dropped, and the call uses another
  holder's fresh token or fails as signed out. A sign-out that comes
  during a refresh waits for it, then revokes the new refresh token. A
  sign-out or a failed refresh clears the session only if it is still the
  one it read, so a newer sign-in is never cleared.
- A settings database busy past the busy timeout, or a lease held past a
  75 second wait, fails the route with a retryable 503 `settings_busy`,
  the callback with `signInError=settings_busy` and a model call with a
  fixed try-again sentence. Nothing is written.
- A refresh that grants no `chatgpt.tokens.use.direct` stores the token
  set, shows plan usage off and fails the call with the plan-usage
  sentence.
- A refresh the token endpoint refuses for good (`invalid_grant`,
  `invalid_refresh_token`, `token_expired`, `refresh_token_expired`,
  `refresh_token_invalidated`, `refresh_token_reused`, `invalid_client`)
  signs the user out: the tokens are cleared and the registration is kept.
  A refresh that returns an ID token for another account does the same.
  The call fails with: "Your ChatGPT sign-in ended, so you are signed out.
  Sign in with ChatGPT again in settings, or switch to Meta."
- A network failure or 5xx on refresh keeps the tokens and fails the call
  with a try-again sentence.
- The provider never changes on a failure. With ChatGPT chosen and signed
  out, a Meta key is never used, and the other way round. The chat shows
  the provider's fixed sentence in place of the generic one, through
  `ModelCallError.userText`, the one change in `src/agent/`.

## 5. Privacy

Both providers get what Meta got before: the selected message text and the
user's chat, and the tool results the agent reads. Every request sets
`store: false`. The README and `docs/sign-in.md` say which provider
receives the case data. The settings page (sprint 9) should say which
provider is in use and that it receives the case data the agent reads.

## 6. The live eval

`pnpm eval:live --provider meta|chatgpt --model <id>`. `meta` uses
`MODEL_API_KEY` and takes `muse-spark-1.3` (default) or `muse-wonder-1.0`.
`chatgpt` uses the connection the app saved, from the settings file beside
`APP_DB`, and takes a model that connection lists. It exits 2 with a plain
message when no connection is saved or plan usage is off. The coordinator
runs it. The spend guard still prices tokens at the Meta rates (P22).

## 7. The sign-in guide

`docs/sign-in.md`.

## The model choice (M1 to M4)

- **M1.** Meta: `muse-spark-1.3` (default, "lower" cost hint) and
  `muse-wonder-1.0` ("higher"). Never a contributor model: the list holds
  none, a stored one falls back to the default, and the Meta client still
  refuses one. No model listing for the Meta Model API could be checked
  for this sprint, so the fixed list is used (P16).
- **M2.** ChatGPT: the models the connection lists, with no cost hint.
  The code default is `gpt-6.1-sol`, the model in OpenAI's examples. The
  current model is the user's choice if listed, else the default if
  listed, else the first listed. With no listing, the user's choice or the
  default (P9).
- **M3.** One choice per provider drives every call on it: the chat
  agent, extraction, explanations, questions and templates. The factory
  puts the model in each request.
- **M4.** When a call fails because the model lacks a capability the app
  needs (tool calling, structured output or streaming), the factory saves
  which model and capability in the settings file, the call fails with
  "The model X does not support tool calling, which this app needs.
  Choose another model in settings.", and `modelNotice` carries that
  sentence until the user picks another model or provider. Nothing moves
  to another model by itself. ChatGPT's
  `subscription_sharing_unsupported_capability` with its `param` is
  documented. For Meta the usual Responses codes `unsupported_parameter`,
  `unsupported_value` and `unsupported_model_feature` are assumed (P17).

## Writer's choices

- **P1.** The callback path is `/auth/callback`, not
  `/auth/chatgpt/callback` as the handoff named it. The guide uses
  `/auth/callback` in its examples and says only the port may change from
  the first registration on. The guide's own example path is the safest
  one to register.
- **P2.** No `id_token_hint`, and the ID token is not kept. The authorize
  URL goes to the browser, and the ID token must not. `login_hint` with the
  saved email identifies the account instead.
- **P3.** Signing in with ChatGPT, or saving a Meta key, chooses that
  provider only when none was chosen yet. Otherwise only
  `PUT /api/settings/provider` changes it.
- **P4.** With no choice made, Meta is active when a Meta key is set.
  `provider` in settings shows the active provider, so `null` means
  nothing is set up.
- **P5.** `PUT /api/settings/provider` refuses a provider that is not set
  up, so the page cannot choose one that would fail every call. A provider
  can still become not set up later, for example after a sign-out, and
  then calls fail with a fixed sentence.
- **P6.** The settings routes take no case generation header, as they are
  app settings that survive Delete case.
- **P7.** `settingsVersion` is the settings database's version plus the
  settings stream's version (P32). A token refresh does not change it.
- **P8.** The tools namespace is `case_tools`. Effort `minimal` is sent
  as `low` to ChatGPT, as not every OpenAI reasoning model takes
  `minimal`.
- **P9.** The ChatGPT code default and the order of choice in M2.
- **P10.** The redirect after the callback carries only a code, never a
  token or the OAuth code, and the callback answer sets `Cache-Control:
  no-store` and `Referrer-Policy: no-referrer`.
- **P11.** The 2-minute refresh margin and the use of
  `earliest_refresh_at`.
- **P12.** A second 401 after a refresh keeps the tokens.
- **P13.** Sign-out retries the revocation once, then clears locally
  either way, and `notice` says when OpenAI did not confirm it.
- **P14.** No SDK. OpenAI's Sign in with ChatGPT DevKit is not published
  to npm (its packages are private), its code is under a noncommercial
  license, and it pulls in `openai`, `jose` and `proper-lockfile`. The
  protocol is implemented directly instead. The ID token check uses
  Node's `crypto.verify` with the JWKS key. The guide suggests a
  maintained JWT library: this code follows the same checks and the tests
  cover each refusal. An unfamiliar `kid` reloads the keys at most once a
  minute.
- **P15.** `modelNotice` in the settings view, for M4.
- **P16.** The fixed Meta list.
- **P17.** The capability codes assumed for Meta.
- **P18.** One ChatGPT account per app install, with no account picker.
  A returning sign-in must be the same account. To use another one,
  remove the `chatgpt` part of the settings file while the app is
  stopped.
- **P19.** In recorded mode (no `APP_LIVE_MODEL=1`), model calls replay
  recordings whatever the settings say. The settings and sign-in routes
  still work. `APP_LIVE_MODEL=1` no longer needs `MODEL_API_KEY` at
  start, since the key can be entered in the app. Replaced by J12 (2026-10-28, `0013-failure-testing.md`): the app has no recorded mode. Every call
  goes to the chosen provider, and with none ready the chat and each model
  route answer `provider_not_ready` with `NO_PROVIDER_TEXT`.
- **P20.** The scan patterns: the settings file's name and its temporary
  name, `.env.local` and `.env.<name>.local`, the JSON fields
  `accessToken`, `refreshToken`, `access_token`, `refresh_token` and
  `id_token` with 20 or more token characters, and `"meta": { "key": ... }`
  with 8 or more. The scan's lines now say "Possible secret at".
- **P21.** The provider is read per call, not per chat turn. A provider
  switch during a turn sends the turn's later calls to the new provider,
  which fails on the old provider's reasoning items, and the turn ends as
  `model_unavailable`.
- **P22.** The eval's spend guard prices at the Meta rates for both
  providers.
- **P23.** Replaced by P31. Every settings and token write is a
  transaction, so no write can lose another's.
- **P24.** A Meta key is one run of 8 to 512 printable characters with no
  spaces. Nothing more is known about its format.
- **P25.** The secret scan guards what can be published, set by the
  coordinator on 2026-10-28. It reads the working tree, the index, and
  every object reachable from `refs/heads/*`, `refs/tags/*`,
  `refs/remotes/*` and HEAD, and the names of those refs. It skips every
  other ref, such as Entire's `refs/entire/*` and T3's `refs/t3/*`
  checkpoint refs and `refs/stash`, which are local and never pushed. Its
  summary line names each skipped prefix with its ref count, for example
  "Skipped local refs: refs/entire (138), refs/t3 (156).", so the gap
  stays visible. Before this, the scan read every ref. That made a test's
  sample values, captured by those tools from the working tree, fail the
  scan after the branch's own history no longer held them. Publishing must
  still never push a skipped ref.
- **P26.** The issued client id is saved only once it verifies, which
  replaces the guide's "save it before the exchange" advice: a sign-in
  whose code exchange fails starts a new registration next time. That
  keeps a tampered callback from saving a client id. Of two first
  registrations, the first to finish is kept.
- **P27.** The signing keys are kept for the JWKS response's
  `Cache-Control` max-age, between 1 minute and 24 hours, or 1 hour with
  none. A failed signature reloads them once, at most once a minute, and
  checks again, for a key replaced under the same `kid`. Calls that need
  the keys while a load runs share that one load.
- **P28.** A Meta error message is `Model call returned HTTP <status>`
  with the API's error type and code when they are lower-case identifiers.
  It never holds body text, which extraction would write to the event
  log. Error types, codes and params on every provider must now start with
  a lower-case letter, so mixed-case text that could be an echoed key is
  dropped. The capability codes and the request fields they name (M4) are
  an allowlist matched in any case first and kept in lower case, so the
  capability check still sees them.
- **P29.** The ChatGPT client checks the model it sends right before the
  request, and the model always comes from the connection's listing with
  contributor models removed.
- **P30.** The scan also reads every `.json` file up to 8 MB as JSON, on
  disk and in history, and matches the Meta key across the two lines the
  settings file writes it on. The value shape is the one the app accepts:
  any printable ASCII with no space, with an escaped quote or backslash in
  JSON text. Only an exact placeholder of the form `<NAME>` is skipped. It
  also opens any file or blob up to 8 MB that starts with the SQLite
  header, from a private read-only copy, and reads its settings rows.
- **P31.** The secrets store is its own SQLite file with a lease row for
  refresh and sign-out, set by the coordinator on 2026-10-28 after review
  round 2. It replaces the JSON file and the `O_EXCL` lock file of round 1,
  whose stale takeover could race. The settings stay one JSON row, so the
  scan and the shape checks are unchanged. A JSON file from before is not
  read: no real sign-in or saved key existed yet.
- **P32.** One `settingsVersion` for two stores, after sprint 8 merged
  (2026-10-28). The time zone lives in the event log's `settings` stream
  and the provider settings in their own database, and the page sends one
  version with every settings write (`ui/agentApi.ts`). The version is the
  sum of the two. Each part only grows, so the sum grows on any change and
  an equal sum means neither part moved. `GET /api/settings` is served
  once, by `server/settings.ts`, which takes this sprint's part through
  `createAuth(...).source`. A provider write compares the sum inside its
  own transaction, reading the time zone part there. The time zone write
  takes the provider part off the page's version and lets the stream's
  own check compare the rest, and its 409 reports the sum and the whole
  view. Each write's compare-and-swap is exact for its own store. A write
  to the other store that lands between the read of its part and the
  commit is the one gap, a few microseconds wide.
- The MCP server's extraction, explanation and question calls take their
  client from the same provider factory as the app (`mcp/main.ts`), so
  they follow the provider and model chosen in settings. The live eval
  keeps its own `--provider` and `--model`.

## What the server cannot control

- A provider receives the case data the agent reads, under its own terms.
  `store: false` asks it not to keep the response.
- Anyone who can read files as the app's OS user can read the secrets
  file, as with the event log.
- The live sign-in and live calls on both providers are untested here.
  The tests run against offline fakes of the documented endpoints. The
  coordinator and Jeff run the live sign-in.
