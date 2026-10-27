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
- A health question the user types gets a fixed decline that states the
  app's administrative scope. Nothing is recorded and no model is called.
- Each scenario in `fixtures/scenarios/` states its D3 checkpoints, and
  `test/scenarios.test.ts` runs them.

See `docs/decisions/0001-stack.md` for the stack and dependency checks,
`docs/decisions/0002-slot-states.md` for the slot rules, and
`docs/decisions/0003-reply-templates.md` for the reply rules.

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
extraction. The report gives the valid-template rate, the rate of expected
picks, rejections by reason, fallbacks to manual entry, latency p50 and
p95, tokens and estimated cost.

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
