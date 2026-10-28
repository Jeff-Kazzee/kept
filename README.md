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
- `server/` and `ui/` are the local server and the minimal UI.

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
  its quote and its source: "office message", "reported by you" or
  "reported by you through <grant name>". Requests in the same words are
  one item with every source.
- The case history lists every event of the case in order, including undo,
  with labels built by code.
- Delete case is the only permanent deletion. It runs only from the app,
  after you type DELETE. It erases every message, claim, review, slot,
  question, explanation, reply, note, tag and proposal of the case, the log
  of agent calls and the rate-limit counters. It then rewrites the database
  file and empties its WAL, so the removed text is gone from disk, not only
  hidden. Grants stay, because they are app settings. Revoke them in the
  app's grant screen or with `pnpm grant revoke`. An MCP server that has the file open keeps running
  and finds no case. No MCP tool can delete a case. A command that started
  before the delete, such as a model call, a page opened earlier or an
  agent's call, saves nothing afterwards. If the app stops before the file
  is cleared, the app or the MCP server finishes clearing it at the next
  start.

## D5: records and the MCP server

- `src/records/` is the one domain service for appointment records: notes,
  tags, archive, undo and changes proposed by agents. The app and the MCP
  server both call it.
- `src/grants/` holds grants and the `pnpm grant` command.
- `mcp/` is the MCP server. It runs over stdio and opens no network port.
  `scripts/mcp-stdio.sh` starts it with a token file, for a client that
  runs it locally or through `ssh`.
- The app's "Agent access (MCP)" panel creates, lists and revokes grants.
  A new token is shown once.
- Changes an agent proposes wait in the app's review queue beside the
  extracted claims, labeled with the grant's name. Only you confirm or
  reject them, in the app.
- The open app checks every 2 seconds for changes by the MCP server or
  another tab and reloads the case view, so an agent's note shows without
  a restart.
- Archive hides an appointment from the slot list, the question queue and
  the reply panel. "Show archived" lists it with Undo.
- `pnpm scan:secrets` checks the repository for grant tokens. See "What
  the secret scan finds" below for exactly what it covers.
- The app prints a pairing code in its terminal when it starts. A browser
  enters it once and gets a session that lasts until the app restarts.
  Every route of the app's web API, reads included, needs that session,
  and every change must also come from the app's own page.

See `docs/decisions/0001-stack.md` for the stack and dependency checks,
`docs/decisions/0002-slot-states.md` for the slot rules,
`docs/decisions/0003-reply-templates.md` for the reply rules, and
`docs/decisions/0004-mcp-core.md` for records, grants and the MCP server,
`docs/decisions/0005-saved-outcome.md` for the saved case, the
checklist and Delete case, and `docs/decisions/0006-mcp-app.md` for agent
access in the app. `docs/diagrams.md` shows the slot states and the agent
change flow.

## Commands

Node 24 and pnpm 10.33.2.

```sh
pnpm install
pnpm test        # offline, no key needed
pnpm typecheck
pnpm dev         # http://127.0.0.1:5180 with recorded model responses
pnpm scan:secrets  # grant tokens in the repository, see "What the secret scan finds"
```

Live model in the UI: set `APP_LIVE_MODEL=1` and provide `MODEL_API_KEY` in
the environment.

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

A relative `--out` path resolves from the package root. `--recorded` replays
the recorded responses instead, for a smoke test with no key.

Stored case data stays on the host in `data/` (ignored by git). There are no
analytics.

## Use your appointments from an agent (MCP)

The MCP server lets an agent you already use read your appointment records
and, if you allow it, add notes and propose changes. Nothing is shared until
you create a grant. `docs/connect-agent.md` is the full guide, with the
client entries for Grok Build, OpenCode and Claude Code and the connect
test.

Run the agent with only the MCP tools. An agent that runs as your OS user
and has a shell or file tools can read and change the app's files, its
database included, whatever its grant allows. The app's paired session
and its web API checks raise the bar, but a process with a shell can open
the database file directly. The agent client's own tool permissions are the
real control. `docs/connect-agent.md` gives the exact settings for each
client.

1. Create a grant. Pick a name you will recognize and the lowest tier that
   does the job. In the app, use "Agent access (MCP)". Or, on the app's
   host:

   ```sh
   pnpm grant create --name "Laptop assistant" --tier read --token-file ~/.config/appointments/grant-token
   ```

   | Tier | The agent can |
   |---|---|
   | `read` | List appointments, read one appointment with its evidence and history, list open questions |
   | `annotate` | Everything in `read`, plus add notes and set tags |
   | `propose` | Everything in `annotate`, plus send proposed changes to your review queue |

   A token is `appt_` and 43 more characters. The app shows it once. The
   command writes it to the file, readable by you only, and does not print
   it. Only its hash is stored. Treat it like a password. Do not paste it
   into a chat, a screenshot or a file in this repository.

2. Add the server to your MCP client's config as a local command. The
   launcher reads the token file, by default
   `~/.config/appointments/grant-token`, so no token is in the config or on
   a command line:

   ```json
   {
     "mcpServers": {
       "appointments": {
         "command": "/path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh"
       }
     }
   }
   ```

   From another machine, the command is
   `ssh <host> /path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh`.
   The server can also read the token itself from `APPT_GRANT_TOKEN`, or a
   file named by `APPT_GRANT_TOKEN_FILE`. It refuses a token file that other
   users can read. It opens the app's event log (`data/app.sqlite`, or
   `APP_DB` if you set it for the app). Use the same file as the app, or
   revoking a grant will not reach the agent.

3. To stop an agent, revoke its grant in the app, or with
   `pnpm grant list` and `pnpm grant revoke <id>`. Its next call fails,
   even if the client is still running.

What an agent can never do, under any tier: confirm, cancel or change an
appointment's state, date, time or place directly, contact an office, send
or approve a reply, confirm its own proposals, delete the case, or manage
grants. Notes, tags and proposals hold administrative content only. A
clinical one is refused with the tool error `out_of_scope` and nothing is
written. A proposed change waits in your review queue until you confirm it
in the app. A confirmed change shows "reported by you through" the grant's
name. Every call is logged in the case history with the grant name, the
tool and the result.

Your agent's model provider may receive the case data the agent reads.
Appointment times, places, notes and quotes from your messages go to that
provider under its own terms, not this app's. Grant only what you are
comfortable sharing with it.

Text from imported messages is returned to the agent only inside fields
named `untrusted_quote` or `untrusted_text`, and the tool descriptions tell
the agent to treat it as data. That lowers the risk of a message steering
the agent, but it cannot remove it. The server's own checks do not depend
on the agent following those labels.

## What the model does and what code checks

The app uses a language model for four jobs. Each one only proposes. Code
checks the output, and you review what is left.

| The model | Code checks | You |
|---|---|---|
| Extracts claims from a pasted message | Each quote must appear verbatim in the message, and dates and times must have a valid format. A claim that fails is rejected and shown as rejected. | Accept or reject each claim. Only accepted claims count. |
| Explains a conflict | Every cited evidence id must exist and belong to the conflict. After two failures the conflict shows with its quotes and no explanation. | Read the sources beside it. |
| Proposes the next question | The question must name an open conflict and no invented date. After two failures code uses a fixed wording. Code builds the answer choices. | Tap a choice. |
| Picks a reply template and a slot | The template must fit the slot's state, and every field comes from the case, not the model. C1: when your note states a date or time, the picked slot must match it. The model may also answer that no template fits (`time_not_offered` or `template_not_allowed`), and you pick by hand. | Read back every field and approve. |

Slot states come only from accepted evidence by a fixed table of rules. No
model output changes a slot. A schema-valid answer can still change the
meaning, which is why the C1 guard exists: in the live evaluation the model
once answered "Please accept Wednesday" with "decline Tuesday", and code
now rejects a pick that does not match the dates in your note. Times you
did not state, or whose order is unknown, are never treated as known. The
app raises a conflict instead. Health questions get a fixed decline and
never reach a model.

Agents reach the case only through the MCP server, and the same split
applies. Code checks the grant on every call, writes the agent's name from
the grant and not from the client, and sends every change to a slot to
your review queue. Notes and tags are the only direct agent writes, and
clinical text is refused there too. Every write states the version it
expects, and a stale one writes nothing.

## What the server cannot control

Once the MCP server returns data to an agent's client, it is out of the
app's hands:

- The client's model provider receives what the agent reads, under that
  provider's terms. The app cannot recall it or limit how long it is kept.
- The agent may repeat, summarize or misread what it read. The labels
  `untrusted_quote` and `untrusted_text` tell it that message text is data,
  but a model can still follow an instruction hidden in a message. The
  server's own checks do not depend on the agent obeying the labels, so a
  steered agent still cannot change a slot, send a reply, delete the case
  or widen its grant through MCP.
- An agent with a shell or file tools on the app's host, or one that can
  `ssh` to it, is not limited by its grant. It can open the database file
  and change the app's other files. The paired session keeps it
  out of the app's web API only while it cannot read the app's terminal.
  Give agents only the MCP tools.
- Anyone who holds the token can use the grant until you revoke it. The
  token file must stay readable by you only. Revoking stops the next call,
  not data already read.
- The rate limit (60 calls a minute) and the access log in the case
  history show what an agent did. They do not stop an agent that stays
  under the limit from reading everything its tier allows.

`docs/diagrams.md` shows the agent change flow.

## What the secret scan finds

`pnpm scan:secrets` reads every tracked file on disk and every tracked
path, every object reachable from any ref (the bytes of every blob, binary
ones included, the text of every commit and tag, and every file and folder
name in every tree), and every ref name. That covers old versions, merge
results and other branches, including session checkpoint refs.

In each of those it finds:

- A grant token, `appt_` and 43 base64url characters, on one line or split
  across two adjacent lines at a line break.
- The same token in hexadecimal, on one line.
- A run of exactly 43 base64url characters with an upper-case letter, a
  lower-case letter and a digit, the shape of a token made before tokens
  had a prefix.

It does not find a token in any other encoding (base64 of the token, URL
encoding, UTF-16, compression or encryption), split into more than two
parts or with other text between them, a hex or unprefixed token split
across lines, or anything outside this repository: other clones, the
database file, logs and screenshots elsewhere. It prints where a hit is,
never the matched text, and exits 1 on any hit.
