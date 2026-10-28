// The schedule panel beside the chat: Schedule, Checklist and Activity.
// Settings moved to the sidebar (0015). The Schedule tab starts with what waits for the user, so
// nothing depends on finding the right chat card.
import { useRef, type KeyboardEvent } from "react";
import type { AppState } from "../api.ts";
import type { Run } from "../components/ActionButton.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { EvidenceCard } from "../case/ClaimsCard.tsx";
import { ExplanationCard, QuestionCard } from "../case/ConflictCards.tsx";
import { api } from "../api.ts";
import { ActionButton } from "../components/ActionButton.tsx";
import { OwnReportCard, openOwnReports } from "../case/OwnReportCard.tsx";
import { ReplyPanel } from "../case/ReplyCard.tsx";
import { zoneWithShortName } from "../format.ts";
import { Agenda } from "./Agenda.tsx";
import { InfoTip } from "../components/InfoTip.tsx";
import { ActivityTab, ChecklistPanel } from "./CaseTabs.tsx";

export type PanelTab = "schedule" | "checklist" | "activity";

export const TABS: Array<{ id: PanelTab; label: string; icon: IconName }> = [
  { id: "schedule", label: "Schedule", icon: "calendar" },
  { id: "checklist", label: "Checklist", icon: "checklist" },
  { id: "activity", label: "Activity", icon: "activity" },
];

// The name of a tab's button on the laptop's folded rail. The Schedule
// button says how many things wait, as its badge shows (review R4).
export const railLabel = (t: { id: PanelTab; label: string }, waiting: number) => `Open ${t.label}${t.id === "schedule" && waiting > 0 ? `, ${waiting} waiting for you` : ""}`;

// A conflict that waits to be asked about, when no question is open. The
// chat usually asks it. Without the chat, or when the chat cannot answer,
// the Schedule tab offers it (0008, B19).
export function unaskedConflict(state: AppState) {
  if (state.case.question) return undefined;
  return state.case.conflicts.find((c) => c.status === "open" && c.askable && c.archivedSlotKeys.length === 0);
}

// How many things wait for the user: an own-report question, facts no one
// has decided, the open question or a conflict waiting for one, and the
// open reply draft.
export function waitingCount(state: AppState): number {
  return (
    openOwnReports(state).length +
    state.evidence.filter((e) => e.status === "pending").length +
    (state.case.question || unaskedConflict(state) ? 1 : 0) +
    (state.case.reply.draft ? 1 : 0)
  );
}

export function SchedulePanel({
  state,
  run,
  tab,
  onTab,
  highlight,
  onClose,
  onCollapse,
}: {
  state: AppState;
  run: Run;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  highlight: string | null;
  onClose?: () => void;
  // On a laptop, folds the panel to a narrow rail.
  onCollapse?: () => void;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const waiting = waitingCount(state);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    onTab(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };
  return (
    <>
      <div className="panel-head">
        <h2 id="panel-title" tabIndex={-1}>
          Your schedule
        </h2>
        {onCollapse && (
          <button type="button" className="btn btn-ghost btn-icon panel-collapse" onClick={onCollapse} aria-label="Fold the schedule to a rail" title="Fold to a rail">
            <Icon name="rail" />
          </button>
        )}
        {onClose && (
          <button type="button" className="btn btn-ghost btn-icon panel-close" onClick={onClose} aria-label="Close the schedule">
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="tabs" role="tablist" aria-labelledby="panel-title" onKeyDown={onKey}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`tabpanel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => onTab(t.id)}
          >
            {t.label}
            {t.id === "schedule" && waiting > 0 && (
              <span className="count" aria-label={`${waiting} waiting for you`}>
                {waiting}
              </span>
            )}
          </button>
        ))}
      </div>
      {/* Keyed by tab, so each tab opens at its top with a short fade. */}
      <div key={tab} className="panel-body" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === "schedule" && <ScheduleTab state={state} run={run} highlight={highlight} />}
        {tab === "checklist" && <ChecklistPanel items={state.case.checklist} />}
        {tab === "activity" && <ActivityTab history={state.history} />}
      </div>
    </>
  );
}

export function ScheduleTab({ state, run, highlight }: { state: AppState; run: Run; highlight: string | null }) {
  const kase = state.case;
  const pending = state.evidence.filter((e) => e.status === "pending");
  const reply = kase.reply;
  const replyWaiting = reply.draft !== null || reply.suggestion !== null;
  const conflict = unaskedConflict(state);
  const owns = openOwnReports(state);
  const needsYou = owns.length > 0 || pending.length > 0 || kase.question !== null || conflict !== undefined || replyWaiting;
  return (
    <div className="stack">
      {needsYou && (
        <section className="stack" aria-labelledby="needs-you">
          <h3 id="needs-you">Waiting for you</h3>
          {owns.map((m) => (
            <OwnReportCard key={m.id} messageId={m.id} state={state} run={run} />
          ))}
          {pending.map((e) => (
            <EvidenceCard key={e.id} item={e} state={state} run={run} />
          ))}
          {kase.question && kase.conflicts.find((c) => c.id === kase.question!.conflictId)?.explanation && (
            <ExplanationCard conflictId={kase.question.conflictId} state={state} run={run} compact />
          )}
          {kase.question && <QuestionCard conflictId={kase.question.conflictId} state={state} run={run} showDraft={false} />}
          {conflict && (
            <>
              <ExplanationCard conflictId={conflict.id} state={state} run={run} compact />
              <div className="btn-row">
                <ActionButton run={run} variant="primary" action={() => api.nextQuestion(kase.questionsVersion)}>
                  Ask me the question about this
                </ActionButton>
              </div>
            </>
          )}
          {replyWaiting && <ReplyPanel reply={{ ...reply, sent: [] }} run={run} />}
        </section>
      )}
      <section className="stack" aria-labelledby="appointments">
        <div className="section-head">
          <h3 id="appointments">
            Appointments
            <InfoTip label="How appointments are built">
              <p>{SLOTS_NOTE}</p>
              <p>{calendarNote(state)}</p>
            </InfoTip>
          </h3>
          <span className="small muted tabular">{zoneWithShortName()}</span>
        </div>
        <Agenda state={state} run={run} highlight={highlight} />
      </section>
      {reply.sent.length > 0 && (
        <section className="stack" aria-labelledby="sent">
          <h3 id="sent">Replies you approved</h3>
          <ReplyPanel reply={{ ...reply, draft: null, suggestion: null, options: [], withheld: [] }} run={run} />
        </section>
      )}
    </div>
  );
}

// The fine print behind the Appointments info button, and in Settings,
// About this app.
export const SLOTS_NOTE = "Built by code from the accepted facts. Model text never changes an appointment.";

export function calendarNote(state: AppState): string {
  const cal = state.case.calendar;
  if (!cal) return "No calendar is loaded, so clashes are not checked. Attach one from the chat.";
  return `Calendar ${cal.name}: ${cal.events.length} events. A clash check assumes an appointment lasts ${cal.assumedSlotMinutes} minutes, because messages do not state an end time.`;
}
