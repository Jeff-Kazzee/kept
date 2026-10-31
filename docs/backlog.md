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
| 7A | Case agent: chat tool loop on Muse Spark | Chat app | Oct 28 | Done |
| 7B | Web app: chat and schedule UI, production build, mobile | Chat app | Oct 28 | Done |
| 8 | Agent-first back end: actions, activity log, undo, case time zone | Chat app | Oct 28 | Done |
| 9 | Polished agent UI, outdoors theme, real routes (9, 9B, 9C) | Chat app | Oct 28 | Done (`d14d8c4`) |
| 10 | Model providers and sign-in | Chat app | Oct 28 | Done, live sign-in open |
| 11 | Gmail and Google Calendar connection | Chat app | Oct 28 | Done (`23b1dda`), real connect open |
| 12 | Failure testing and quality | All | Oct 28 to 31 | Next |
| 13 | Accounts, judge access and usage credits | Hosted app | Oct 28 to 30 | Next |
| 14 | Paid plans with Stripe | Hosted app | Oct 30 to 31 | Planned |
| 15 | Public hosting (folded into sprint 18: Tailscale Funnel) | Hosted app | Nov 1 | Moved to 18 |
| 18 | Accounts through Better Auth, and the hosted app live | Hosted app | Oct 30 to 31 | Built, go-live open |
| 19 | A shared demo Gmail and Calendar for judges | Hosted app | Oct 31 | Built, live connect open |
| 20 | The calendar-add answer no longer falls back | Chat app | Oct 31 | Built, review open |
| 21 | One shared judge code, a pool | Hosted app | Oct 31 | Built, review open |
| 16 | Submission build | All | Nov 2 to 4 | Planned |

On 2026-10-28 the plan changed to an agent-first app: sprint 8 is the
agent-first back end and time zone, sprint 9 the polished agent UI
(`docs/decisions/0011-ui-polish.md`), sprint 10 model providers and
sign-in, and sprint 11 Gmail and Google Calendar. Failure testing moved to
sprint 12 and the submission build to sprint 13.

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
- [x] A time written before its date can attach to the previous date and
  reject a real claim. Sprint 12's meaning-flip probe found it and fixed
  the parser (0013, F16).

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
- [ ] Sprint 7 work, changed in sprint 12 (SP12.4) with the live rate
  pending: the template call answers no fit too often for short notes. In the run above, "MON" (S12.1) got no fit in 2 of 3 runs and S3.4
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

## Sprint 8: agent-first back end

Branch `sprint/08-agent-first`, decisions in
`docs/decisions/0009-agent-first.md`. Jeff decided on 2026-10-28 that the
agent does the work and the person undoes (J1 to J3, J5). Sprint 9 builds
the UI and sprint 10 the model providers and sign-in, to the same
contract.

- [x] SP8A.1 One set of action tools for the in-app agent and the MCP
  server, through one actions service with the app's checks and expected
  versions. No tool approves a reply or deletes the case.
- [x] SP8A.2 Activity log with a code-written entry per action, undo with
  reversing events, and `undo_blocked` with a reason when a later action
  depends on it. `GET /api/activity` and `POST /api/activity/:id/undo`.
- [x] SP8A.3 Grants, tokens, tiers, proposals and pairing removed. Their
  routes answer 404. Old grant and proposal events are skipped.
- [x] SP8A.4 The case time zone in settings, `set_timezone`, `GET
  /api/settings` and `PUT /api/settings/timezone`. No zone is built in
  outside the demo fixtures. Tests in America/Denver, Asia/Tokyo and
  Europe/London.
- [x] SP8A.5 Chat stream `action` events and `ChatMessage.actions`. The
  action-claim check reads the turn's activity entries.
- [x] SP8A.6 Secret scan retargeted to `MODEL_API_KEY`.
- [x] SP8A.7 Chat eval scripts updated for an agent that acts.
- [ ] SP8A.8 Live chat eval and review. The coordinator runs them.
- [ ] SP8A.9 The sprint 7B UI still reads grants and proposals from
  `/api/state`. Sprint 9 replaces it.

## Sprint 12: failure testing and quality

Branch `sprint/12-failure-testing`. Fix what breaks. No new features.

- [x] SP12.1 "Am I booked Monday?" answers instead of falling back. The
  eval report keeps each replaced answer with its problems. The cause in
  the code: the schedule's state meanings used words the answer check
  cannot map, and the model repeated them (0013, F1 to F4). Confirm with
  the coordinator's live chat eval.
- [x] SP12.2 Turn latency. A turn offers only the tools the case can use,
  and the eval report times each model call, tool, check and retry (0013,
  F5, F6). The coordinator measures demo-story p50 against 5 s.
- [x] SP12.3 Replaced by J12 (0013): the app has no recorded mode. With no
  provider ready the chat and every model step answer one fixed sentence
  with a link to Settings. The recorded clients are test doubles only.
- [x] SP12.4 Reply template no-fit on short notes: the instructions say how
  to read a short note, and the D3 fixtures add three (0013, F11, F12).
  The coordinator measures the live rate.
- [x] SP12.5 Out-of-scope and meaning-flip probes in `fixtures/chat/`
  (0013, F13 to F16). The probes found and fixed the carried-over time
  written before its date. The live set and a manual review of its
  answers are the coordinator's.
- [x] SP12.6 `pnpm eval:live --all` runs S1 to S19 in one command under one
  spend limit, and `pnpm demo:check` runs the demo path on the live app
  (`--recorded` offline) (0013, F17, F18). The live runs are the
  coordinator's.
- [x] SP12.7 The phone sheet is a div with the dialog role only while open.
  Lighthouse gives 100 on mobile and desktop (0013, F19).
- [ ] SP12.8 Real runs with Jeff: Sign in with ChatGPT, the Google
  connect, and the OpenCode connect test on his laptop.
- [ ] SP12.9 Milestone: fast-forward `prod` to `dev` with Jeff's approval.

## Sprint 13: accounts, judge access and usage credits

Branch `sprint/13-accounts`. Jeff decided on 2026-10-28 (J13 to J17):
judges use his Meta key through capped access codes, anyone may use Sign
in with ChatGPT, Meta usage is the paid service, accounts sign in with
Google, usage is charged at 3 times each model's token cost, and the
public site runs on this server through a Cloudflare Tunnel.

- [x] SP13.1 Hosted mode beside local mode. Local mode stays as now, for a
  judge who runs the app on their own computer.
- [x] SP13.2 Accounts through Sign in with Google (name and email only),
  with server-side sessions.
- [x] SP13.3 One case, settings, Google connection and ChatGPT sign-in per
  account, isolated from every other account. Delete account.
- [x] SP13.4 Usage credits: a ledger with grants, holds and charges. Every
  model call on the server key is priced from its tokens, held before the
  call and charged after. No balance, no call.
- [x] SP13.5 Judge access codes with a cap each, a total cap and an off
  switch. An admin command creates and lists them.
- [x] SP13.6 Usage page: balance, what each turn cost, and the plan.
- [ ] SP13.7 Live checks (coordinator): a Gmail connect inside a hosted
  account. (Sign in with Google was replaced by Better Auth in sprint 18,
  0020.) The live Meta check on `016be1b`
  passed: charges matched Meta's usage times 3, and `max_output_tokens`
  was accepted.
- [ ] Confirm or change the decisions in
  `docs/decisions/0014-accounts-and-credits.md` (A1 to A32). Jeff's J18
  to J20 are recorded there.

## Sprint 13B: the agent app shell

Branch `sprint/13b-shell`. Jeff decided on 2026-10-28 (L1 to L4 in
`docs/decisions/0015-shell-layout.md`): the app looks like an agent app,
with a left sidebar for navigation, the account and settings, three
columns on a laptop, and the person at the bottom of the sidebar. The demo
recording (sprint 16) waits for this sprint.

- [x] SP13B.1 The shell's types and one sidebar registry by mode, in 0015
  before the UI.
- [x] SP13B.2 Laptop: a 248 px sidebar that folds to a 64 px rail and
  remembers it, the chat, and the schedule panel with three tabs.
- [x] SP13B.3 The sidebar: Case, Connections and Agent access (local), and
  the account button with its menu: Settings, Usage (hosted), the theme
  and Sign out (hosted).
- [x] SP13B.4 Initials from the name or the email, a person icon with
  "You" and "This computer" in local mode, and "Judge access" for a judge.
- [x] SP13B.5 Sidebar pages open in the work area with the way back, and
  the case keeps its chat, scroll and draft.
- [x] SP13B.6 Tablet: the icon rail. Phone: the modal drawer from the
  menu button with the avatar.
- [x] SP13B.7 Settings left the panel, and every way in moved with it.
- [ ] ~~A Google photo for the avatar~~: dropped, accounts no longer sign in
  with Google (0020, K1).
- [ ] Confirm or change Z1 to Z9 in 0015.

## Sprint 13C: fixes from the first live Gmail and Calendar run

Branch `sprint/13c-live-fixes`. The live run on 2026-10-29 found the items
below. Decisions: `docs/decisions/0016-live-run-fixes.md`.

- [x] H1 Clash checks read Google Calendar again when the copy is more
  than a minute old or does not cover the date, once a turn per window,
  and say the calendar could not be read instead of "no events".
- [x] H2 "Read the calendar again" shows that it is reading, then when it
  read and how many events, and a plain error. Connections always shows
  the last read.
- [x] H3 The zone says "From this device" only when this device's zone
  matches, and a notice offers this device's zone with one button.
- [x] H4 The calendar event is titled by the office and the state, holds
  the office's place, and a requested slot is tentative at Google.
- [x] H5 One readback for the reply card in the chat and in the panel.
- [x] M1 The reply greets the office by name, never an address.
- [x] M2 Replies are signed only with a name the person gave in the case.
- [x] M3 Activity lines and reply sources name messages by sender and
  time, without ids.
- [x] M4 Activity says a fact was recorded, not accepted, and tells two
  requests of one message apart.
- [x] L1 A chat notice shows that its action was undone.
- [x] L2 The "New messages" pill stays clear of the slot chips.
- [x] L3 The prompt is unchanged (0016 says why).
- [x] Review fix rounds 1 and 2 (0016).
- [ ] The coordinator's live rerun with Gmail and Google Calendar.
- [ ] Confirm or change the choices marked proposed in 0016.

## Sprint 13D: fixes from the second live Gmail and Calendar run

Branch `sprint/13d-run2-fixes`. The live run 2 on 2026-10-29 found the items
below. Decisions: `docs/decisions/0017-run2-fixes.md`.

- [x] E1 Each case has its own calendar mark in the event id and the
  app's private property, so a new case never inherits an earlier case's
  event, removed or not.
- [x] E2 The event's place is the slot's own place, as the schedule and
  the reply show it.
- [x] E3 A finished answer's start stays in view, and a facts card already
  in the chat is a one-line pointer.
- [x] E4 A request log with the method, the path, the status and the time,
  never a secret. On in local mode, off in hosted mode.
- [x] E5 Delete case says it finished.
- [x] E6 The stopped-turn sentence shows once, the account's lowercase name
  never shows for a moment, no sideways scrollbar, and the tentative status
  is checked at the fake Google.
- [x] Review fix round 1 (0017): Delete case waits for writes, the mark
  only for a write, a quieter and stricter request log, the facts pointer
  and its focus, the Delete case status, the held-back name at Google, and
  "Removed in Google Calendar".
- [x] Review fix round 2 (0017): a bound on a hung turn, a Google write
  that a Delete case outlived, complete reads only, cleared reads on Delete
  case, message ids out of the log, the pointer to a gone message, no write
  without a record.
- [ ] The coordinator's live rerun with Gmail and Google Calendar.
- [ ] Confirm or change the choices marked proposed in 0017.

## Sprint 13E: the opening Gmail step from the third live run

Branch `sprint/13e-gmail-step`. The live run 3 on 2026-10-29 found the
items below. Decisions: `docs/decisions/0018-gmail-step.md`.

- [x] H1 `gmail_import` takes up to 10 message ids, each imported and
  logged on its own with its own Undo, and the instructions say to import
  every matching email.
- [x] H2 Code adds a card for each matching email a turn found and did not
  import, with "Add it", the person's import with Undo and no model call.
- [x] H3 The tools give the office's name as the page shows it and when an
  email arrived, and the instructions say to name emails by both, never by
  their first words.
- [x] H4 The instructions say to name every time the new facts state, or
  point to the facts card.
- [x] H5 An Added line for an event since removed in Google Calendar says
  so and offers no Undo, in the chat and in Activity.
- [x] H6 A refusal by the app's rules is a step that chose not to act, not
  one that did not finish.
- [x] H7 A notice that repeats a receipt is not shown.
- [x] H8 Noted: Google Calendar shows no tentative marker. No change.
- [x] The demo story's placeholder chat recordings rewritten with
  `pnpm demo:recordings`.
- [x] Review fix round 1 (0018): Add it only for offered emails of this
  account and case, one outcome per email for import and read, no sender
  name in the Gmail tools, one offer per email, and declined set only by
  the tool.
- [x] Review fix round 2 (0018): Add it checks again before it imports,
  no sender line in the paste import, hashed and used-once offers, offers
  dropped only for another account, the whole search output tested, and
  the server's sentence for an offer no longer there.
- [ ] The coordinator's live rerun of the Gmail step.
- [ ] Confirm or change the choices marked proposed in 0018.

## Sprint 14: paid plans with Stripe (deferred until after the hackathon)

Deferred by Jeff on 2026-10-28 (J18 in
`docs/decisions/0014-accounts-and-credits.md`). The plan buttons stay
"coming soon" with no payment code, and billing starts in the Stripe
sandbox when it resumes. The order until the submission is sprint 13,
hosting (sprint 15), testing, then sprint 16.

Branch `sprint/14-billing`. Stripe Checkout for the $20 and $100 plans in
test mode first, a signed webhook that grants credits once per payment,
receipts, and a profit check of the price table. Needs Jeff's Stripe
account.

## Sprint 15: public hosting

Folded into sprint 18 (0020): Tailscale Funnel on port 10000 in place of a
Cloudflare Tunnel, no Google redirect URIs, and the backups, logs and
limits below.

## Sprint 18: accounts through Better Auth, and the hosted app live

Branch `sprint/18-better-auth`. Jeff decided on 2026-10-30 (K1 to K5 in
`docs/decisions/0020-better-auth.md`): no more Google console, Better Auth
for accounts, and the site live at
`https://the-little-ai-co.tail374dd0.ts.net:10000`.

- [x] B1 Better Auth on node:sqlite in `data/hosted/auth.sqlite`, its
  migrations at start, its handler at `/api/auth/*` in hosted mode only.
- [x] B2 Email and password, rate limits from Better Auth and the app, no
  email, and `pnpm admin users reset-password`.
- [x] B3 Passkeys (`@better-auth/passkey` 1.7.14), relying party from the
  public origin.
- [x] B4 Sign in with Google removed from hosted accounts. Gmail and
  Calendar for test accounts kept.
- [x] B5 Better Auth's user mapped to one app account. Judge codes,
  credits, caps, Delete account and `account_busy` kept.
- [x] B6 HttpOnly `__Secure-` session cookie, the public origin as the only
  trusted origin, the cross-origin refusal tested.
- [x] B7 The dashboard plugin, off without its key, and what it sends
  written down. Sentinel off.
- [x] B8 `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `BETTER_AUTH_API_KEY`
  in `.env.schema`.
- [x] B9 The sign-in screen and Add a passkey, with the existing classes.
- [x] B10 `scripts/hosted/start.sh` and a systemd user unit, not
  installed.
- [x] B11 `APP_TRUSTED_PROXY=tailscale`, and the public host with its port.
- [x] B12 `pnpm admin backup` (VACUUM INTO) and the request log in hosted
  mode.
- [x] Fix round 1 (Muse Wonder and the coordinator's live run): no judge
  session revives after an email sign-in, the Delete account race, no
  grant on an expired code, Better Auth's routes as an allowlist, every
  disabled route and bad dashboard token tested, a generic sign-up
  refusal, the dashboard's trust written down, and the reply card's Place
  quote.
- [x] K6 to K9 (Jeff, 2026-10-31): the dashboard off, judges only at
  launch with `APP_PUBLIC_SIGNUP` off and `pnpm admin users create`, the
  name Kept (renamed later by the coordinator), and the waitlist link.
- [ ] Go live (coordinator, after Jeff's approval): the env file, the unit
  and the Funnel command in `docs/hosted.md`, "Going live".
- [ ] Live model checks on this branch (coordinator).
- [ ] Restyle the sign-in screen with sprint 17's look (coordinator, after
  both merge).
- [ ] Confirm or change the choices marked proposed in 0020.

## Sprint 19: a shared demo Gmail and Calendar for judges

Branch `sprint/19-demo-inbox`, from `sprint/18-better-auth`. Jeff approved
on 2026-10-31 one shared demo connection, since judges cannot connect their
own Google (D1 to D10 in `docs/decisions/0021-demo-inbox.md`).

- [x] D1 `APP_DEMO_GOOGLE=on`, hosted only, the connection in
  `hosted/demo-google.sqlite` (mode 600).
- [x] D2 `pnpm admin google demo-connect`, `demo-status` and
  `demo-disconnect`. The callback finishes a demo connect by its
  single-use state, with no session.
- [x] D3, D4 Accounts without their own connection use the shared one for
  every Gmail and Calendar tool. Keys start with `shared:`. Offers stay
  per account.
- [x] D5 Each account's events carry its mark. Reads show the calendar's
  own events and the account's own app events only.
- [x] D6 5 live events per account, 20 writes per 10 minutes, Delete case
  and Delete account cleanups, and the hourly sweep.
- [x] D7, D8 The reconnect sentence, the start log's date, Connections'
  line, no buttons for judges, and the agent's instruction.
- [x] D9, D10 Counts only in logs. Local mode unchanged.
- [x] Round 2: merged `dev` (sprint 17, Steel), closed the sprint 19
  round 1 review (findings 1 to 9) and sprint 18's round 2 lows, and the
  hosted screens in Steel (0019, 0020, 0021).
- [ ] Connect the demo account live (coordinator: `demo-connect`, Jeff
  opens the link), and renew every 7 days.
- [ ] Live checks with two judge codes (coordinator).
- [ ] Confirm or change the choices marked proposed in 0021.

## Sprint 20: the calendar-add answer

Branch `sprint/20-calendar-answer`, from `dev` `52ab27c`. "Put the Monday
appointment on my Google Calendar." fell back in 3 of 4 recorded takes
after the event was added (`docs/decisions/0022-calendar-answer.md`).

- [x] Cause: "tentative", the status `calendar_sync_slot` gives, was a
  status word the state check could not map, so the true answer failed.
- [x] C1, C2 "Tentative" maps to requested and change proposed, and said
  of the calendar or an event it needs this turn's event fact. "On the
  calendar" follows the slot's last event fact.
- [x] C3 `slot_label` and `slot_state` in the sync result, and the retry
  hint names the event's states.
- [x] C4 A sentence that opens with an action verb, without "I", must match
  the turn's activity.
- [x] C5 Copied history notes are removed from the answer.
- [x] C6 withdrawn in fix round 1: event titles are untrusted, and the
  schedule's calendar row already names the clashing event. Since fix
  round 2 a repeated title is bound to its event's date and time.
- [x] Fix round 1: Muse Wonder's findings 1 to 7 (0022, "Fix round 1"),
  live again 10 of 10 and the story with Undo and put back.
- [x] Fix round 2: the second review's findings 1 to 6 (0022, "Fix round
  2"): event context by sentence, every calendar phrasing gated, clash
  titles bound, live again 10 of 10 and Undo and put back.
- [x] Live: the calendar step 10 of 10 answered with no fallback, Undo and
  put back answered, chat eval sends 0, unsupported states 0, clinical 0.
- [ ] Review of `dev..sprint/20-calendar-answer` (coordinator).
- [ ] A recorded take of the demo story on the real Google (coordinator).

## Sprint 21: one shared judge code, a pool

Branch `sprint/21-judge-pool`, from `dev` `058f69a`. One code for a public
form, where each browser gets its own judge account and a share of one
capped pool (`docs/decisions/0023-judge-pool.md`).

- [x] P1, P2 `judge_pools`, and each pass account as a `judge_codes` row
  with `pool_id`, so the session, revoke and hold rules hold unchanged.
- [x] P3 The whole pool counts against the total cap.
- [x] P4 Sign-in in one transaction, never past the pool, and the used-up
  message.
- [x] P5 6 accounts an hour per pass, 2 an hour per client address
  (proposed).
- [x] P6 The same browser keeps its pass account (proposed).
- [x] P7 Attaching a pass refused.
- [x] P8 `create-pool`, `list`, `grant` and `revoke` on a pass.
- [x] P9 The sign-in hint and the account menu note.
- [x] P10 Migration tested on a file with the old schema and 11 codes.
- [x] Live on 5330 with temporary data: two jars, two accounts and cases,
  the pool used up, the refusal.
- [x] Fix round 1: Muse Wonder's findings 1 to 6 (0023, "Fix round 1"):
  forwarded addresses through one parser, the browser's sign-in key, no
  hold after expiry, no revoke of one pass account, the per-address hour
  in the database, the migration in one transaction with a fuller test.
  Live again on 5330 and 5331.
- [x] Fix round 2: the second review's items and the coordinator's
  decisions (0023, "Fix round 2"): the sign-in key only while signed in,
  no per-address limit on the shared or loopback address, a shared 300
  code tries in 15 minutes, the stored key hash, the expiry hold and the
  shared address tested. Live again on 5330.
- [ ] Verify the real Funnel header shape before relying on per-address
  limits there (0023, P12).
- [ ] Review of `dev..sprint/21-judge-pool` (coordinator).
- [ ] Make the pass on the public instance and put its code in the form
  (Jeff).

## Sprint 16: submission build

Branch `sprint/16-submission`.

- [ ] SP16.1 Rehearse and record the three-minute demo.
- [ ] SP16.2 Review the video and screenshots frame by frame for tokens and
  keys.
- [ ] SP16.3 README for judges: what it does, how to run it, what the model
  does and what code checks, limits.
- [ ] SP16.4 Security audit of the repository and its history before
  publication. Checkpoint refs never go to the public repo.
- [ ] SP16.5 Fast-forward `prod`. Publish only with Jeff's approval. Submit
  before the deadline.

## Sprint 17: design, UX and performance polish

Branch `sprint/17-polish`. Decisions: `docs/decisions/0019-polish.md`.

- [x] P1 Inter, self-hosted and preloaded, with a metric-matched fallback
  and a tighter type scale.
- [x] P2 Tokens for every color, space, radius, surface, elevation and
  motion, with a test against raw values.
- [x] P3 Quiet, plain and emphasized cards. Receipts in one quiet group.
- [x] P4 One inline icon set.
- [x] P5 A turn reads as one unit, with a folding receipt group and an
  Undo per row.
- [x] P6 Slot chips only for new or changed times.
- [x] P7 A calm live step list that folds into the turn's closing line.
- [x] P8 Follow-up chips in the composer's own row, never over the
  transcript.
- [x] P9 The welcome with three start cards and the connections.
- [x] P10 The reply card with its read back progress.
- [x] P11 Today and both sides of a clash marked in the agenda.
- [x] P12 One compact "Waiting for you" card, and "Ask about this
  change".
- [x] P13 The activity timeline with relative times.
- [x] P14 Motion tokens, transform and opacity only, off under reduced
  motion.
- [x] P15 Skeletons in the shell's shape, and no welcome while the chat
  loads.
- [x] P16 The phone sheet's handle and snap points, 44 px targets,
  nothing sideways.
- [x] P17 First reads preloaded in local mode, fixtures on demand.
- [x] P18 Code split, first load 97.8 KB gzipped, budget 100 KB.
- [x] P19 Content visibility, memoized turns, layout read once per frame.
- [x] P20 The poll backs off when quiet and stops while hidden.
- [x] The scripted chat plays a demo-length transcript (P21).
- [x] LCP under 1.2 s on a 4x slowed phone with a stored chat: 848 ms
  in round 2, with the server render (P30).
- [x] Round 2: the eight Muse Wonder findings closed (0019, round 2), one
  held live read, GET /api/boot, the server-rendered case screen.
- [ ] Round 2 targets not met: INP under 50 ms (112 ms) and first-load JS
  under 80 KB counting the hydrated chunks (113.1 KB). Follow-up.
- [x] Round 3: the Steel look (0019, P34, proposed), the Muse Wonder
  round 2 findings closed, a composer that renders nothing on a key press,
  phone-layout server render and sliced hydration.
- [ ] Jeff confirms Steel over Fog (P34).
- [ ] Round 3 targets not met: INP under 50 ms (first key 72 ms, a facts
  card 120 ms), no task over 100 ms after the first paint (hydration
  commit 105 to 190 ms), first-load JS under 80 KB (not without replacing
  React). Follow-up.
- [ ] Jeff reviews the before and after screenshots.
- [ ] Confirm or change the choices marked proposed in 0019 (P21 to P34).

## Sprint 10: model providers and sign-in

Branch `sprint/10-providers`. See `docs/decisions/0010-providers.md`.

- [x] SP10.1 Provider factory: every model call goes to the provider the
  user chose, Meta by default, with no silent fallback.
- [x] SP10.2 The user's Meta key in a mode 600 settings file beside the
  event log, never sent back, logged or in the event log.
- [x] SP10.3 Sign in with ChatGPT: dynamic registration, PKCE, state,
  nonce, ID token checks, the plan-usage scope gate, refresh, sign-out with
  revocation, and the loopback callback.
- [x] SP10.4 The OpenAI Responses client for the ChatGPT path, with tool
  calling and streaming mapped to the existing shapes.
- [x] SP10.5 Model choice per provider: `GET /api/settings` models and
  `PUT /api/settings/model`, one choice for every call, capability
  problems named in settings.
- [x] SP10.6 `pnpm eval:live --provider meta|chatgpt --model <id>`.
- [x] SP10.7 Secret scan covers the settings file name and its token
  fields, and scans what can be published: the working tree, the index,
  branches, tags, remote-tracking refs and HEAD, naming the local refs it
  skips (P25).
- [x] SP10.8 `docs/sign-in.md` for judges running the app locally.
- [ ] SP10.9 Live sign-in with ChatGPT and a live eval on each provider
  (coordinator and Jeff).
- [ ] SP10.10 Settings UI for providers, models and sign-in (sprint 9):
  "Continue with ChatGPT", "Using ChatGPT plan" with a "Manage usage"
  link, the first-sign-in confirmation, and the `signedIn` and
  `signInError` query codes.
- [ ] Confirm or change the decisions in
  `docs/decisions/0010-providers.md` (P1 to P32).

## Sprint 11: Gmail and Google Calendar

Design: `docs/decisions/0012-google.md`. Setup: `docs/google.md`.

- [x] SP11.1 OAuth with PKCE and state, ID token checks, refresh and
  revoke, the token in the secrets database.
- [x] SP11.2 Gmail read-only search and import as a paste.
- [x] SP11.3 Calendar list, sync and remove per slot, only the app's own
  events, with Undo.
- [x] SP11.4 Tool specs for the agent registry, with an activity log
  interface.
- [ ] SP11.5 Jeff creates the demo Google account and the OAuth client
  (`docs/google.md`), then a real connect test.
- [x] SP11.6 The Google tools in sprint 8's registry and activity log,
  Undo through the undo route, the case time zone, Google events in the
  clash checks, the token in sprint 10's secrets database (0012, I1 to
  I8). Sprint 9's page has the Google settings.
- [ ] SP11.7 Confirm the added status fields `configured`,
  `needsReconnect` and `version` (0012, G1) and the decisions marked
  proposed.
