// The schedule panel beside the chat: Schedule, Checklist, Activity and
// Settings. The Schedule tab starts with what waits for the user, so
// nothing depends on finding the right chat card.
import { useRef, type KeyboardEvent } from "react";
import type { AppState } from "../api.ts";
import type { Run } from "../components/ActionButton.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { EvidenceCard } from "../case/ClaimsCard.tsx";
import { ExplanationCard, QuestionCard } from "../case/ConflictCards.tsx";
import { api } from "../api.ts";
import { ActionButton } from "../components/ActionButton.tsx";
import { ReplyPanel } from "../case/ReplyCard.tsx";
import { zoneWithShortName } from "../format.ts";
import { Agenda } from "./Agenda.tsx";
import { ActivityTab, ChecklistPanel } from "./CaseTabs.tsx";
import { SettingsPanel } from "./Settings.tsx";

export type PanelTab = "schedule" | "checklist" | "activity" | "settings";

export const TABS: Array<{ id: PanelTab; label: string; icon: IconName }> = [
  { id: "schedule", label: "Schedule", icon: "calendar" },
  { id: "checklist", label: "Checklist", icon: "checklist" },
  { id: "activity", label: "Activity", icon: "activity" },
  { id: "settings", label: "Settings", icon: "settings" },
];

// A conflict that waits to be asked about, when no question is open. The
// chat usually asks it. Without the chat, or when the chat cannot answer,
// the Schedule tab offers it (0008, B19).
export function unaskedConflict(state: AppState) {
  if (state.case.question) return undefined;
  return state.case.conflicts.find((c) => c.status === "open" && c.askable && c.archivedSlotKeys.length === 0);
}

// How many things wait for the user: facts no one has decided, the open
// question or a conflict waiting for one, and the open reply draft.
export function waitingCount(state: AppState): number {
  return (
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
            <Icon name={t.icon} size="sm" />
            {t.label}
            {t.id === "schedule" && waiting > 0 && (
              <span className="count" aria-label={`${waiting} waiting for you`}>
                {waiting}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="panel-body" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === "schedule" && <ScheduleTab state={state} run={run} highlight={highlight} />}
        {tab === "checklist" && <ChecklistPanel items={state.case.checklist} />}
        {tab === "activity" && <ActivityTab history={state.history} />}
        {tab === "settings" && <SettingsPanel mode={state.mode} modelClient={state.modelClient} version={state.caseVersion} erasePending={state.erasePending} run={run} />}
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
  const needsYou = pending.length > 0 || kase.question !== null || conflict !== undefined || replyWaiting;
  return (
    <div className="stack">
      {needsYou && (
        <section className="stack" aria-labelledby="needs-you">
          <h3 id="needs-you">Waiting for you</h3>
          {pending.map((e) => (
            <EvidenceCard key={e.id} item={e} state={state} run={run} />
          ))}
          {kase.question && kase.conflicts.find((c) => c.id === kase.question!.conflictId)?.explanation && (
            <ExplanationCard conflictId={kase.question.conflictId} state={state} run={run} />
          )}
          {kase.question && <QuestionCard conflictId={kase.question.conflictId} state={state} run={run} showDraft={false} />}
          {conflict && (
            <>
              <ExplanationCard conflictId={conflict.id} state={state} run={run} />
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
          <h3 id="appointments">Appointments</h3>
          <span className="small muted">Times in {zoneWithShortName()}</span>
        </div>
        <p className="small muted">Built by code from the accepted facts. Model text never changes an appointment.</p>
        <CalendarLine state={state} />
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

function CalendarLine({ state }: { state: AppState }) {
  const cal = state.case.calendar;
  if (!cal) return <p className="small muted">No calendar loaded, so clashes are not checked. Load one from the chat.</p>;
  return (
    <p className="small muted">
      Calendar {cal.name}: {cal.events.length} events. A clash check assumes an appointment lasts {cal.assumedSlotMinutes} minutes, because messages do not state an end time.
    </p>
  );
}
