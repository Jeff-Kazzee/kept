# 0010: Model providers, models and sign-in

Status: proposed, pending Jeff (2026-10-28)

Jeff decided on 2026-10-28 that the user chooses what powers the agent.
Meta's Model API is the main way to use the app and the default
everywhere. Sign in with ChatGPT is the alternative, so people without a
Meta key can use the app too. Later the same day he added that the user
also chooses the model, per provider. Items 1 to 7 and M1 to M4 came with
the sprint. P1 to P30 are choices the writer made while building it. All
are proposed until Jeff confirms them.

Code: `src/model/providers/` (the secrets file, the OpenID Connect checks,
the ChatGPT sign-in, the ChatGPT Responses client, the model lists, the
provider factory and the fixed messages), `server/auth.ts` (the settings
and sign-in routes), `server/main.ts` (wiring), `src/eval/cli.ts`
(`--provider`, `--model`) and `scripts/scan-secrets.ts` (new patterns).
`docs/sign-in.md` is the guide for someone running the app locally.

## The contract as built

Shared with sprints 8 and 9.

- `GET /api/settings` returns `settingsVersion`, `timezone`,
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
- `POST /api/auth/meta-key` with `{ key }` and `DELETE /api/auth/meta-key`
  answer the settings view. A malformed key answers 400 `invalid_key` with
  a fixed message that never repeats the key.
- `POST /api/auth/chatgpt/start` answers `{ authorizeUrl }`. OpenAI's
  sign-in not being reachable answers 503 `sign_in_unavailable`.
- `GET /auth/callback` is the loopback redirect (P1). It always redirects
  to `/?signedIn=chatgpt` or to `/?signInError=<code>`, where the code is
  one of `state_mismatch`, `expired`, `access_denied`,
  `authorization_failed`, `registration_incomplete`, `client_mismatch`,
  `exchange_failed`, `identity_unavailable`, `identity_invalid`,
  `account_mismatch` or `server_error`.
- `POST /api/auth/chatgpt/signout` answers the settings view plus
  `notice`: null, or a fixed sentence when OpenAI did not confirm the
  revocation (P13).
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

`data/app-secrets.json` (beside the event log, from `APP_DB`) holds the
provider choice, the user's Meta key, the model choices and the ChatGPT
connection. It is outside the event log, so Delete case leaves it. "Remove
key" and "Sign out" clear their parts.

- Mode 600. A wider file is narrowed to 600 when read. A file owned by
  another user is refused. The folder is made with mode 700.
- Written atomically: a new file with a random name, flushed, then renamed
  over the old one, then the folder is flushed.
- Never followed through a symbolic link: reads open with `O_NOFOLLOW`,
  and the rename replaces a link, never its target.
- Read from disk on every use, so the app and `pnpm eval:live` see each
  other's refreshes.
- Never logged, returned, put in an error or written to the event log. An
  unreadable file is named by its path and the failing fields, never its
  values.
- The ID token is checked and not kept (P2).
- `pnpm scan:secrets` finds the file's name in any tracked path or tree,
  local env file names, and the file's token fields in any content (P20).

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
- Refresh, sign-in completion and sign-out each hold the secrets file's
  lock from their read to their write: a queue within the process and a
  lock file made with `O_EXCL` beside the secrets file between processes,
  such as the app and `pnpm eval:live`. A lock file older than 60 seconds
  is taken over. After taking the lock, a refresh reads the file again and
  uses a refresh another process already made.
- Each session has an id made at sign-in and kept through refreshes. A
  refresh stores its result only if the stored session is still the one it
  refreshed. Otherwise the new refresh token is revoked and the call fails
  as signed out. A sign-out that comes during a refresh waits for it, then
  revokes the new refresh token.
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
- **P7.** `settingsVersion` is the settings file's version plus the time
  zone's version, read through a `timezone` option of `createAuth`. Both
  only grow, so the sum grows on any change. Until sprint 8 provides the
  time zone setting, it reads `America/Denver`, `default`, version 0. A
  token refresh does not change the version.
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
  start, since the key can be entered in the app.
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
- **P23.** The lock (item 4) covers the steps that call OpenAI between
  their read and their write. The settings writes (provider, model, Meta
  key) do not take it: each is one read and one write with no wait in
  between, and it re-reads the file, so it never writes back an old
  session. Between processes, a settings write and a token write that land
  in the same instant can still lose one of them.
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
  checks again, for a key replaced under the same `kid`.
- **P28.** A Meta error message is `Model call returned HTTP <status>`
  with the API's error type and code when they are lower-case identifiers.
  It never holds body text, which extraction would write to the event
  log. Error types, codes and params on every provider must now start with
  a lower-case letter, so mixed-case text that could be an echoed key is
  dropped.
- **P29.** The ChatGPT client checks the model it sends right before the
  request, and the model always comes from the connection's listing with
  contributor models removed.
- **P30.** The scan also reads every `.json` file up to 8 MB as JSON, on
  disk and in history, and matches the Meta key across the two lines the
  settings file writes it on. Angle brackets are not key characters, so a
  `<META_KEY>` placeholder is not a hit.

## What the server cannot control

- A provider receives the case data the agent reads, under its own terms.
  `store: false` asks it not to keep the response.
- Anyone who can read files as the app's OS user can read the secrets
  file, as with the event log.
- The live sign-in and live calls on both providers are untested here.
  The tests run against offline fakes of the documented endpoints. The
  coordinator and Jeff run the live sign-in.
