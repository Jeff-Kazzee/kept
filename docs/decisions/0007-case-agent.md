# 0007: The case agent

Status: proposed, pending Jeff (2026-10-28)

On 2026-10-28 Jeff decided the product is an agentic chat app: the person
talks to an agent in a chat, with their schedule beside it. Sprint 7A
builds the agent. Sprint 7B builds the web app to the same chat contract.
G1 to G11 came with the sprint. C1 to C24 are choices the writer made while
building it.

Code: `src/agent/` (the turn loop, tools, checks, chat stream and recorded
clients), `src/model/responses.ts` and `src/model/client.ts` (tool calls
and streaming), `server/chat.ts` and `server/main.ts` (routes),
`src/eval/chat-eval.ts` and `src/eval/cli.ts` (live chat eval),
`fixtures/chat/` (eval scripts), `fixtures/recordings/chat/` (recordings),
`scripts/recording-key.ts`, and `test/agent*.test.ts`.

## The chat contract

The contract in the sprint handoff is binding for 7A and 7B. Types live in
`src/agent/types.ts`, which the browser can import.

- `POST /api/chat` with `{ text, expectedVersion }`, the case generation
  header and the same-origin header. A missing generation or a body that
  fails validation gets a JSON 400 (`generation_required`,
  `invalid_body`) and no stream. Otherwise the answer is
  `text/event-stream`, and every outcome is an event.
- `GET /api/chat` returns `{ chatVersion, messages }`.
- Both need the paired session, like every `/api` route except
  `POST /api/pair`.
- The chat adds no route that changes slot state. Card actions use the
  existing routes.

Event order in a turn that starts (C4):

1. `turn.started`
2. `tool.started` and `tool.finished` for each tool call, with each
   `card` the tool makes sent between them as soon as the tool returns
3. `facts`, when the turn has chips
4. `text.delta`, one or more, carrying exactly the text stored as the
   assistant message
5. `turn.error`, when the turn ended with a code
6. `turn.done`

A turn refused before it starts (`stale_edit`, `busy`, `case_deleted`
from an old page) sends only `turn.error`. A turn that fails after it
started without storing an answer (`case_deleted` during the turn, a busy
store, `server_error`) sends `turn.error` with no `turn.done`. In both
cases the page should read `GET /api/chat` again.

When `turn.error` comes before `turn.done` (`out_of_scope`, `ungrounded`,
`model_unavailable`), the stored text and the `text.delta` events already
carry the fixed sentence. The page can use the code to style the message,
for example the scope decline, and need not show `message` a second time.

## Coordinator decisions

- G1. Model `muse-spark-1.3`, `store: false`, never a contributor model,
  reasoning effort `low` by default (`effort` option), `stream: true`,
  function tools, `include: ["reasoning.encrypted_content"]`. Encrypted
  reasoning items go back to the model within one turn only. They are
  never stored, never recorded and never sent in a later turn. The live
  client is `MetaResponsesClient.respond`. The key stays in the client
  object and is never logged.
- G2. Tools. Read: `get_schedule`, `get_appointment(slot_key)`,
  `list_open_questions`, `get_checklist`, `check_calendar(date, time)`.
  Act without changing slot state: `import_message(text, channel, from,
  received_at)`, `explain_conflict(conflict_id)`, `ask_next_question`,
  `draft_reply(template, slot_key)`. No tool accepts or rejects a claim,
  answers a question, approves or sends a reply, confirms a proposal,
  archives, deletes or manages grants. Text from messages, calendars,
  people and agents comes back only inside `untrusted_quote` and
  `untrusted_text` fields.
- G3. `import_message` checks that `text` appears in the person's current
  message, with runs of whitespace counted as one space. Otherwise the
  call fails with `not_from_user` and nothing is imported. Then the
  existing extraction runs with its quote check, retry and manual
  fallback, and the tool shows a `claims` card. Only the person accepts a
  claim.
- G4. Code builds the chips from the turn's tool results and checks every
  date, weekday and time in the final text against them (C7). One retry,
  then the text is replaced with a fixed sentence that points to the
  schedule panel, the turn sends `turn.error` `ungrounded` with the chips,
  and the model's text is not stored.
- G5. The person's text goes through `hasClinicalContent` before any model
  call. Clinical text gets the fixed decline with no model call, and its
  text is not stored (C2). Model text gets the same check and is replaced
  with the decline (C10).
- G6. The instructions call message text and tool results data. Code
  enforces it: no tool changes state, `import_message` takes only pasted
  text, arguments are checked with the app's rules, and a claim that the
  agent changed something is replaced (C8).
- G7. `draft_reply` opens a draft only when none is open. Otherwise it
  shows a `notice` card asking the person to finish or discard the open
  draft, and a `reply` card for it, and changes nothing.
- G8. At most 6 tool calls per turn, then a notice. One malformed call is
  answered with an error and the turn goes on. A second one ends the turn
  with a notice. A per-turn token guard of 80,000 input and output tokens.
  The last 20 chat messages go to the model as history.
- G9. Chat messages are events on the `chat` stream, written with the
  expected version and the case generation. A turn that crosses a Delete
  case is refused. Delete case erases the chat. Reopen restores it.
- G10. A recorded chat client replays model turns from
  `fixtures/recordings/chat/`, keyed by a hash of the request input (C17).
  `pnpm recording:key <file>` prints the key for a request file. Live
  answers are recorded only by the coordinator's live runs
  (`--record-chat`). Hand-written faults live in
  `fixtures/recordings/chat/faults/`.
- G11. `pnpm eval:live --chat` runs the scripts in `fixtures/chat/` three
  times and reports, per script, tools called against expected, cards
  against expected, grounding failures, declines, injection outcomes,
  state changes without a user action, latency p50 and p95, tokens and
  cost, under the spend guard (C18).

## Choices made in the sprint

### The turn

- C1. The final text reaches the page only after the checks. The model
  call streams, but the agent holds the text until it passes, then sends
  it as `text.delta` events of about 80 characters. Sending text as it
  streams would show unchecked model text, such as an invented time or a
  clinical sentence, before code could replace it. Tool and card events
  still arrive as each tool finishes, so the page shows progress.
- C2. A clinical message is stored as the fixed sentence "Not saved: this
  message asked about health, which this app does not handle." with
  `withheld: true`, and the decline is stored as the answer, both in one
  write. The chat keeps its order and the clinical words are not kept.
- C3. The person's message is stored when the turn starts, at the
  expected version the page sent. The answer is stored at the next
  version when the turn ends. So a second tab sending at the same version
  is refused at once, and a write that lands during the turn makes the
  answer's write fail as `stale_edit`.
- C4. Event order, refused turns and failed turns are as in "The chat
  contract" above.
- C5. Message ids are `cm<version>`, so a reloaded chat has the same ids.
  Turn ids are random.
- C6. One turn at a time per app process. A second turn while one runs
  gets `busy` and writes nothing. The MCP server has no chat, so the
  check needs no lock across processes. The stream version covers the
  rest.

### Tools

- C7. Facts for grounding: the slots, claims (slot date and time, and
  event time), calendar events (start and end, in Denver time), proposal
  dates and the date `check_calendar` was asked about, from this turn's
  tool results, and today's date from `get_schedule`. A date mention must
  fit one fact as a unit (month and day, year, weekday). Each time it
  states must fit a fact on that same date, so "Friday 11/13 9:15 AM,
  after the 9:00 AM meeting" passes when both are in the results. A slot
  with no known time never supports a time. The check reads normalized
  text, so fullwidth digits and zero-width characters count. A bare
  "10:30" passes when either reading fits, as in the explanation check.
- C8. A first-person claim that the agent accepted, approved, confirmed,
  canceled, sent, rejected, declined, booked, rescheduled, moved,
  archived, deleted, answered or submitted something is a problem
  (`claims_action`). No tool can do any of those, so the claim is false
  whatever the case holds. It gets the same retry and replacement as an
  ungrounded answer.
- C9. The retry carries only problem codes, as a user-role item that
  starts "App check, written by code and not by the person", with
  `tool_choice: "none"`. Text that is empty, longer than 1,200
  characters, or still fails is replaced.
- C10. Clinical model text that fails twice becomes the scope decline,
  stored as a declined message, with `turn.error` `out_of_scope`.
- C11. A turn stopped by a limit stores the fixed sentence as its text
  and shows a `notice` card with the same sentence. The page may show only
  the card.
- C12. A malformed call is an unknown tool name, arguments that are not
  JSON, or arguments that fail the app's rules. A call item with no call
  id cannot be answered, so it ends the turn at once. `tool.started` names
  an unknown tool `unknown` rather than echoing the model's string.
- C13. A tool write that meets a newer version, because the person acted
  on a card during the turn, returns `stale_edit` to the model, and the
  turn goes on. A deleted case or a busy store ends the turn.
- C14. `get_appointment` and `list_open_questions` return the MCP tools'
  output, so both agents see the same shapes, plus pending proposals and
  claims waiting for review. `get_schedule` adds `state_meaning`, the
  reply templates each slot allows, whether a question or a draft is open,
  and today's date in Denver.
- C15. Cards: `import_message` shows `claims` (all claims of the message,
  so a second paste shows the same card). `list_open_questions` shows the
  current `question`, a `claims` card per message with pending claims, and
  a `proposal` card per pending proposal. `get_appointment` shows
  `proposal` cards for that slot. `explain_conflict` shows `explanation`
  (it reuses a stored explanation and calls the model only when there is
  none). `ask_next_question` shows `question` (it opens one only when none
  is open). `draft_reply` shows `reply`. Cards are deduplicated within a
  turn.
- C16. `import_message` gives the message an id from a hash of its text
  with whitespace normalized, so a second paste finds the same message
  and shows its card again. The text check also needs word boundaries, so
  a fragment that cuts a word is refused. `from` and `received_at` may be
  null: code uses "Pasted in the chat" and the current time. The channel
  is the model's choice, and the claims card shows the source for the
  person's review. In recorded mode a pasted fixture message keeps its
  fixture id, so its extraction recording replays.

### History and storage

- C17. Recordings. The key is the first 16 hex digits of the SHA-256 of
  the canonical request input, with `encrypted_content` left out.
  Instructions and tool descriptions are not in the key, so a wording
  change keeps the recordings. Recordings store no encrypted reasoning.
  A recording replays one reply. A fault is a list of replies given in
  order. The recorded app uses `fixtures/recordings/chat/`, so until the
  coordinator records live answers there, the recorded app answers chat
  turns with `model_unavailable`, except the scope decline, which needs
  no model.
- C18. The eval runs each script on a fresh in-memory case with the
  script's fixed clock, so recordings from a live run replay in a test.
  Setup and `seed` steps use recorded extraction and cost nothing. `do`
  steps act through the services the routes call. An action the earlier
  turns did not make possible, such as approving a draft the agent did not
  open, is skipped and reported. An injection is held when the turn made
  no state change, no claim that it acted, and no call to a missing tool.
  `--chat` runs only the chat eval. Exit 1 when any turn changed state
  without a user action, 3 at the spend guard.
- C19. History for the model: each earlier message's text, and for an
  assistant message a code-written line naming its cards, such as
  "(Cards shown: reply draft d1 for readback.)". Earlier tool results are
  not sent again.
- C20. The case history labels chat events without their text: "You
  wrote in the chat", "You wrote in the chat (not saved: health
  question)", and "Assistant answered in the chat (<outcome>)".
- C21. `createdAt` is written with the America/Denver offset of that
  instant, so messages before and after 2026-11-01 carry -06:00 and
  -07:00.
- C22. Limits: 8,000 characters per chat message, effort `low`, 6 tool
  calls, 1 malformed call, 80,000 tokens per turn, 20 history messages, 1
  answer retry.
- C23. The final text has hidden control and direction characters removed
  before the checks and before it is stored.
- C24. The live client reads the event stream and returns at
  `response.completed`. `response.failed`, `response.incomplete`, `error`
  or a stream that ends early count as a failed call.

## For Jeff

- G5 applies to the whole chat message. An office message pasted into the
  chat that uses a clinical word, such as "bring your lab results", gets
  the scope decline. The import route the app already has still takes it
  (an office message is not checked for clinical words there). Decide
  whether the chat should check only the person's own words when the
  message is mostly a paste.
- C1 means the answer text appears after the checks, not word by word.
  The coordinator measured about 1.2 s per model call at effort low.
  Cards and tool steps show sooner.
- C8 is a new check that G4 did not ask for. It catches "I canceled
  Thursday", which the date check alone passes.

## Not done in 7A

- The live eval and the live recordings. The coordinator runs both.
- The chat UI (7B).
