// The schedule panel beside the chat: Schedule, Checklist and Activity.
// Settings moved to the sidebar (0015). The Schedule tab starts with what waits for the user, so
// nothing depends on finding the right chat card.
import { useRef, type KeyboardEvent } from "react";
import type { AppState } from "../api.ts";
import type { Run } from "../components/ActionButton.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { EvidenceCard } from "../case/ClaimsCard.tsx";
import { api } from "../api.ts";
import { ActionButton } from "../components/ActionButton.tsx";
import { ActivityTab, ChecklistPanel, ExplanationCard, OwnReportCard, QuestionCard, ReplyPanel } from "../case/lazyCards.tsx";
import { type PanelTab, TABS, unaskedConflict, waitingCount } from "./tabs.ts";
import { openOwnReports } from "../case/ownReports.ts";
import { zoneWithShortName } from "../format.ts";
import { Agenda } from "./Agenda.tsx";
import { InfoTip } from "../components/InfoTip.tsx";

export { TABS, railLabel, unaskedConflict, waitingCount, type PanelTab } from "./tabs.ts";

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
        <section className="card card-emphasis waiting" aria-labelledby="needs-you">
          <div className="waiting-head">
            <h3 id="needs-you">Waiting for you</h3>
            <span className="count" aria-hidden="true">
              {waitingCount(state)}
            </span>
          </div>
          <p className="waiting-summary small">{waitingSummary(state)}</p>
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
                  Ask about this change
                </ActionButton>
              </div>
            </>
          )}
          {replyWaiting && <ReplyPanel reply={{ ...reply, sent: [] }} run={run} profileVersion={kase.profile?.version ?? 0} generation={state.generation} />}
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

// 0019, P12: what waits, in two short lines written by code.
export function waitingSummary(state: AppState): string {
  const kase = state.case;
  const parts: string[] = [];
  const owns = openOwnReports(state).length;
  const facts = state.evidence.filter((e) => e.status === "pending").length;
  if (owns > 0) parts.push(owns === 1 ? "A question about a message you added" : `${owns} questions about messages you added`);
  if (facts > 0) parts.push(facts === 1 ? "1 fact to accept or reject" : `${facts} facts to accept or reject`);
  const conflict = kase.question ? kase.conflicts.find((c) => c.id === kase.question!.conflictId) : unaskedConflict(state);
  if (conflict) {
    const slots = kase.slots.filter((s) => conflict.slotKeys?.includes(s.key)).map((s) => s.label);
    parts.push(kase.question ? `A question about ${slots.length > 0 ? slots.join(" and ") : "a change"}` : `A change to look at${slots.length > 0 ? `: ${slots.join(" and ")}` : ""}`);
  }
  if (kase.reply.draft) parts.push(`A reply to read back: ${kase.reply.draft.slotLabel}`);
  else if (kase.reply.suggestion) parts.push("A reply to pick");
  return parts.length > 0 ? `${parts.join(". ")}.` : "";
}

// The fine print behind the Appointments info button, and in Settings,
// About this app.
export const SLOTS_NOTE = "Built by code from the accepted facts. Model text never changes an appointment.";

export function calendarNote(state: AppState): string {
  const cal = state.case.calendar;
  if (!cal) return "No calendar is loaded, so clashes are not checked. Attach one from the chat.";
  return `Calendar ${cal.name}: ${cal.events.length} events. A clash check assumes an appointment lasts ${cal.assumedSlotMinutes} minutes, because messages do not state an end time.`;
}
