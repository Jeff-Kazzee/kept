# 0018: The opening Gmail step, from the third live run

Status: the items H1 to H8 come from the sprint 13E handoff (2026-10-29).
Choices marked (proposed) are the writer's and wait for Jeff.

Live run 3 on the demo at `3d0511a` passed every step sprints 13C and 13D
fixed. The opening step failed. "Check my Gmail for messages from Lantern
Hill Clinic and update my schedule." imported only the first of two
matching emails and said "One more Gmail message still waits for review."
Nothing on the page let the person act on it. The answer called the office
"lantern hill" and quoted each email's first words. This records what was
found and changed.

Code: `src/google/tools.ts`, `src/agent/agent.ts`, `src/agent/tools.ts`,
`src/agent/types.ts`, `src/eval/chat-eval.ts`, `server/api.ts`,
`server/request-log.ts`, `ui/chat/ChatView.tsx`, `ui/chat/state.ts`,
`ui/agent/Receipts.tsx`, `ui/agent/AgentContext.tsx`,
`ui/schedule/CaseTabs.tsx`, `ui/api.ts`, `ui/format.ts`, `ui/styles.css`.
Fix round 1 adds `src/google/offers.ts`, `src/google/connection.ts`,
`src/case/history.ts`, `server/google.ts`, `server/workspace.ts` and
`ui/shell/shell.ts`. Tests: `test/sprint13e-gmail.test.ts`,
`ui/chat/sprint13e.dom.test.ts`, and changes to `test/google.test.ts`,
`test/google-agent.test.ts`, `test/review-sprint12.test.ts` and
`test/review-sprint12-round2.test.ts`.

## H1. One ask imports every matching email

Found: `gmail_import` took one `message_id`, and the instructions said
nothing about importing every match. The model imported one email and
stopped.

Changed:

- `gmail_import` takes `message_ids`, 1 to 10 in one call. (proposed: 10,
  the most a Gmail search returns.) Each id is imported on its own, in the
  order given, once: its own activity entry, its own Undo, its own claims
  card and its own result in `results`. One that fails, such as an email
  with no text, does not stop the others. The call's code is "ok" when all
  were imported, "partial" when some were, and the first error when none
  were. Over MCP the tool takes the same shape.
- The instructions say: "When the person asks you to check Gmail and
  update their schedule, call gmail_import once with every message
  gmail_search found that matches their request and is not
  already_imported, unless they named one email."
- The turn's limits stay as they are: 12 tool calls, the token cap, and the
  Google Calendar read budget. Importing several emails is one tool call.

Tests: `test/sprint13e-gmail.test.ts`, "sprint 13E, H1".

## H2. Code offers the emails a turn leaves out

Found: when the turn ended with a found email not imported, only the
model's words said so.

Changed:

- Each `gmail_search` of a turn records what it found. When the turn ends,
  code adds a `gmail_waiting` card for each found email that was new when
  found, is still not in the case and matches. The model does not write
  these cards and cannot leave them out. A stopped turn adds them too. A
  turn the scope check declined does not.
- An email matches when its search named sender addresses, when it is from
  the sender of an email the turn imported, or when the turn imported no
  email. (proposed) So a search for one office that imported its first
  email offers its second, and leaves out another office's mail. An email
  `gmail_import` refused for what it holds (no text, too long, clinical,
  refused by the intake checks) is not offered again.
- The card holds Gmail's id, the case's id the message will have, the time
  it arrived, the office's name as the page showed it when the turn ended
  (or none for "the office"), and a message in the case from the same
  sender. It holds no address and no text from the email.
- The page shows the waiting emails of one answer together, written by
  code: "1 more email from Lantern Hill Clinic, Oct 28, 6:43 PM, isn't in
  your case yet." with "Add it", or "2 more emails from Lantern Hill Clinic
  aren't in your case yet." with a line and an "Add it" for each. The
  sender is named as the page names the message from the same sender, else
  by the name on the card, else "the office".
- "Add it" is the person's action: `POST /api/gmail/<id>/add` with an
  empty body and the case generation. It reads the email from Gmail and
  adds it through the same function as `gmail_import`, with the activity
  entry "Added from Gmail: the email from Lantern Hill Clinic, Oct 28, 6:43
  PM." and its Undo. It makes no model call. The page then reads the email
  through the existing extract route, as it does for a paste, and the card
  becomes the email's facts card in the same place. An email already in
  the case is answered as it is, with no second entry. The request log
  writes the path as `/api/gmail/*/add`.
- The next turn's history names each waiting email by its id, so "import
  the other one" works without another search.

Tests: `test/sprint13e-gmail.test.ts`, "sprint 13E, H2", and
`ui/chat/sprint13e.dom.test.ts`, "sprint 13E, H2".

## H3. The office's name and when an email arrived

Found: the tools gave the model only the raw sender line ("lantern hill
<address>"), and an email's sent time was not a fact the answer could
name, so the model named emails by their first words.

Changed:

- `gmail_search` results, the `gmail_import` source and the
  `import_message` source carry `office`: the office's name as the page
  shows it (`officeNameShown`, 0017 E6), labeled `untrusted_text` like
  other text from a message, or null while the page holds the name back
  and says "the office". `accept_claim` and `reject_claim` add `offices`
  for the messages they decided, so after the first place is accepted the
  model gets "Lantern Hill Clinic". An email not in the case is read as one
  more unread email from its sender.
- An email's sent or received time, in the case's zone, is a fact of the
  turn, and the import gives `received_label` beside the search's
  `sent_label`. So "the email from Lantern Hill Clinic sent Wednesday 10/28
  6:43 PM" passes the date check. Such a fact carries no slot state, so it
  never supports a state word.
- The instructions say: "Name a sender only by the office field the tools
  give, or as the office when it is null. Refer to an email by its sender
  and its sent_label or received_label, never by quoting its words." The
  sentence "name it by its sender or its first words" is gone.
- No check rewrites model text for names. The answer checks (G4,
  `src/agent/grounding.ts`) cover dates, weekdays and times against the
  turn's facts, state words against the slots, statuses such as accepted
  or sent, first-person claims of actions against the activity log, and
  clinical content. None of them reads names. The page's own sentences
  (receipts, cards, Activity) already name the office by code.

Tests: `test/sprint13e-gmail.test.ts`, "sprint 13E, H3", and the changed
M3 test in `test/review-sprint12-round2.test.ts`.

## H4. Every time the new facts mention

Found: the answer after the second import named only Thursday, though the
email also offered Friday and Monday.

Changed: an instruction, no code. "After you import messages, name every
date and time their claims state, or say that the facts card lists them,
and say which appointments the claims you accepted changed." The claims'
dates are already facts of the turn, so naming them passes the checks.

## H5. An Added line for an event since removed in Google Calendar

Found: after the person removed the app's event in Google, the chat's
"Added ... to Google Calendar" line still offered Undo.

Changed:

- `removedInGoogle` (`ui/agent/AgentContext.tsx`) is true for an entry
  that added or updated the event when it is the slot's latest calendar
  action in effect and the same read that drives "Removed in Google
  Calendar" (`googleEventState`) no longer finds the event. The chat line
  then reads "Added Monday 11/16 1:00 PM to Google Calendar as confirmed. ·
  Since removed in Google Calendar" and shows no Undo. The Activity row
  says "Since removed in Google Calendar" and shows no Undo either. A later
  write for the slot, such as putting it back, is the one in effect.
- The server's Undo of that entry was already harmless and stays as it
  is: it finds the event cancelled, writes nothing at Google, marks the
  entry undone and says "The Google Calendar event for Monday 11/16 1:00 PM
  was already gone." An agent's `undo` call gets the same.

Tests: `ui/chat/sprint13e.dom.test.ts`, "sprint 13E, H5", and
`test/sprint13e-gmail.test.ts`, "H5".

## H6. A deliberate refusal is not a failed step

Found: the refusal to add back a removed event showed as "Worked through
2 steps, 1 did not finish".

Changed:

- A tool result can say it `declined`: the tool chose not to act by a
  rule. The sync's refusal for a removed event sets it, and so does the
  paste rule's refusal of a write (0009, D2', fix round 1, R5). (proposed:
  the paste-turn refusal counts too.) The result stays not ok for the model
  and the eval, with the same code.
- `tool.finished` carries `declined: true`. The step reads "Updating your
  online calendar. It chose not to act." with an info mark, and the
  summary "Worked through 2 steps, 1 chose not to act". A real failure
  still reads "did not finish".
- The declined sync now carries the appointment's slot and fact, as a sync
  does, so an answer that names the appointment it left out passes the
  date check. Found in the browser check: a scripted answer that named
  Monday after only the refused sync was replaced.

Tests: `test/sprint13e-gmail.test.ts`, "H6", and
`ui/chat/sprint13e.dom.test.ts`, "sprint 13E, H6".

## H7. The success line shows once

Found: a calendar write showed its sentence twice, as the receipt with
Undo and as a "Written by code" notice.

Changed: a notice card whose `activityId` is one of the answer's own
actions is not shown, because the receipt above already states it with its
Undo and its undone state. A notice for anything else still shows. The
stored chat keeps both, so nothing changes for MCP or the eval.

Tests: `ui/chat/sprint13e.dom.test.ts`, "sprint 13E, H7".

## H8. Google Calendar shows no tentative marker

Noted, no change. The app writes `status: "tentative"` for a requested
appointment, and the API stores it, but Google Calendar's web page shows
no marker for it. The event's title says "(requested)" until the office
confirms. Run 3 saw the same.

## Fix round 1 (review of 2026-10-29)

- R1. "Add it" imports only an email code offered. When a turn adds
  `gmail_waiting` cards it records each offer on the case's
  `gmail_offers` stream with the Gmail account it was found in (the
  account's Google id, never an address) and the case generation.
  `POST /api/gmail/<id>/add` refuses with 409 `gmail_not_offered` an id not
  offered for the account connected now and the current generation, and
  writes nothing. Delete case erases the stream with the case. A
  disconnect, or a connect that names another account, drops every offer,
  and the account check now counts the Gmail account too, for a connection
  without the calendar. The turn reads the account only after it searched
  Gmail. The stream is left out of the case history.
- R2. An email's import and read are one outcome. `gmail_import` reports
  each email as refused (nothing added), added and read, or added and not
  read: a read that fails after the add leaves the email in the case,
  unread, and its result says `status: "imported"`, `not_read` with the
  reason's code, and a note that its card can read it again or take its
  facts by hand. It is counted as `imported_not_read`, not as refused, and
  is not marked refused for the offers. Any other error of one email is
  that email's `server_error` result and the others still run. Errors that
  end every turn still end it: Delete case, a busy store, the turn's token
  limit and the hosted usage stop. "Add it" no longer hides a failed read:
  the person is told "Added the email from Lantern Hill Clinic, Oct 28,
  6:43 PM, but it was not read." with the reason and "Its card has Read
  this message.", and a missing model still links to Connections.
- R3. The Gmail tools no longer give the sender line. Each email has
  `office` (the page's name, or null for "the office") and
  `sender_domain`, the domain of the sender's address, so the model cannot
  copy the account's display name before the page names the office. The
  email's subject and body are still given as message text, labeled
  untrusted. The H3 test now answers "the office" while `office` is null.
- R4. One offer per email. A turn does not offer an email an earlier answer
  still offers for the same account and case. The page shows only the
  newest card for each email, so one email never has two "Add it"
  buttons, and after Undo of its import only that card offers it again.
- R5. Only the tool says it chose not to act: `declined` is set by the
  paste rule's refusal (`pasteRefusal`) and the refusal to add back a
  removed event. The agent no longer reads it from the `waits_for_person`
  code, so `gmail_import`'s refusal to read an unread email in a paste
  turn counts as a step that did not finish. This replaces the H6 bullet
  that counted every `waits_for_person` refusal.

The recordings did not change: the demo story runs without Google, so
the Gmail tools' texts are not in its requests, and `pnpm demo:recordings`
wrote the same files.

## Fix round 2 (review of 2026-10-29)

- F1. "Add it" checks again after Gmail answers. The route reads the Gmail
  account at its start, and right before the import, with no wait between
  the check and the import, it checks that the same account is still
  connected and the offer can still be used. A disconnect or another
  account in between refuses with `gmail_not_offered` and writes nothing.
- F2. `import_message` (a paste) gives the same sender shape as the Gmail
  tools: `office` and `sender_domain`, never the sender line or its
  address. For a paste the page names the office by the name the paste
  gave, so `office` is that name.
- F3. The offers hold a hash of the Google account's id, never the id.
  "Add it" uses its offer. Only an Undo of that import makes the email
  addable again, which the card that offers it again needs. A second Add
  while the email is in the case is refused.
- F4. The Gmail offers are dropped only when the Google account itself
  changes, read from the stored connection, so a reconnect after it
  expired keeps them. A change of calendar keeps them too. The calendar
  comparison stays as it was for the calendar intents. A disconnect drops
  both.
- F5. The H3 test reads the whole search output, body included. An
  email's subject and body are message text, labeled `untrusted_text`,
  and they can name the office, as when the email signs "Front Desk,
  Lantern Hill Clinic". That is expected. Only the fields code writes are
  held to the page's name.
- F6. The page shows the server's sentence for `gmail_not_offered`, not
  the general one for a changed item.

The paste import's output is part of the demo's requests, so the
placeholder recordings were rewritten with `pnpm demo:recordings`, in one
commit.

## Recordings

The tool definitions and the instructions are part of every chat
recording's key, so every keyed recording changed. The 21 keyed chat
recordings in `fixtures/recordings/chat/` were all placeholders the
stand-in model writes (`source: "hand-written"`), not live answers. They
were rewritten with the project's own command, offline and with no key:

    pnpm demo:recordings

8 of 8 demo turns matched their tools, actions and cards, and no answer
was replaced. The fault recordings under `faults/` are not keyed and did
not change. (proposed: no live rerecord, because no test reads a live
answer.) The live check that matters is the coordinator's run of the
Gmail step on the demo.

## Browser check

On port 5199, with the production build, the app's own workspace, the
offline fake of Google's endpoints and a scripted model, at 1280 and 390
px: one turn imported two emails with two Undo lines and two facts cards
(H1) and offered the third with "Add it" (H2). "Add it" logged the
person's import with Undo, read the email and showed its facts card in
place. A calendar add showed its sentence once (H7). After the event was
removed at the fake Google and the calendar read again, the open page's
Added line said "Since removed in Google Calendar" with no Undo, in the
chat and in Activity (H5), and the next sync read "Worked through 1 step,
1 chose not to act" (H6). No sideways scroll at 390 px.
