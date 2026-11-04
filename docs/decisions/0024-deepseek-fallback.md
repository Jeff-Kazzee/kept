# 0024: The DeepSeek fallback on the server key

Status: sprint 22, from the coordinator's handoff of 2026-11-04. Choices
marked (proposed) are the writer's and wait for Jeff. 0010's rule stands: a
call never moves to another provider by itself. Every rule of 0014 stands
too: J12 no recorded answers, money in integer micros, holds, the daily and
judge caps, nothing secret in logs.

Code: `src/model/providers/deepseek-client.ts` (new), `factory.ts`,
`models.ts`, `messages.ts`, `src/hosted/config.ts`, `prices.ts`,
`metered.ts`, `src/model/usage-text.ts`, `server/hosted.ts`,
`server/workspace.ts`, `server/auth.ts`, `server/main.ts`, `mcp/main.ts`,
`scripts/scan-secrets.ts`, the banner in `ui/App.tsx`, the sign-in screen,
the Usage and Connections pages. Tests: `test/deepseek-fallback.test.ts`
(new), `ui/hosted/hosted.test.ts`.

## Why

Judging is under way, and the Meta key answers HTTP 402
`billing_not_configured`, so chat on the server key is down. That is an
operator's billing problem, not a fault in Meta's service. Meta remains the
normal model. This is a stopgap, and returning to Muse is one env change.

## The switch

`APP_SERVER_MODEL=deepseek` with `DEEPSEEK_API_KEY`. Unset, or `meta`, is
Meta, exactly as before: no notice, no new field in any answer, and a
DeepSeek key alone turns nothing on. Any other value stops the app at start,
as a typo in any setting does. To go back, unset `APP_SERVER_MODEL` and
restart.

- D1 Only the operator's setting moves calls. No error does, in either
  direction. A Meta 402 stays a Meta failure with the setting off, and a
  DeepSeek failure stays a DeepSeek failure with it on.
- D2 It applies to the server key only (`activeProvider`). A person's own
  Meta key or ChatGPT sign-in on a local app stays theirs. On the hosted
  site every call is on the server key, so every call moves.
- D3 Nobody can choose it. `PUT /api/settings/provider` refuses `deepseek`,
  and nothing stores it as the provider, so a person's Muse choice is intact
  on return. The kind is in `ProviderKind` only for a `modelProblem` row.
- D4 Key absent: the app still starts, with a plain start line. Local mode
  is not ready, so J12's guard refuses each model route and chat turn before
  anything is written, with J12's sentence: adding a Meta key or signing in
  with ChatGPT does work there, by D2. A hosted step is refused with "Model
  usage is paused", also before any write. It never goes back to Meta. No
  notice shows, because the notice says DeepSeek is answering, which would
  be false. The same goes for `APP_SERVER_KEY=off`. (proposed)

## The API

The handoff expected a chat completions shape. DeepSeek's docs, read
2026-11-04, describe a Responses format at `https://api.deepseek.com`, for
both current models, with function calls, the same server-sent events and
the same usage fields. So there is no shape to translate.
`DeepSeekResponsesClient` puts the existing Responses client at
`https://api.deepseek.com/responses`, which keeps `call`, `respond`, the
meter and every error sentence. DeepSeek's `store` and `include` are
ignored there, as its docs say unsupported fields are.

- D5 The model is `deepseek-flash` (DeepSeek-V4.1-Flash-1017), DeepSeek's
  current default, at about a quarter of the input price of
  `deepseek-v4-pro`. One model, no picker choice. (proposed)
- D6 Thinking is off: `reasoning: { effort: "none" }` on every call. With
  thinking on, a request with tools must hand back the reasoning of all
  earlier turns or DeepSeek answers 400, and the chat's history is plain
  text. Off, no reasoning comes back and none is billed. The app's code
  checks judge the answers as they do any model's. (proposed)
- D7 A JSON call also states its schema and the word JSON in the
  instructions. DeepSeek's docs call `text.format` fully supported in this
  format, but its JSON guide describes only `json_object`, needs the word
  JSON in the prompt, and says the content can come back blank. The words
  cover both readings. A blank answer takes the existing retry. (proposed)
- D8 DeepSeek always allows parallel tool calls. The agent's loop already
  runs every call in an output, counts each against the tool budget, and
  answers each, so the budgets hold.
- D9 An event with no `event:` line is named by its data's `type`, as the
  ChatGPT client already does. DeepSeek documents an event field, and this
  is the guard if a stream arrives otherwise. With `event:` lines, as Meta
  sends, the client reads as before.

## Money

- D10 `deepseek-flash` in `PRICES`: $0.30 input, $0.006 cached input, $1.20
  output per million, from https://api-docs.deepseek.com/quick_start/pricing,
  read 2026-11-04. Those are the peak rates. Off-peak is half, by the hour.
  The table has one price, so the peak rate applies at every hour: the
  ledger may show more than DeepSeek bills, and never less.
- D11 Holds, charges, releases and both caps are the same code at these
  prices. A 402 from DeepSeek is a refusal before the call ran, so its hold
  is released. Old charges keep their own model's label after the switch.
- D12 D7's words reach the model after the hold is taken. Tokens run well
  below bytes, so the bound still holds, and any usage beyond it is charged
  the hold, so a charge never exceeds its hold.

## What the person sees

- D13 The notice, word for word, in a banner on the app screen and on the
  sign-in screen, only while DeepSeek can answer.
- D14 The model reads `Fallback · DeepSeek Flash`, and `DeepSeek Flash` on a
  phone and in the usage table.
- D15 Connections says DeepSeek receives what the assistant reads, and the
  Usage page says DeepSeek reports the usage. The refusals that name Meta
  have neutral twins while the setting is on (`FALLBACK_USAGE_TEXT`), with
  the same codes.
- D16 Every attempt record says which model ran it. The request still names
  the code's default, and the DeepSeek client's `call` reports its model on
  the reply, or on the `ModelCallError`, so extraction, explanation, question
  and suggestion attempts store `deepseek-flash`, and `explanation.model` and
  `suggestion.model` answer it. A client that reports nothing leaves today's
  value, so off-mode records do not change, and rows already stored keep
  what they say. A person's own Meta key on a server with the fallback on
  records Muse, as Muse answered.

## Fix round 1

The independent review of `2798eeb` left two findings, both confirmed.

1. DeepSeek answers kept Meta attribution: attempts recorded the request's
   model, so `explanation.model` and `suggestion.model` said
   `muse-spark-1.3`. Now D16.
2. A missing key passed J12's guard in local mode: `ready()` answered true so
   the call could fail with its own sentence, but the failure was written,
   as failed attempts on the model routes, and as the message and the refusal
   in chat. `ready()` now answers false, so the refusal comes first. Now D4.
   `DEEPSEEK_KEY_MISSING_TEXT` remains for a direct call past the guard.

## Live check

On 5340 in hosted mode through `scripts/hosted/start.sh`, on a temporary
data folder, with no Meta key set, against a fake of DeepSeek's documented
format on 5341. Nothing reached DeepSeek or Meta.

- On: the start log said calls go to DeepSeek. In a browser the notice
  showed on the sign-in screen and on every app screen, word for word. A
  judge code signed in. The composer read `Fallback · DeepSeek Flash`.
- A chat turn called `get_schedule`, took the tool's result back and
  answered, in two calls, both with the fake's key, `deepseek-flash`,
  `reasoning.effort` none and `max_output_tokens` 8,192.
- The Usage page showed one chat turn of 2 calls on DeepSeek Flash at
  $0.0023, and the balance went from $2.00 to $1.99. That is 379.8
  micro-dollars a call at D10's prices, times 3, rounded up. Connections
  said DeepSeek receives the case text.
- Off, on the same data with `APP_SERVER_MODEL` unset: no start line, no
  notice and no `fallbackNotice` field, signed in or out. The composer read
  `Meta · Muse Spark 1.3`, and the fake got no more calls.

## Known limits

- No call has reached DeepSeek: there was no key. Everything here ran
  against fakes built from its docs. The first live chat and the first
  extraction are the real test of D6 and D7.
- DeepSeek's prices can change, and the table does not follow them.
