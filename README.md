# Appointment change assistant

A tool that helps a person keep track of appointment changes from messages
they paste in. It handles administrative facts only: times, places,
confirmations, and what the office asked the person to bring or do. All data
in this repo is synthetic.

## D1: evidence intake

- `fixtures/` holds the synthetic scenarios S1 to S12, the demo calendar
  `calendar/dana.ics`, and hand-written model responses under `recordings/`.
- `src/domain/` holds claim types, the verbatim quote check, date and time
  checks, and the `.ics` reader.
- `src/store/` is the append-only event log on `node:sqlite`.
- `src/model/` is the model client interface, the Meta Responses client and
  the recorded client.
- `src/extract/` runs one extraction with at most one retry.
- `src/intake/` records extraction results and review decisions as events.
- `src/eval/` and `scripts/eval-live.ts` run the live evaluation.
- `server/` and `ui/` are the local server and the web app: the chat
  beside the schedule (sprint 7B, `docs/decisions/0008-web-app.md`).

## D2: slot states and conflict resolution

- `src/slots/` turns accepted evidence into slot states by a fixed
  transition table, raises conflicts and checks calendar clashes. It reads
  only accepted evidence, so model output never changes a slot.
- `src/conflicts/` holds the two model calls, explain a conflict and
  propose the next question, with the code checks on citations and dates.
- `src/case/` loads the calendar into the case, keeps one open question at a
  time and records each answer as user-reported evidence.
- Each scenario in `fixtures/scenarios/` states its D2 checkpoints, and
  `test/scenarios.test.ts` runs them.

## D3: reviewed reply

- `src/reply/` holds the four reply templates, the code that checks each
  template against the slot's state and fills every field from the case,
  the model call that picks a template and a slot, and the reply commands.
- The user replies only through a template. Code fills the fields, the UI
  reads each one back with its source, and approval needs every field
  ticked. Edited text shows "Edited by you. Not checked."
- Approval records what the template asserts as user-reported evidence.
  An accepted slot becomes "Requested · reported by you". Sending is
  simulated: it writes a local event and the UI shows "Simulated. Nothing
  was sent." No network call is made.
- The model picks a template and a slot from the user's note, or answers
  that no template fits. Code rejects a pick whose slot is not a date or
  time the note states.
- A health question the user types gets a fixed decline that states the
  app's administrative scope. Nothing is recorded and no model is called.
- Each scenario in `fixtures/scenarios/` states its D3 checkpoints, and
  `test/scenarios.test.ts` runs them.

## D4: saved outcome, checklist and Delete case

- The case lives in the event log, so closing and reopening the app
  restores it exactly: slot states, conflicts and the open question,
  explanations, the open reply draft with any edit, and the checklist.
  Readback ticks are not saved. After a reopen you read each field again.
- A late reply from the office goes through extraction and review like
  any other message. Its claims change nothing until you accept them. A
  reply draft it overtakes says "The office replied. This draft no longer
  fits." and cannot be approved.
- The checklist lists what the office asked you to bring or do. It is
  built by code from the office requests you accepted, and each item shows
  its quote and its source: "office message", "reported by you" or "added
  by the assistant". Requests in the same words are one item with every
  source.
- The case history lists every event of the case in order, including undo,
  with labels built by code.
- Delete case is the only permanent deletion. It runs only from the app,
  after you type DELETE. It erases every message, claim, review, slot,
  question, explanation, reply, note and tag of the case, the activity log
  and the log of agent calls. It then rewrites the database file and
  empties its WAL, so the removed text is gone from disk, not only hidden.
  Settings, such as the time zone, stay. An MCP server that has the file
  open keeps running and finds no case. No agent or MCP tool can delete a
  case. A command that started
  before the delete, such as a model call, a page opened earlier or an
  agent's call, saves nothing afterwards. If the app stops before the file
  is cleared, the app or the MCP server finishes clearing it at the next
  start.

## D5: records and the MCP server

- `src/records/` is the one domain service for appointment records: notes,
  tags, archive and undo.
- `src/actions/` is where every action on the case is defined, for you in
  the app, the assistant and an external agent over MCP. Each one runs the
  domain command with its checks and expected versions and writes an
  activity entry you can undo (`docs/decisions/0009-agent-first.md`).
- `mcp/` is the MCP server. It runs over stdio, opens no network port and
  offers the same tools as the assistant, with the same rules.
  `scripts/mcp-stdio.sh` starts it with `APP_DB`. There is no token or
  grant: whoever can start it can already open the database file.
- The open app checks every 2 seconds for changes by the MCP server or
  another tab and reloads the case view, so an agent's note shows without
  a restart.
- Archive hides an appointment from the slot list, the question queue and
  the reply panel. Undo brings it back.
- `pnpm scan:secrets` checks the repository for the model API key. See
  "What the secret scan finds" below for exactly what it covers.
- The app has no pairing code. It answers only to its own host names and
  takes a change only from its own page, and it is reachable only from this
  computer and, through a private proxy, your own devices.

## The case agent (chat)

- `src/agent/` is the agent: a tool loop on Muse Spark that works the case
  for you. It imports messages you paste and accepts or rejects their
  facts, answers the open question, archives, notes, tags, sets the time
  zone, and starts or discards a reply draft. Each action shows in the
  chat as it happens and in the activity log with Undo. Only you approve a
  reply (the simulated send) and only you delete the case.
- Code still enforces every rule: the quote and extraction checks, the
  slot rules (a slot's state comes only from an office message or your own
  report), expected versions, and the checks on every answer: each date,
  weekday and time must come from the turn's tool results, the text must
  stay administrative, and it may say the agent did something only when
  the activity log shows it did. After one retry, code replaces an answer
  that fails.
- A message that may hold a paste (a line break, more than 280
  characters, or a line that starts like `Name:` or with a quote mark) only
  adds messages and reviews their facts. Anything else waits until you ask
  in a short message of your own. When text may be your own report, the
  chat asks "Record this as your own report?", and its facts wait for your
  answer. A report an agent makes changes nothing until an office message
  or your own report agrees.
- `POST /api/chat` answers with server-sent events and `GET /api/chat`
  returns the chat.
- Every time is in the case's time zone, which you or the assistant set.
  Loading the demo sets America/Denver, the demo clinic's zone, as an
  action you can undo.
- The chat is saved with the case. Delete case erases it.

See `docs/decisions/0001-stack.md` for the stack and dependency checks,
`docs/decisions/0002-slot-states.md` for the slot rules,
`docs/decisions/0003-reply-templates.md` for the reply rules, and
`docs/decisions/0004-mcp-core.md` for records and the MCP server,
`docs/decisions/0005-saved-outcome.md` for the saved case, the
checklist and Delete case, `docs/decisions/0006-mcp-app.md` for agent
access in the app, `docs/decisions/0007-case-agent.md` for the case
agent and the chat contract, `docs/decisions/0008-web-app.md` for the
web app, `docs/decisions/0009-agent-first.md` for the agent that acts,
the activity log and the case time zone,
`docs/decisions/0010-providers.md` for the model providers and sign-in,
and `docs/decisions/0011-ui-polish.md` for the agent UI. `docs/diagrams.md` shows the slot states and the agent change
flow.

## Commands

Node 24 and pnpm 10.33.2.

```sh
pnpm install
pnpm test        # offline, no key needed
pnpm typecheck
pnpm dev         # http://127.0.0.1:5180 with recorded model responses
pnpm build       # production bundle in dist/ui, precompressed, budget checked
pnpm start       # serves the production build on http://127.0.0.1:5180
pnpm scan:secrets  # tokens and keys in the repository, see "What the secret scan finds"
```

With `pnpm dev`, add `?mockchat=1` to the page address for the scripted
chat, which plays the demo through the existing routes with no model. Its
replies are labeled "Scripted demo reply, not a model". It also turns on a
development fake of the routes that do not exist yet: the model provider,
the model, sign-in and Google. The time zone, activity and undo are the
real routes (`docs/decisions/0011-ui-polish.md`, U37). The production
build (`pnpm build`, `pnpm start`) leaves both out and ignores the
parameter.
`APP_UI_FAKES=1 pnpm build` makes a check build with them, for a browser
check of the minified bundle. Never ship that build.

To reach the app through a private proxy on the same computer, such as
Tailscale serve, list its host names in `APP_ALLOWED_HOSTS`
(comma-separated). The app still binds 127.0.0.1. See
`docs/decisions/0008-web-app.md`.

Live model in the UI: set `APP_LIVE_MODEL=1`. The assistant then runs on
the provider and model chosen in the app's settings, and only on that one:
your own Meta Model API key (the default, entered in the app or as
`MODEL_API_KEY` through varlock), or Sign in with ChatGPT, which uses your
ChatGPT plan. The provider in use receives the case data the assistant
reads, with `store: false` on every request. Meta's models are Muse Spark
1.3 (default) and Muse Wonder 1.0. ChatGPT's are the ones your account
lists. See `docs/sign-in.md` for both options, and
`docs/decisions/0010-providers.md` for the design. The ChatGPT sign-in
finishes only in a browser on the computer that runs the app, or through
an SSH tunnel to its port.

Live evaluation (needs `MODEL_API_KEY`):

```sh
pnpm eval:live --max-usd 5 --out eval-results/run.json
```

It runs every fixture message three times at reasoning effort `minimal`
and three times at `low`, and writes a JSON report. The app extracts at
`minimal` by default. `low` stays available in the UI and the API.

Add `--d2` to also run the explanation and question calls over the conflict
states in the D2 fixtures, three runs at effort `low` (`--d2-effort` sets
it). `--d2-only` runs only those calls. The conflict states are built with
recorded extraction, so `--d2-only` spends nothing on extraction. The report
gives the valid-citation rate, rejections by reason, fallbacks, latency p50
and p95, tokens and estimated cost. The spend limit covers the whole
command.

Add `--d3` to also run the reply template call over the suggest steps in
the D3 fixtures, three runs at effort `low` (`--d3-effort` sets it).
`--d3-only` runs only that call, and with `--d2-only` it runs the D2 and D3
calls with no extraction. The case states are built with recorded
extraction. The report gives the valid-template rate, the rate at which the
model's own final pick matches the expected one, the rate at which the
system outcome does, how often the model answered that no template fits
and how often it proposed a pick where none fits, rejections by reason, fallbacks to manual entry, latency p50 and p95,
tokens and estimated cost.

The pass criterion for each effort level is pooled accuracy across its three
runs of at least 95%, because the criterion is stated over three runs. The
report also gives the lowest single-run accuracy and flags any run below 95%,
so one weak run is not hidden by the pool. Accuracy is matched / (matched +
missed + extra). A claim matches when claim type, date and time match, and
location and sender kind match where the fixture states them.

`--chat` runs only the chat eval: the scripted conversations in
`fixtures/chat/`, three runs each (`--chat-runs`, `--chat-script`,
`--chat-effort`). The report gives, per script, tools, actions and cards
against expected, grounding failures, declines, injection outcomes,
actions that cannot be undone, replies sent without you and slots whose
state no office message or report of yours supports (it exits 1 if either
of the last two happens), latency, tokens and cost.
`--record-chat` writes each live answer as a recording in
`fixtures/recordings/chat/`. `pnpm recording:key <request.json>` prints
the key a request is recorded under.

`--provider meta|chatgpt` picks the provider (default `meta`, which needs
`MODEL_API_KEY`). `chatgpt` uses the ChatGPT connection the app saved:
sign in in the app first. `--model <id>` picks the model on that provider.
The spend limit prices tokens at the Meta rates on both.

A relative `--out` path resolves from the package root. `--recorded` replays
the recorded responses instead, for a smoke test with no key.

Stored case data stays on the host in `data/` (ignored by git). There are no
analytics.

## Use your appointments from an agent (MCP)

The MCP server lets an agent you already use work your case with the same
tools and rules as the in-app assistant. `docs/connect-agent.md` gives the
one command for Grok Build, OpenCode and Claude Code.

Run the agent with only the tools it needs. An agent that runs as your OS
user and has a shell or file tools can read and change the app's files,
its database included. The agent client's own tool permissions are the
real control.

What an agent can never do: approve or send a reply, edit a reply's text,
enter a fact by hand, delete the case, or set a slot's state from its own
words. A slot's state comes only from an office message or your own
report. Notes and tags hold administrative content only. A clinical one is
refused with the tool error `out_of_scope` and nothing is written. Every
action is in the activity log as "an external agent", with Undo, and every
call is in the case history.

Your agent's model provider may receive the case data the agent reads.
Appointment times, places, notes and quotes from your messages go to that
provider under its own terms, not this app's.

Text from imported messages is returned to the agent only inside fields
named `untrusted_quote` or `untrusted_text`, and the tool descriptions tell
the agent to treat it as data. That lowers the risk of a message steering
the agent, but it cannot remove it. The server's own checks do not depend
on the agent following those labels.

## What the model does and what code checks

The app uses a language model for five jobs. Each one only proposes. Code
checks the output, and you review what is left.

| The model | Code checks | You |
|---|---|---|
| Extracts claims from a pasted message | Each quote must appear verbatim in the message, and dates and times must have a valid format. A claim that fails is rejected and shown as rejected. | Accept or reject each claim. Only accepted claims count. |
| Explains a conflict | Every cited evidence id must exist and belong to the conflict. After two failures the conflict shows with its quotes and no explanation. | Read the sources beside it. |
| Proposes the next question | The question must name an open conflict and no invented date. After two failures code uses a fixed wording. Code builds the answer choices. | Tap a choice. |
| Picks a reply template and a slot | The template must fit the slot's state, and every field comes from the case, not the model. C1: when your note states a date or time, the picked slot must match it. The model may also answer that no template fits (`time_not_offered` or `template_not_allowed`), and you pick by hand. | Read back every field and approve. |
| Answers in the chat and acts on the case | Every action runs the app's own checks: imported text must be whole lines of your message, a claim it accepts must pass the quote and extraction checks again, an answer it gives may not set a slot's state, and every write states its expected version. Every date, weekday and time in the answer must come from the turn's tool results, the answer must stay administrative and may claim only the actions the activity log shows. After one retry code replaces the answer. | Undo any action from the activity log. Read back and approve a reply. |

Slot states come only from accepted evidence by a fixed table of rules. No
model output changes a slot. A schema-valid answer can still change the
meaning, which is why the C1 guard exists: in the live evaluation the model
once answered "Please accept Wednesday" with "decline Tuesday", and code
now rejects a pick that does not match the dates in your note. Times you
did not state, or whose order is unknown, are never treated as known. The
app raises a conflict instead. Health questions get a fixed decline and
never reach a model.

Agents act through the same actions as you, and the same split applies.
Code names the agent (the assistant, or an external agent over MCP), never
the client. An agent's answer to a question that would set a slot's state
is refused, and you answer it. Every write states the version it expects,
and a stale one writes nothing.

## What the server cannot control

Once the MCP server returns data to an agent's client, it is out of the
app's hands:

- The client's model provider receives what the agent reads, under that
  provider's terms. The app cannot recall it or limit how long it is kept.
- The agent may repeat, summarize or misread what it read. The labels
  `untrusted_quote` and `untrusted_text` tell it that message text is data,
  but a model can still follow an instruction hidden in a message. The
  server's own checks do not depend on the agent obeying the labels, so a
  steered agent still cannot send a reply, delete the case or set a slot's
  state from its own words. It can accept or reject facts, archive or
  note, and each of those is in the activity log for you to undo.
- An agent with a shell or file tools on the app's host, or one that can
  `ssh` to it, is not limited by the MCP tools. It can open the database
  file and change the app's other files. Give agents only the MCP tools.
- The rate limit (60 calls a minute in each server process) and the
  access log in the case history show what an agent did. They do not stop
  an agent that stays under the limit.

`docs/diagrams.md` shows the agent change flow.

## What the secret scan finds

`pnpm scan:secrets` reads every tracked file on disk and every tracked
path, every object reachable from any ref (the bytes of every blob, binary
ones included, the text of every commit and tag, and every file and folder
name in every tree), and every ref name. That covers old versions, merge
results and other branches, including session checkpoint refs.

In each of those it finds, on one line:

- An assignment of `MODEL_API_KEY` with a value of at least 12
  characters, as in an env file or a shell line. `MODEL_API_KEY=` with
  nothing after it, as in `.env.schema`, a reference such as
  `$MODEL_API_KEY` and a placeholder such as `<your key>` or a log tool's
  `REDACTED` do not count. The value ends at a space, a quote or a
  backslash.
- A bearer token: `Bearer ` and at least 24 token characters with an
  upper-case letter, a lower-case letter and a digit.
- A provider secret in the shape the app's settings file stores it: an
  `accessToken`, `refreshToken`, `access_token`, `refresh_token` or
  `id_token` field with a token value, or a `"meta": { "key": ... }` field.
- A file or folder named like the settings file (`app-secrets.json`) or a
  local env file (`.env.local`, `.env.<name>.local`), in the tree or in
  history.

The key's own shape is not known to the scan, so it does not find a bare
key written without its name or `Bearer`, a provider key or token outside
those field shapes, a key in another encoding (base64, URL encoding,
UTF-16, compression or encryption) or split across lines, or anything
outside this repository: other clones, `.env.local`, the database file,
logs and screenshots elsewhere. It prints where a hit is, never the
matched text, and exits 1 on any hit.
