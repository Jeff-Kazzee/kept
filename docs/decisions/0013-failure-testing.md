# 0013: Failure testing and quality

Status: proposed, pending Jeff (2026-10-28). J12 is Jeff's decision. F1 to
F22 are the writer's choices and are proposed.

Sprint 12 fixes what breaks when judges and real users try the app. It
adds no features. Tasks SP12.1 to SP12.7 came with the sprint. SP12.3 was
replaced during the sprint by J12.

## J12: no recorded answers in the app (Jeff, 2026-10-28)

Recorded answers must never reach a person using the app. Judges and users
get the real agent or a plain message, never a replay.

- The server and the MCP server have no recorded mode. `APP_LIVE_MODEL` and
  the state's `mode` field are gone. Every chat, extraction, explanation,
  question and template call goes to the provider the person chose.
- With no provider ready (no Meta key from the person or the server, no
  ChatGPT sign-in), a chat turn is refused before it starts with
  `provider_not_ready`, and `POST /api/messages/:id/extract`,
  `/api/conflicts/:id/explain`, `/api/questions/next` and
  `/api/reply/suggest` answer 422 `provider_not_ready`. Each carries
  `NO_PROVIDER_TEXT`: "The assistant needs a Meta Model API key or Sign in
  with ChatGPT. Add one in Settings. Nothing in your case changed." The page
  shows it as written by code, with an Open Settings button. Nothing is
  written. The schedule, Activity, Undo, Settings and Delete case work
  without a model.
- "Try the demo" still loads the made-up Lantern Hill messages and
  calendar. Its offer says they are made up and that the assistant is live.
- The recorded and fault clients are test doubles that tests, the eval's
  `--recorded` flag and `pnpm demo:check --recorded` inject.
  `test/no-recorded.test.ts` walks every import from `server/main.ts`,
  `mcp/main.ts` and `ui/main.tsx` and finds no recorded client, and
  `test/bundle.test.ts` finds none in the production bundle.
- `pnpm demo:check` runs the live app. `--recorded` runs the same routes
  in process on the test doubles, and every line says "recorded, not a
  product run".
- The coordinator records no answers for the product.

This replaces 0010 P19 and 0011 U48's "(recorded)" label, and the recorded
mode notes in 0007 C16, 0008 B22 and 0009 A15.

## SP12.1: "Am I booked Monday?"

- F1. The cause, read from the code: `get_schedule` gave each appointment a
  `state_meaning` in words the answer check cannot map. The offered meaning
  said "You have not accepted it" and the change-proposed meaning said "not
  settled". Both words are in the check's list of status words that fail
  closed, and the model repeated them, so the answer and its retry failed
  with `state_mismatch` and code sent the fixed sentence. The meanings now
  use the check's own words: "The office offered this time. It is not
  booked until you ask for it and the office confirms." and "This time is
  confirmed, and the office proposed a change to it." The MCP server
  returns the same words. No check was loosened.
- F2. An answer word set off by a dash at the start of a sentence ("No",
  a dash, then "Monday 11/16 1:00 PM is offered") is a clause of its own,
  so its "no" does not negate the rest. A dash inside a clause still keeps its
  negation. A wrong day, time or state is still caught.
- F3. The retry message adds one fixed hint per problem code: for
  `state_mismatch`, the state words the tools give, and for `ungrounded`,
  to write each time with its date.
- F4. The turn report keeps each answer the checks refused, with its
  problems, and the chat eval report shows it under `rejected`. It is model
  output about synthetic data. It is never stored in the chat or sent to
  the page.
- Considered and left out: carrying a date into the next sentence through
  a pronoun for a time ("It is offered at 1:00 PM"). Review round 1,
  finding 4 decided that this fails, so it stays.

The live replaced answers are not read yet. The coordinator's live chat
eval shows them now.

## SP12.2: latency

- F5. A turn offers only the tools the case can use. The Google tools need
  the connection and its permission: the Gmail tools the Gmail permission,
  the calendar tools, reads included, the calendar permission. Without
  Google no Google tool is in the request, which removes about a fifth of
  the tool schemas (3.8 of 18.4 thousand characters). A call to a tool the
  turn did not offer is `unknown_tool` and runs nothing. One sentence in
  the instructions tells the model to point to Settings when the person
  asks about Gmail or Calendar and the tools are absent.
- F6. The turn report times each tool and each answer check. The chat eval
  report gives, per turn, each agent call with its kind, latency, first
  byte and tokens, each call a tool made (extraction, explanation,
  question, template) by key, each tool and each check, and per script the
  agent calls per turn, the p50 and p95 of each part and the input tokens
  per call.
- Waste found and not changed, for Jeff or a live A/B:
  - `import_message` makes the model copy the whole pasted message into
    its arguments. That is output tokens, the slow part, on every paste
    turn. An argument that names the pasted lines would avoid it, but it
    changes the tool contract E1 set.
  - The agent runs at effort `low`. `--chat-effort minimal` measures the
    other level.
  - `parallel_tool_calls` is false, so a turn that needs two reads makes
    two round trips. Changing it changes the request shape the live API
    accepted.
  - Each grounding retry resends the whole turn. F1 removes the retries
    the Monday question caused.

## SP12.3 as built before J12, and what stays

- F7. The chat recording key reads the turn's date (`today`) and the
  clock's full times in tool results (such as an imported message's
  `received_at`) as placeholders, so a test double made on one day replays
  on another. Replayed answers still pass the checks against the turn's
  facts.
- F8. `--record-chat` records only the agent's calls. Extraction and the
  other calls replay their test doubles, so the recordings replay with the
  same doubles. It writes test doubles, never product answers.
- F9. The chat eval loads the demo calendar through the same function as
  the calendar route (`src/actions/demo.ts`), with its `calendar_loaded`
  entry and the demo's zone, and the demo-story script sends m1 to m4 alone
  and asks "What is confirmed?", as "Try the demo" and its chip do. So the
  eval's requests match the app's.
- F10. `pnpm demo:recordings` writes the demo story's test doubles from a
  stand-in model (`test/script-model.ts`), marked hand-written with a note
  that the app never reads them.
- Limit: pasted messages without a year are read in the year of the day
  they are pasted, so the recorded extraction doubles (dated 2026) fail
  once that day reads the demo dates in 2027. A run on 2026-12-21 passed,
  and one on 2027-02-02 failed. Tests use fixed days.

## SP12.4: reply template no-fit on short notes

- F11. The template call's instructions now say that a short note naming a
  weekday, a date or a time, such as "MON", "See you Thursday" or
  "Confirmed, 10:30", chooses that slot: `accept_offer` for an offered
  slot, `keep_original` for the confirmed slot with a proposed change, and
  no fit only when no listed slot matches or the slot is in neither state.
  Code's own date check (C1) already accepted these picks.
- F12. The D3 fixtures add "Confirmed, 10:30" and "See you Thursday" after
  m1 (S1.1, S1.2) and "See you Thursday" after m3 (S12.2). Their recorded
  picks are hand-written so the tests run code's checks. The live rate is
  the coordinator's `--d3-only` run.

## SP12.5: out-of-scope and meaning-flip probes

- F13. Three chat scripts, synthetic only: `clinical-evasions` (Spanish,
  French, letters written apart, dotted letters, role play, for a friend,
  a pasted office message with clinical text, and a role play and a
  two-turn question with no clinical word), `meaning-flips` (an office
  message that says Monday is not confirmed, times written before their
  dates, m4's reschedule) and `contradiction` (the Thursday reminder after
  the person reported Thursday canceled).
- F14. A chat step may state `slots` (each slot's state after the turn) and
  `slots_none` (slots that must not exist). The report counts slot checks.
  Every answer the person saw is checked for clinical content, and the eval
  exits 1 when one has it, beside the existing hard checks.
- F15. The scope check reads common clinical words in Spanish, French,
  German, Italian and Portuguese (without accents), symptom words that had
  no entry (headache and other aches, fever, nausea, migraine, dizzy,
  blood pressure), runs of three or more letters written apart by a space,
  dot, hyphen, underscore, star or middle dot, and those marks inside a
  word. It errs toward declining, as before.
- F16. Found by the meaning-flips probe and fixed: the carried-over sprint
  1 item. In "At 9:15 AM on Friday 11/13" the weekday and the date split
  into two mentions after the time, and in "... or at 1:00 PM on Monday
  11/16" the second time joined Friday. Both offers failed
  `time_not_in_quote` and the message went to manual entry. A weekday and
  a date written next to each other now stay one mention after a time, and
  a time followed by "on" or "for" and a date starts that date's mention. A
  comma alone moves nothing, and a wrong time or day still fails.
- The role play and the two-turn question reach the model by design. The
  check catches listed words only, so a manual review of the live answers
  remains part of SP12.5.

## SP12.6: fixture suite and demo check

- F17. `pnpm eval:live --all` runs extraction of every message in S1 to
  S19, the D2 and D3 calls and every chat script, one after another under
  the one `--max-usd` limit, in one report. S13 to S19 make no model call
  of their own beyond extraction. Their checks are in `pnpm test`.
- F18. `pnpm demo:check` starts `server/main.ts` on a free port with a
  temporary database and the key, with no Google client, runs the demo
  story through the HTTP routes as the page does (the demo calendar route,
  `POST /api/chat` read as an event stream, the approve route with every
  field read back), checks each step's tools, actions, cards and error and
  the end state (Monday confirmed, Thursday canceled, the insurance card
  on the checklist, one reply sent), and stops the app by its process id
  after checking that it runs from this package. Live answer wording only
  warns.

## SP12.7: the phone sheet

- F19. The schedule panel is a `div` with the `complementary` role beside
  the chat and the `dialog` role, with `aria-modal`, while it is the open
  sheet on a phone or a tablet. An `aside` may not be a dialog. Lighthouse
  13.4.1 on the production build gave 100 for accessibility, best
  practices, SEO and agentic browsing on mobile and desktop, with the sheet
  open on a phone, and with Settings open from the setup message.

## Other choices

- F20. A turn with clinical text still gets the fixed decline before the
  provider check, since it needs no model.
- F21. `ProviderModelClient.ready()` counts a settings file it cannot read
  as ready, so the call fails with the sentence that names that problem.
- F22. The app gives a pasted message the default id from its text. Only
  the test doubles keep fixture ids. The import sheet still gives the demo
  messages their fixture ids, as before.

## Review round 1 (Muse Wonder, `aebb38a..cd91699`)

Each fix has a test in `test/review-sprint12.test.ts` that failed before
it.

- R1. ChatGPT readiness is read from the stored connection without the
  network: signed in, plan usage granted, and an access token still valid
  or a refresh token to renew it (`ChatGptAuth.unavailable`). A signed-out
  ChatGPT, or one without plan usage, now refuses the chat turn before it
  starts and the model routes with 422, as Meta without a key does.
- R2. The MCP server takes the same `ready()`. `import_message`,
  `gmail_import`, `explain_conflict` and `ask_next_question` (the tools
  that call the model, `MODEL_TOOLS`) are refused with
  `provider_not_ready` and `NO_PROVIDER_TEXT` before they write anything.
  The refusal goes to the MCP access log as `refused`, like every other
  refusal (0009, A15). Nothing else is written.
- R3. The chat turn reads the tools it offers before it saves the person's
  message. A Google status that cannot be read, such as an unreadable
  secrets database, means no Google tools in this turn.
- R4. The scope check also reads a clinical word written in chunks of two
  or more letters ("symp toms", "medi cation", "can cer"). Two or three
  neighbouring chunks, apart only by a space or the marks of F15, are
  joined and read against a list of whole clinical words, not stems, so
  "the rapper", "can certainly" and "Joe's can" pass. The diet check reads
  the despaced text too, so "f a s t i n g" is declined.
- R5. "resultados", "résultats" and "Ergebnisse" alone pass. They are
  declined only with clinical context, as in English: "mis resultados",
  "resultados de laboratorio", "mes résultats", "résultats d'analyse",
  "Laborergebnisse", "meine Ergebnisse".
- R6. A reply pick is refused with `ambiguous_slot` when every date or
  time in the note that fits the picked slot also fits another listed
  slot, such as "Confirmed, 10:30" with two offers at 10:30. After the
  retry the person picks by hand. A note that gives two times for one day
  is ambiguous too, since code does not read "not".
- R7. `pnpm demo:check` records the app's command line, start time
  (`/proc/<pid>/stat` field 22) and working directory as soon as it runs,
  and stops it only through its child process handle while all three
  still match. When any cannot be confirmed it sends no signal, keeps the
  temporary database and fails the check.

## Questions for Jeff

- Answered by the coordinator: the scripted chat behind `?mockchat=1`
  stays a development tool. The production build leaves it out.
