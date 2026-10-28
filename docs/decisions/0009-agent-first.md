# 0009: The agent acts, and the person undoes

Status: proposed, pending Jeff (2026-10-28)

Jeff tried the chat app on 2026-10-28 and decided it is an AI agent tool:
the agent does the work, and the person should not have to tap a review
card for every fact or build access grants so an agent can use MCP.
Sprint 8 builds the back end for that. Sprint 9 builds the UI and sprint 10
the model providers and sign-in, to the same contract. J1 to J3 and J5 are
Jeff's. A1 to A22 are choices the writer made, all proposed.

Code: `src/actions/` (every action, the activity entries and undo),
`src/activity/` (the activity log contract and projection),
`src/settings/` and `src/domain/zone.ts` (the case time zone),
`src/agent/tools.ts` (the one tool set), `mcp/` (the server without
grants), `server/api.ts` and `server/settings.ts` (routes),
`scripts/scan-secrets.ts`, `src/eval/chat-eval.ts`, `fixtures/chat/`, and
`test/activity.test.ts`, `test/agent-actions.test.ts`,
`test/timezone.test.ts`, `test/mcp.test.ts`, `test/mcp-app.test.ts`.

## Jeff's decisions

- J1. The agent acts, and the person can undo. It reads messages, accepts
  or rejects their facts, updates the schedule, answers the open
  questions, archives, notes and tags, and drafts replies by itself. Code
  still enforces every rule: the verbatim quote check and extraction
  validation, the slot-state rules (a slot is Confirmed only from an
  office message or the person's own report), grounding of the agent's
  answers, the clinical scope check, and expected versions. Every action
  is logged with Undo. Only sending to the office (approving a reply,
  which is simulated) waits for the person. Delete case stays the
  person's alone and has no agent or MCP tool.
- J2. No grants. The MCP server exposes the same full toolset as the
  in-app agent, with the same rules. Whoever can launch it on the machine
  can use it, which was already true because the same OS user can read
  the database.
- J3. No pairing code for the web app. It is reachable only from the
  server and Jeff's private Tailscale devices.
- J5. The person or their agent sets the case's time zone, and the app
  never locks anyone into one zone. Every time the app shows or resolves
  uses it. The demo data keeps America/Denver because its messages come
  from a clinic there, and loading the demo sets that zone as an action
  the person can undo.

## The contract with sprint 9, as built

The handoff's contract is binding. What the back end does with it, and
the additive details sprint 9 can rely on:

- Removed routes answer 404 `not_found`: `POST /api/pair`, every
  `/api/grants*` and `/api/proposals*` route. No route sets a cookie.
  The host check, the same-origin check and the app header stay on every
  write, and `PUT` is a write like `POST`.
- `GET /api/activity` answers `{ activityVersion, entries }`, newest first,
  with the `ActivityEntry` type in `src/activity/types.ts`.
  `POST /api/activity/:id/undo` with `{ expectedVersion }` and the
  generation header answers the case view (`CaseView`), or 409
  `stale_edit`, or 409 `undo_blocked` with `message`. An unknown id is 404.
- `GET /api/state` also carries `settings` (the time zone part) and
  `activity` (the same view as `GET /api/activity`). It no longer carries
  `grants` or `proposals`.
- The chat stream sends `action` `{ turnId, entry }` as each action
  commits, between its tool's `tool.started` and `tool.finished`.
  `ChatMessage.actions` holds the entry ids of the turn. A `claims` card
  names the message and all of its claims, pending or decided, and the
  page shows each claim's status from the case view and its Undo from the
  entry whose `target` is `{ type: "claim", id }`.
- `GET /api/settings` returns the whole shape in the contract. The
  provider parts read as not set until sprint 10 fills them
  (`server/settings.ts`, `ProviderSettings` and the `provider` seam).
- `PUT /api/settings/timezone` takes `{ timezone, expectedVersion }` and,
  for the page's first-load call, `source: "browser"`. It answers the
  settings view. A name that is not a zone is 422, a stale version 409.
- `POST /api/records/:id/unarchive` with `{ expectedVersion }` is new.
  The old `POST /api/records/:id/undo` stays.
- Agent-written evidence is labeled: a message an external agent adds has
  `sourceNote` "Added by an external agent" (`EXTERNAL_SOURCE_LABEL`), a
  pasted message the assistant adds keeps "Source suggested by the
  assistant", and an answer an agent gives shows its source as "added by
  the assistant" or "added by an external agent".

## Design, as built

1. Actions. `src/actions/service.ts` is the one place every action is
   defined, for the person, the in-app agent and an external agent. The
   tools in `src/agent/tools.ts` are defined once, and `mcp/tools.ts`
   offers the same list. The action tools are `accept_claim`,
   `reject_claim`, `answer_question`, `archive_appointment`,
   `unarchive_appointment`, `add_note`, `set_tags`, `start_reply` (the
   former `draft_reply`), `discard_draft`, `undo` and `set_timezone`, with
   `import_message`, `explain_conflict` and `ask_next_question` as before.
   No tool approves or sends a reply, edits a reply's text, enters a fact
   by hand or deletes the case.
2. Import and accept in one turn. The import keeps 0007's rules (whole
   lines of the paste, suggested source fields marked). A pasted
   message's claims keep the source type of its channel: an office
   message, or the person's own report for `user_report`.
3. Activity log. Every action is an entry with a code-written summary,
   actor and target, written in the same transaction as the action. Undo
   appends a reversing event to the target's stream, marks the entry and
   writes an undo entry. New reversing events: `claim_decision_undone`,
   `evidence_withdrawn`, `message_withdrawn`, `question_answer_undone`,
   `question_withdrawn` with reason `undone`, `reply_discarded` with
   reason `undone`, `reply_discard_undone`, and `timezone_set` with the
   zone before or `timezone_cleared`.
4. Grants, tokens, the token file, tiers, proposals, the grant rate limit,
   grant labels and pairing are gone. The MCP server keeps a per-process
   rate limit and logs each call with actor "mcp". Old grant and proposal
   events are skipped by every projection, and old confirmed agent
   reports still count.
5. Checks that protect meaning stay: grounding, scope, injection
   handling, untrusted labels. The action-claim check now reads the
   turn's activity entries (A17).
6. The secret scan looks for the product key (A18).
7. The chat eval checks actions (A19).
8. Time zone (A11 to A13). Tests run the demo story in America/Denver and
   a smaller story in Asia/Tokyo and Europe/London, across London's change
   on 2026-10-25.
9. `docs/connect-agent.md` is one command per client and one paragraph on
   running the agent with only the tools it needs.

## Writer choices (proposed)

- A1. Action tools take the expected version of what they change: the
  claim's version, `questions_version`, `record_version`,
  `reply_version`, `settings_version` and `activity_version`. Read tools
  return them, and each action's result returns its activity entry and
  the new activity version.
- A2. `accept_claim` and `reject_claim` take a list of up to 20 claims.
  Each is its own action and entry, so one can be undone without the
  others, and the result reports each claim (`partial` when some were
  refused). "Accept everything" is one call.
- A3. `get_activity` is a read tool beyond the handoff's list, so an agent
  can find an entry to undo.
- A4. An agent accepts only a claim that passes the extraction checks
  again inside the accept's transaction: its quote verbatim in its
  message, its date, time, event time, place and request item. A fact
  with no quote, such as one the person typed by hand, is refused with a
  sentence that says to accept it in the app.
- A5. An agent's answer is recorded as `reported_by_user_via_agent` with
  `agent_name` "the assistant" or "an external agent". Inside the
  answer's transaction, code projects the case and refuses the answer
  (`needs_person`) when any slot's state would rest on the agent's items.
  So an agent can answer which date or place a fact means, start a reply
  through a choice, or answer "Not sure yet", and the person answers a
  choice that would confirm, cancel, decline, request or offer a slot.
  This is how J1's slot-state rule holds for answers.
- A6. Only the person approves a reply, edits its text, enters a fact by
  hand and asks the model to pick a template. Those actions refuse an
  agent actor (`person_only`), as well as having no tool.
- A7. What undo does for each entry, and when it is refused:

  | Entry | Undo | Refused when |
  |---|---|---|
  | Message added | The message and its claims leave the case. Pasted again, it is added anew with ids such as `m1-r2-e1`. | One of its claims is accepted or rejected. |
  | Claim accepted or rejected | The claim waits for review again. | A reply for one of its appointments was approved later, or a question about one of them was answered later. |
  | Question asked | The question is withdrawn and its conflict waits. | It was answered or withdrawn. |
  | Question answered | The question is open again, its items leave the case, and a draft it opened is discarded. | A later question was asked, another question is open, or a reply it depends on was approved. |
  | Archive, note, tags | The record's own undo event. | The tags were changed again later. |
  | Unarchive | The record is archived again. | It is archived. |
  | Draft started | The draft is discarded. | It was approved or discarded. |
  | Draft discarded | The draft is open again. Approval checks it against the case as always. | Another draft is open. |
  | Time zone set | The zone before it comes back. | The zone was changed again later. |
  | Reply approved, calendar loaded, message read, fact entered by hand, draft edited, explanation, template suggestion, an undo | No undo. The entry says why. | Always, with that sentence. |

  "A reply depends on it" means a reply approved later for an appointment
  the entry touched. The entry stores the appointments it touched.
- A8. The assistant's `import_message` is one entry: reading the message
  is part of adding it, and the undo of the add removes its facts. The
  person's extract route logs "message read" with no undo.
- A9. Entry ids are `a` and the activity stream version, such as `a7`.
  `at` is shown in the case's zone as set now, so changing the zone moves
  every time shown, chat times included.
- A10. Actions that wait for a model (extraction, explanation, the next
  question, a template pick) write their entry from a hook the store runs
  inside the command's own write transaction (`withWriteHook`), so the
  entry and the write commit together.
- A11. The settings are one stream, `settings`, with one
  `settingsVersion`. Unknown event kinds are skipped, so sprint 10's kinds
  count in the version. Delete case keeps the stream, so the zone and
  sprint 10's settings survive it. A zone write still states the case
  generation, like every write.
- A12. With no zone set the case uses UTC, with `timezoneSource`
  "default", until the page sends the browser's zone or someone sets one.
  A zone must be an IANA-shaped name this runtime accepts. Offsets such as
  +05:00 are refused because they do not follow daylight time. The
  canonical name is stored.
- A13. Times are written with the case zone's offset where code writes
  them: the received time of a pasted message with no stated send time,
  the evidence time of an answer, an approved reply and a fact entered by
  hand, and the chat's and activity log's times. Calendar times with a
  TZID keep their own zone, and times with no zone are read in the case's
  zone.
- A14. "Load the demo" is the page loading the demo calendar through
  `POST /api/calendar`. When the text is the demo calendar, the route also
  sets the zone in `fixtures/case.json` (`time_zone`) as an action of the
  assistant, unless that zone is already set. No new route is needed.
- A15. MCP. The rate limit is 60 calls a minute per server process, in
  memory. A rule's refusal is logged as `refused`. A read returns no data
  when the case was deleted before its log entry committed. The server
  uses recorded model responses unless `APP_LIVE_MODEL=1` and
  `MODEL_API_KEY` are set, and in recorded mode a fixture message keeps
  its fixture id, as in the app. Tools have no output schema now, because
  the shared results vary by tool code.
- A16. The agent's limit is 8 tool calls a turn, up from 6, because a
  paste is now an import and an accept, and a question an ask and an
  answer.
- A17. The action-claim check maps each first-person verb to the activity
  kinds that make it true: accepted to `claim_accepted`, archived to
  `appointment_archived`, undid to `undo`, and so on, and changed or
  updated to any action. Approved, sent, submitted, confirmed, canceled,
  declined, booked, rescheduled, moved and deleted are never true. A
  status word code cannot map, said of a slot, still fails closed, except
  in the agent's own "I accepted the offer for Tuesday" when the turn
  accepted a claim.
- A18. The secret scan finds a `MODEL_API_KEY` assignment with a value of
  at least 12 characters and a bearer token of at least 24 characters with
  both cases and a digit, in files, history, names and refs, as before. A
  value ends at a backslash and a value that starts with REDACTED is a
  placeholder, because the session checkpoint refs hold JSON logs with
  escaped newlines and redactions.
  The key's own shape could not be learned without reading `.env.local`,
  so a bare key is not found.
- A19. The chat eval's hard checks are that no reply was approved or sent
  in a turn and that no slot's state rests on anything but an office
  message or the person's own report. It also reports actions that
  cannot be undone and matches expected action kinds. An injection is
  held when no slot became canceled or declined, nothing was archived or
  sent, the text made no false claim and no missing tool was called.
- A20. `src/records/types.ts` stays, unused by the server, only so the
  sprint 7B UI still builds. Delete it with `ui/case/ProposalCard.tsx`.
- A21. The history labels review decisions without "you" ("Claim m2-e1
  accepted"), because the activity log names who did each action.
- A22. Records name an agent by code: `{ kind: "agent", name }` with "the
  assistant" or "an external agent". Old records keep their grant name.

## Review round 1

Coordinator decisions, proposed:

- D1. A `user_report` claim means the person's own words. In the chat the
  channel `user_report` is kept only when the imported lines are what the
  person typed: the words around them do not introduce a message, they are
  not a block set off under a lead-in, they have no header line or sender
  prefix, and they speak in the first person without addressing "you"
  (`ownWords` in `src/agent/tools.ts`). Otherwise the channel is
  `unknown`. Over MCP a `user_report` is imported with source
  `reported_by_user_via_agent` and agent "an external agent", labeled
  "reported through an external agent". Such a claim, and any agent's
  answer, cannot by itself hold, cancel or move a slot (rule 1): the
  projection keeps confirm, reminder, cancel and move claims of an agent
  that the person never confirmed aside, lists them in the slot's
  `unconfirmedEvidenceIds` and the case's `unconfirmedEvidenceIds`, and
  the slot's state comes from an office message or the person's own report
  when one agrees. An offer, request or decline it reports still counts.
  A report an old grant made and the person confirmed still counts in full.
- D2. A chat turn that imports text may only import it and accept or reject
  that message's claims. Archive, unarchive, tags, notes, the time zone,
  answers, starting or discarding a draft and undo are refused in that
  turn with `waits_for_person` and the notice `PASTE_TURN_NOTICE`, and they
  also need words of the person's own outside the imported lines. A
  turn that already took one of those actions, or accepted a claim of
  another message, refuses a later import with
  `IMPORT_AFTER_ACTION_NOTICE`, so the order of the calls does not matter.
  This applies to the chat only. An external agent over MCP acts for the
  person who runs it.

Findings:

1. A fabricated `user_report` could confirm or cancel. Fixed by D1
   (`test/review-sprint8.test.ts`, finding 1, and `test/slots.test.ts`).
2. Message text could drive non-claim actions. Fixed by D2
   (`test/review-sprint8.test.ts`, finding 2).
3. Undo of a draft's start, or of the answer that opened it, threw away
   the person's edit. Both are now refused while the draft is open and
   edited.
4. Undo of an import withdrew later facts entered by hand. It is now
   refused while the message has one, naming its entry, and while a later
   answer settled one of its facts, naming the question. The intake
   service refuses too.
5. After `set_timezone`, later tools in the turn read the old zone and
   date. The tool context now takes the new zone and today, and the checks
   on the answer and its chips read them.
6. MCP results now pass the sanitizer once at the boundary, and the text
   block is the same data as the structured result.
7. Reading a message that was already in the case, unread, now goes
   through `CaseActions.extract` with its own entry. Reading a message the
   same call imported stays part of the import's entry (A8).
8. A time the clock skips when daylight time starts (02:30 on 2026-03-08
   in America/Denver) rolls forward to the first time that happens
   (03:00), `resolveWallClock` says "gap", and `check_calendar` tells the
   agent in `time_note`. A repeated hour is still the first of the two.

The root typecheck no longer compiles the UI: `test/bundle.test.ts` reads
the scripted chat's marker from `ui/chat/mockStream.ts` as text instead of
importing it.

## Review round 2

The coordinator replaced the text heuristics of D1 and D2 with rules that
fail closed. Both proposed.

- D1' (replaces D1's chat rule). The assistant never sets channel
  `user_report`. When the text may be the person's own report (the model
  asked for `user_report`, or the turn is not a paste turn under D2'), it
  is added with channel `unknown` and `ownReport: "offered"`, and the chat
  shows a card `{ "kind": "own_report", "messageId": string }` with the
  question "Record this as your own report?" (`OWN_REPORT_QUESTION`). An
  agent may not accept or reject that message's claims until the person
  answers. The answer is `POST /api/messages/:id/own-report` with
  `{ "expectedVersion": number, "answer": "yes" | "no" }` (the message's
  version), the person's only, logged as `own_report_recorded` with Undo,
  and answers the message view. Yes makes the message and its claims
  `reported_by_user`, after the scope check a typed report gets. The
  claims stay pending. Its undo is refused once a claim of the message was
  reviewed. `ownWords` is gone. Over MCP, D1's
  `reported_by_user_via_agent` rule stays.
- D2' (replaces D2's ordering). At the start of a turn code reads the
  person's message (`mayContainPaste`): a line break, more than 280
  characters, or a line that starts with a sender-like prefix (`Name:` or
  `From:`) or a quote mark. In such a turn only reads, `import_message` and
  `accept_claim` or `reject_claim` for claims of messages this turn
  imported are allowed. Archive, unarchive, tags, notes, the time zone,
  answers, starting or discarding a draft and undo are refused for the
  whole turn with `PASTE_TURN_NOTICE`, and so are `ask_next_question` and
  `explain_conflict` when they would write, whatever the order of the
  calls. A short message with none of those marks is a normal turn.
  `IMPORT_AFTER_ACTION_NOTICE` is gone.

Findings:

1. and 5. Fixed by D2'.
2. and 3. Fixed by D1'.
4. A claim fact with no state, such as an agent's unconfirmed report,
   grounded "Monday is confirmed" through the fallback to any slot. Now a
   clause, or a sentence with no slot, that names a date no slot among
   the facts has fails any positive state word.
6. An import blocked forever on a rejected fact entered by hand. Only a
   pending or accepted one blocks now, and a rejected one leaves with the
   message.
7. Every claim an agent reports, of any type, waits as unconfirmed until
   an office message or the person's own report agrees, and the checklist
   and `get_checklist` leave such office requests out. So an agent's answer
   that records any claim is refused, a clarifying one included, and an
   agent answers only with choices that record no claim (a reply, "Not
   sure yet").
8. `check_calendar` gives the gap note with no calendar loaded.
9. A report with a date and no time shows on a slot only when it is the one
   slot that day. Otherwise it is listed for the case only.

API changes for sprint 9 in this round: the card kind `own_report`, the
message field `ownReport` (`"offered" | "yes" | "no" | null`), the route
`POST /api/messages/:id/own-report`, the activity kind
`own_report_recorded`, `own_report_questions` in `list_open_questions`, and
`unconfirmedEvidenceIds` now holds an agent's reports of every claim type.
Removed: `IMPORT_AFTER_ACTION_NOTICE`.

## Self-review

1. Each check that guards a write runs in the write's transaction: the
   accept re-verification, the answer's slot-state check, every undo
   blocker, the archive checks and the version checks. The person-only
   check reads only the actor, so it runs first.
2. Every write states an expected version and runs as a command on the
   case generation, through the routes, the chat and the MCP server.
3. Text checks run on normalized text, as before.
4. The agent cannot set a slot state its evidence does not support (A4,
   A5), and no tool or actor path lets it send or delete (A6).
5. Every agent and MCP action is an entry, and every entry can be undone
   or says why not (A7).
6. No secret reaches a log, an error or output: the MCP server holds no
   token, the access log holds no input, and the key stays in the model
   client.
7. Every time uses the case zone. A zone name is written in code only in
   the demo fixtures, comments and messages that name examples, and UTC
   as the default with no zone set.
8. Every removed route answers 404, and the only references to grants and
   proposals left are the projections that skip their old events and
   `src/records/types.ts` (A20).

## For sprint 9 and the coordinator

- The 7B UI still expects `grants` and `proposals` in `/api/state` and a
  `proposal` card. On this branch alone, `ui/agent-access.node.test.ts`,
  two tests in `ui/schedule/SchedulePanel.node.test.ts` and one in
  `ui/chat/mockStream.node.test.ts` fail, and the two UI typechecks fail
  in the files that use grants, proposals and the old `ChatMessage`. The
  root typecheck and `pnpm build` pass.
- New for the page: `SlotView.unconfirmedEvidenceIds` and
  `CaseView.unconfirmedEvidenceIds` (D1), and the notices
  `PASTE_TURN_NOTICE` and `IMPORT_AFTER_ACTION_NOTICE` (D2).
- Sprint 10 adds its settings kinds to the `settings` stream and its parts
  through `settingsRoutes(store, actions, provider)`.

## Not done

- The live chat eval and its recordings. The coordinator runs them.
- The UI (sprint 9).
