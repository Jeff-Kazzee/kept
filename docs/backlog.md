# Implementation backlog

This file plans the build from D2 to submission. Each sprint delivers one
feature, runs on its own branch, and ends with a merge into `dev`. Scenario
IDs (S1 to S19) refer to the fixtures and acceptance tests. Task IDs use the
sprint number, for example `SP2.3`. A task marked (proposed) makes a choice
that Jeff has not confirmed yet.

## Branches

| Branch | Purpose | Who moves it |
|---|---|---|
| `prod` | Last state that passed a milestone review. The public repo is cut from here. | Fast-forward from `dev` at a milestone, with Jeff's approval. Never a direct commit. |
| `dev` | Integration branch. Every sprint branch starts here and merges back here. | The coordinator, after a sprint passes its gates. |
| `sprint/NN-<slug>` | One sprint, one feature. | One writer, in its own worktree. |

Rules:

- Start each sprint branch from the current `dev`.
- One writer per sprint branch. Only sprints 3 and 4 may run at the same time,
  because they touch different files.
- A sprint merges into `dev` only when its gates pass (see below).
- `prod` moves at three milestones: the checkpoint after sprint 2, the end of
  failure testing, and the submission build.
- No push and no remote until Jeff approves publication.

## Gates for every sprint

1. `pnpm test` and `pnpm typecheck` pass with no network and no key.
2. Deterministic tests exist for every scenario the sprint owns.
3. A read-only review of `dev..sprint/NN-<slug>`, at most two rounds. The
   writer fixes each finding or answers it with evidence.
4. A live evaluation where the sprint adds or changes a model call.
5. The coordinator merges into `dev`, removes the worktree, and records
   the results.

## Status

| Sprint | Feature | Deliverable | Target dates | Status |
|---|---|---|---|---|
| 0 | Model access check and fixtures | D0 | Oct 27 | Done (`38ed86d`) |
| 1 | Evidence intake | D1 | Oct 27 | Done (`09042eb`) |
| 2 | Slot states and conflict resolution | D2 | Oct 27 | Done (`46e5917`) |
| 3 | Reviewed reply | D3 | Oct 27 | Done (`af00de3`) |
| 4 | MCP core: domain events, grants, tools | D5, part 1 | Oct 27 | Done (`49f9c45`) |
| 5 | Saved outcome and checklist | D4 | Oct 28 | Done (`d6a0d86`) |
| 6 | MCP in the app and connect test | D5, part 2 | Oct 28 | Done (`2bc8384`), real client run open |
| 7A | Case agent: chat tool loop on Muse Spark | Chat app | Oct 28 to 29 | Next |
| 7B | Web app: chat and schedule UI, production build, mobile | Chat app | Oct 28 to 29 | Next, beside 7A |
| 8 | Failure testing | All | Oct 30 to 31 | Planned |
| 9 | Submission build | All | Nov 1 to 3 | Planned |

Milestone checkpoint: Oct 31, after sprint 2. If sprint 2 is not merged by
then, cut the MCP slice in this order: `propose_change`, then the annotate
tier. Read-only MCP is the floor.

## Carried over from sprint 1

- [x] Choose the extraction effort level (`low` or `minimal`) for the demo.
  Jeff chose `minimal` on 2026-10-27. Sprint 3 made it the default in the
  app and runs it first in `eval:live`.
  Sprint 1 measured `low` at 100% and `minimal` at 98% with one run at 94.1%.
  `minimal` was about twice as fast. This is Jeff's decision. Sprint 2
  measured both at 100% across three runs, with `minimal` at p50 1.6 s
  against 3.2 s for `low`.
- [x] A weekday alone ("Monday") can match two dates inside the 14-day
  window. Sprint 2 raises it as a question instead of choosing.
- [ ] A time written before its date can attach to the previous date and
  reject a real claim. Watch the live rejection rate.

## Carried over from sprint 2

- [ ] Confirm or change the decisions marked "proposed, pending Jeff" in
  `docs/decisions/0002-slot-states.md` (D-a to D-h and W1 to W33).
- [x] Sprint 3 work: the unknown-order change question reads "The change to
  Thursday 11/12 10:30 AM is still proposed". Thursday is the slot being moved
  away from, so the wording should name the change from that slot. Sprint 3
  changed it to "A change away from Thursday 11/12 10:30 AM is still
  proposed".
- [x] Look at the conflict view in a browser. Sprint 2 checked it over HTTP
  only. The coordinator checked it in a browser. Sprint 3 fixed the three
  items found: cited quotes repeated the source cards, long timestamps
  wrapped in the source headers, and the favicon request returned 404.

## Carried over from sprint 3

- [ ] Confirm or change the decisions marked "proposed, pending Jeff" in
  `docs/decisions/0003-reply-templates.md` (R-a to R-h, C1 and T1 to T17). T1
  departs from R-d: the place is optional for the accept template, because
  m3 offers Monday without a place and the demo beat needs the accept
  template for Monday. The coordinator accepted T1.
- [x] Run `pnpm eval:live --d3-only` with the key on the C1 change. The
  coordinator's live run of `af00de3` (3 runs, effort low) gave no meaning
  flips. S9.1 and S9.2 answered no fit in every run. System outcomes were as
  expected in 21 of 24 items.
- [ ] Sprint 7 work: the template call answers no fit too often for short
  notes. In the run above, "MON" (S12.1) got no fit in 2 of 3 runs and S3.4
  once. Each falls back to a manual pick, which is safe but costs the user a
  step. Tune the prompt or try effort minimal, then measure again.
- [ ] Look at the reply panel in a browser. Sprint 3 checked it over HTTP
  and with server-rendered markup only.

## Carried over from sprint 4

- [ ] Confirm or change the decisions marked "proposed, pending Jeff" in
  `docs/decisions/0004-mcp-core.md` (M-a to M-w and the review changes).
- [x] Decide whether notes and proposal statements written by an agent go
  through the clinical-content check. Sprint 5 adds the check (O-e in
  `docs/decisions/0005-saved-outcome.md`), for notes, tags and proposal
  text from any writer.
- [x] Decide whether Delete case (sprint 5) also removes the case's access log
  and rate counters. Grants are app settings, not case data. Sprint 5 erases
  both and keeps grants (O-a in `docs/decisions/0005-saved-outcome.md`).
- [x] Sprint 6 work: a reply can still be drafted for an archived
  appointment. Decide whether archive hides it from the reply panel.
  Sprint 6 hides archived appointments from the reply panel and the
  question queue, and no draft for one can be built or approved until the
  archive is undone (G-f, A12 and A13 in
  `docs/decisions/0006-mcp-app.md`).
- [x] Sprint 5 or 7 work: extraction at effort `minimal` missed m2's
  "arrive 15 minutes early" office request in one of three runs, twice
  across the live runs so far. The checklist in the demo depends on it.
  Tune the prompt for office requests or extract at `low`, then measure.
  Sprint 5 changed the extraction instructions to ask for one office request
  per instruction (O-g). Three live runs after the change caught m2's two
  requests in 9 of 9 runs at `minimal` and at `low`. The second run found one
  extra claim ("Reply C to confirm.") that C2 fixed. The third run was 100%
  at both levels with no extra claims.

## Sprint 2: slot states and conflict resolution (D2)

Branch `sprint/02-conflict-resolution`.

Goal: accepted evidence becomes slot states by fixed rules, every
disagreement is shown with both sources, and the app asks one question at a
time.

Acceptance:

- Deterministic tests for S1 to S7 pass.
- The conflict view shows both sources for every disagreement.
- A calendar clash shows on any offered or requested slot that overlaps a
  calendar event.
- Every model explanation cites evidence IDs, and the cited quotes show
  beside it.
- The app asks one question at a time.

Tasks:

- [x] SP2.1 Slot projection: compute slot records and states (offered,
  requested, confirmed, change proposed, canceled, declined) from accepted
  evidence events only.
- [x] SP2.2 Source label beside each state: "office message", "reported by
  you", "reported by you through <grant name>".
- [x] SP2.3 Rule 1: only office evidence or a user report moves a confirmed
  slot to canceled.
- [x] SP2.4 Rule 2 and S3: the user chooses a replacement. This records a
  request on the replacement and leaves the original unchanged.
- [x] SP2.5 Rule 3 and S4: a confirmation of the replacement releases the
  original only when the evidence says it was moved or canceled. Otherwise
  both stay held and the app asks which one stands.
- [x] SP2.6 Rules 4 and 5: when both event times are known, the later event
  wins. When either is unknown, raise a conflict instead of choosing.
- [x] SP2.7 Rule 6 and S6: an automated reminder with an unknown event time
  that contradicts a later confirmed or reported event is marked possibly
  stale. Ask once. No state change.
- [x] SP2.8 S5: a user report ("They moved me to Monday") confirms Monday and
  cancels Thursday, both labeled "reported by you".
- [x] SP2.9 S7: an incomplete slot (date without time or location) is marked
  incomplete and produces a question for the missing detail.
- [x] SP2.10 Calendar clash detection against the loaded `.ics` file for
  offered and requested slots.
- [x] SP2.11 Question queue: one open question at a time. The answer is
  recorded as user-reported evidence and goes through review.
- [x] SP2.12 Model call: discrepancy explanation that cites evidence IDs.
  Code rejects an explanation that cites an unknown ID. One retry, then the
  conflict shows with its quotes and no explanation (proposed).
- [x] SP2.13 Model call: propose the next clarifying question. Code
  validates it against the open conflicts and asks it through the question
  queue. One retry, then a fixed wording for that conflict (proposed).
- [x] SP2.14 Conflict view in the UI: both sources, their quotes, the state
  with its source, calendar clashes, the explanation labeled as model
  output, and the current question.
- [x] SP2.15 Recorded responses for the new calls, and fixture stubs marked
  D2 turned into real expectations.
- [x] SP2.16 Live evaluation: add explanation and question calls. Report the
  rate of valid citations and the rejection count.

## Sprint 3: reviewed reply (D3)

Branch `sprint/03-reviewed-reply`. May run beside sprint 4.

Goal: the user sends replies only through templates that fix what the reply
asserts, after reading back every field.

Acceptance:

- Each template renders only in the states its table allows (S9).
- Every rendered field matches the case state, and the UI reads the fields
  back before approval.
- A user edit shows "Edited by you. Not checked."
- Invalid model output gets one retry and then falls back to manual entry.
- The simulated send meets S12.

Tasks:

- [x] SP3.1 Template definitions: accept an offered slot, decline and ask for
  another time, ask whether a slot still stands, keep the original.
- [x] SP3.2 Validity table: each template checks the slot state before it
  renders. S9: accepting a slot that is not offered is blocked.
- [x] SP3.3 S7 template part: no template that needs a missing detail is
  offered for an incomplete slot.
- [x] SP3.4 Model call: pick a template and propose field values. Code
  validates each field against slot states. One retry, then manual entry.
- [x] SP3.5 Field readback in the UI before approval.
- [x] SP3.6 User edit of the rendered text, labeled "Edited by you. Not
  checked."
- [x] SP3.7 Approval records a request event. An accepted slot becomes
  requested.
- [x] SP3.8 S12: simulated send labeled "Simulated. Nothing was sent." A
  test proves no network request leaves the app.
- [x] SP3.9 S11: a clinical question gets a fixed decline that states the
  administrative scope. No model call answers it.
- [x] SP3.10 Recorded responses and live evaluation for template selection.

## Sprint 4: MCP core (D5, part 1)

Branch `sprint/04-mcp-core`. May run beside sprint 3. Touches `src/` domain
and a new `mcp/` folder, not the reply UI.

Goal: one domain service that both the app and an MCP server call, with
grants checked on every call.

Tasks:

- [x] SP4.1 Domain events for notes, tags, archive, and undo as a reversing
  event. Every write states its expected version.
- [x] SP4.2 S14: a stale expected version returns a stale-edit error with the
  current record and writes nothing.
- [x] SP4.3 S17: archive removes a record from the default list, keeps it in
  history, and undo brings it back.
- [x] SP4.4 Grant store: create, name, revoke, and tiers (read, annotate,
  propose). Off by default. Tokens stored hashed (proposed).
- [x] SP4.5 Choose the MCP server library. Record license, install scripts,
  and publish age in a decision doc.
- [x] SP4.6 stdio server that reads the same store as the app and checks the
  current grant on every call, with no cache across calls.
- [x] SP4.7 Tools: `list_appointments`, `get_appointment`,
  `list_open_questions`, `add_note`, `set_tags`, `propose_change`. Each has an
  `outputSchema` and returns `structuredContent` plus the JSON text.
- [x] SP4.8 `tools/list` returns only the tools the grant allows. S18: no
  tool for grants, delete case, sending, or confirming a proposal exists.
- [x] SP4.9 S13 and S19: revoked or lower-tier grants fail at call time even
  if the client lists the tool.
- [x] SP4.10 S16 and rule 8: `propose_change` enters the review queue and
  changes no state until the user confirms in the app.
- [x] SP4.11 S15: imported text addressed to an assistant stays data. Quotes
  appear only in labeled fields, and full message bodies only from a separate
  tool. Tool descriptions say quoted text is untrusted. No tool returns a
  message body in this sprint (M-c in `docs/decisions/0004-mcp-core.md`).
- [x] SP4.12 Input validation with the app's rules, a rate limit, and a log
  entry in the case history for every call with grant name, tool, and result.

## Sprint 5: saved outcome and checklist (D4)

Branch `sprint/05-saved-outcome`.

Acceptance:

- S10 passes.
- An office reply that arrives after the reopen updates state through the
  same review step as any other evidence.
- Each checklist item carries its quote and source.
- Delete case removes the stored data, and a test checks that it is gone.

Tasks:

- [x] SP5.1 S10: closing the app after a draft and before approval, then
  reopening, restores the exact states and the draft.
- [x] SP5.2 A late office reply goes through extraction and review like any
  other message. Demo path: Monday becomes confirmed, Thursday canceled.
- [x] SP5.3 Checklist from accepted office requests, each item with its
  quote and source.
- [x] SP5.4 Delete case: app only, its own confirmation, erases the case and
  its event log. A test proves the data is gone. No MCP tool.
- [x] SP5.5 Case history view: events in order, including undo.

## Sprint 6: MCP in the app and connect test (D5, part 2)

Branch `sprint/06-mcp-app`.

Acceptance:

- Deterministic tests for S13 to S19 pass.
- The app and the MCP server read and write the same store, and a change from
  either one shows in the other without a restart.
- Every tool call checks the current grant, and the case history logs it.
- Every write states its expected version.
- The chosen client passes the connect test.
- A secret scan of the repository finds no grant token.

Tasks:

- [x] SP6.1 Grant screen in the app: create, name, choose tier, revoke. It
  states that the agent's own model provider may receive the case data.
- [x] SP6.2 Proposals from agents in the review queue, labeled with the grant
  name. Confirmed proposals show "reported by you through <grant name>".
- [x] SP6.3 Live refresh: a note written over MCP shows in the open app
  without a restart.
- [ ] SP6.4 Connect test with the demo client: list tools and call
  `get_appointment` once. Fallback client if it fails. Sprint 6 delivered
  the setup (`--token-file`, `APPT_GRANT_TOKEN_FILE`,
  `scripts/mcp-stdio.sh`), the guide `docs/connect-agent.md` for Grok
  Build, OpenCode and Claude Code, and an automated stand-in that runs the
  launcher with the SDK client (`test/connect.test.ts`). The run with a
  real client is Jeff's and the coordinator's.
- [x] SP6.5 Secret scan for grant tokens across the repository.
  `pnpm scan:secrets`.
- [x] SP6.6 README section on the split between model and code, and on what
  the server cannot control once data reaches the client.

## Carried over from sprint 6

- [ ] Confirm or change the decisions marked "proposed, pending Jeff" in
  `docs/decisions/0006-mcp-app.md` (G-a to G-h and A1 to A16).
- [ ] Run the connect test with Grok Build (grok-4.7, effort high) and with
  OpenCode, Claude Code as the fallback (SP6.4).
- [ ] When an agent's report confirms Monday while Thursday is still
  confirmed, rule 3 holds both and the app asks which one stands. Monday
  shows "Confirmed · reported by you through <grant name>, change
  proposed". The optional demo beat stops before the confirmation, so the
  demo is not affected. Decide whether the demo should show it.

## Sprint 7A and 7B: the agentic chat app

On 2026-10-28 Jeff decided the product is an agentic chat app: the user
talks to an agent on Muse Spark with tools, and the schedule sits beside the
chat (a tab on phones). The agent never changes slot state. Every change is
a card the user acts on with the existing routes. 7A builds the agent (tool
loop, tools, streaming chat route, grounding and scope checks, live chat
eval). 7B builds the web app (chat and schedule layout, cards, design
system, production build, mobile layout, Tailscale host setting). Both work
to one chat contract. Details live in their decision docs, 0007 and 0008.

Sprint 7A tasks (branch `sprint/07a-case-agent`, decisions in
`docs/decisions/0007-case-agent.md`):

- [x] SP7A.1 Model client for tool turns: `store: false`, streaming,
  function tools, encrypted reasoning within a turn only (G1).
- [x] SP7A.2 Nine tools, none of which changes slot state, with message
  text only in labeled untrusted fields (G2).
- [x] SP7A.3 `import_message` takes only text the person pasted, then runs
  the checked extraction and shows a claims card (G3).
- [x] SP7A.4 Grounding of the final text, one retry, fixed replacement,
  fact chips (G4). Code also replaces a claim that the agent changed
  something (C8).
- [x] SP7A.5 Scope check before any model call and on model text (G5).
- [x] SP7A.6 Draft safety, limits, malformed calls, token guard, history
  (G7, G8).
- [x] SP7A.7 Chat stream with expected versions and the case generation,
  erased by Delete case, restored on reopen (G9).
- [x] SP7A.8 `POST /api/chat` as server-sent events and `GET /api/chat`,
  behind the paired session.
- [x] SP7A.9 Recorded chat client, faults and `pnpm recording:key` (G10).
- [x] SP7A.10 `pnpm eval:live --chat` with six scripts (G11).
- [ ] SP7A.11 Live chat eval and live recordings. The coordinator runs
  them.
- [ ] SP7A.12 Confirm or change the decisions marked "proposed, pending
  Jeff" in `docs/decisions/0007-case-agent.md`.

Sprint 7B tasks (branch `sprint/07b-web-app`):

- [x] SP7B.1 Chat and schedule layout for laptop, tablet and phone (W1, W2).
- [x] SP7B.2 Thread, streaming, tool line, fact chips and cards from the
  live case view (W3, W4), with a scripted mock chat until 7A merges.
- [x] SP7B.3 Composer, calendar file button, suggestions and the demo path
  (W5).
- [x] SP7B.4 Design system, light and dark themes, accessibility (W6).
- [x] SP7B.5 Old UI removed, its tests moved to the new parts (W7, W8).
- [x] SP7B.6 `pnpm build` and `pnpm start` with precompression, cache
  headers, a strict CSP and the 150 KB budget (P1, P2).
- [x] SP7B.7 `APP_ALLOWED_HOSTS` and a Secure cookie over HTTPS (P3).
- [x] SP7B.9 "Add an office message" outside the chat, under the scope
  decline and in the composer (W9, proposed).
- [x] SP7B.8 After 7A merges, rebase and switch the page to the real
  `/api/chat` route.
- [ ] Confirm or change the decisions in `docs/decisions/0008-web-app.md`
  (W1 to W9, P1 to P3, B1 to B23).

## Sprint 8: failure testing

Branch `sprint/08-failure-testing`.

- [ ] SP7.1 Full fixture suite S1 to S19 against the final model and host.
- [ ] SP7.2 Fixed set of out-of-scope prompts for S11. A manual review finds
  no clinical content in any response.
- [ ] SP7.3 Demo path end to end three times with no manual fix.
- [ ] SP7.4 Fix what breaks. No new features.
- [ ] SP7.5 Milestone: fast-forward `prod` to `dev` with Jeff's approval.

Stretch work starts only after SP7.1 passes, in this order: intake form,
calendar export, voice input.

## Sprint 9: submission build

Branch `sprint/09-submission`.

- [ ] SP8.1 Rehearse and record the three-minute demo.
- [ ] SP8.2 Review the video and screenshots frame by frame for tokens and
  keys.
- [ ] SP8.3 README for judges: what it does, how to run it, what the model
  does and what code checks, limits.
- [ ] SP8.4 Security audit of the repository and its history before
  publication. Checkpoint refs never go to the public repo.
- [ ] SP8.5 Fast-forward `prod`. Publish only with Jeff's approval. Submit
  before the deadline.
