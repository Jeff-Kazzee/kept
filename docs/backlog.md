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
| 15 | Public hosting through a Cloudflare Tunnel | Hosted app | Nov 1 | Planned |
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
- [ ] SP13.7 Live checks (coordinator): a real Sign in with Google and a
  Gmail connect inside a hosted account. The live Meta check on `016be1b`
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
- [ ] A Google photo for the avatar: needs the `profile` scope in the
  Google console and the server (0014 J16 asks for name and email only).
- [ ] Confirm or change Z1 to Z9 in 0015.

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

Branch `sprint/15-hosting`. A Cloudflare Tunnel from this server to Jeff's
domain, the host allowlist, the Google redirect URIs on that domain,
backups, logs and limits. Publishing needs Jeff's approval.

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
