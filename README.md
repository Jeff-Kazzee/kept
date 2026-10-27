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

See `docs/decisions/0001-stack.md` for the stack and dependency checks.

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

It runs every fixture message three times at reasoning effort `low` and
three times at `minimal`, and writes a JSON report.

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
