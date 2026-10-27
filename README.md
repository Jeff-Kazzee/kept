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

## D5: records and the MCP server

- `src/records/` is the one domain service for appointment records: notes,
  tags, archive, undo and changes proposed by agents. The app and the MCP
  server both call it.
- `src/grants/` holds grants and the `pnpm grant` command.
- `mcp/` is the MCP server. It runs over stdio and opens no network port.

See `docs/decisions/0001-stack.md` for the stack and dependency checks,
`docs/decisions/0002-slot-states.md` for the slot rules,
`docs/decisions/0003-reply-templates.md` for the reply rules, and
`docs/decisions/0004-mcp-core.md` for records, grants and the MCP server.

## Commands

Node 24 and pnpm 10.33.2.

```sh
pnpm install
pnpm test        # offline, no key needed
pnpm typecheck
pnpm dev         # http://127.0.0.1:5180 with recorded model responses
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
you create a grant.

1. Create a grant. Pick a name you will recognize and the lowest tier that
   does the job:

   ```sh
   pnpm grant create --name "Laptop assistant" --tier read
   ```

   | Tier | The agent can |
   |---|---|
   | `read` | List appointments, read one appointment with its evidence and history, list open questions |
   | `annotate` | Everything in `read`, plus add notes and set tags |
   | `propose` | Everything in `annotate`, plus send proposed changes to your review queue |

   The command prints a token once. Copy it now. It is not stored and
   cannot be shown again. Treat it like a password. Do not paste it into a
   chat, a screenshot or a file in this repository.

2. Add the server to your MCP client's config. The client starts the server
   itself with Node 24. Put the token in the server's environment there:

   ```json
   {
     "mcpServers": {
       "appointments": {
         "command": "node",
         "args": ["/path/to/meta-hackathon-appointments/mcp/main.ts"],
         "env": { "APPT_GRANT_TOKEN": "<the token from step 1>" }
       }
     }
   }
   ```

   The server opens the app's event log (`data/app.sqlite`, or `APP_DB` if
   you set it for the app). Use the same file as the app, or revoking a
   grant will not reach the agent.

3. To stop an agent, revoke its grant. Its next call fails, even if the
   client is still running:

   ```sh
   pnpm grant list
   pnpm grant revoke <id>
   ```

What an agent can never do, under any tier: confirm, cancel or change an
appointment's state, date, time or place directly, contact an office, send
or approve a reply, confirm its own proposals, delete the case, or manage
grants. A proposed change waits in your review queue until you confirm it
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
