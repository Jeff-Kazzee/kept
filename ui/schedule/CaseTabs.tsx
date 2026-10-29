// The Checklist and Activity tabs. Both are built by code from the case.
// Activity is a timeline of every action by the assistant, an external
// agent over MCP or you, with Undo on each undoable entry and the plain
// reason when Undo is refused.
import { entryText } from "../../src/activity/types.ts";
import { dateLabel } from "../../src/slots/labels.ts";
import { ACTOR_WORDS, removedInGoogle, useAgent } from "../agent/AgentContext.tsx";
import { BlockedReason, UndoButton } from "../agent/Receipts.tsx";
import type { ChecklistItem, HistoryEntry } from "../api.ts";
import { Fox } from "../components/Art.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { InfoTip } from "../components/InfoTip.tsx";
import { UntrustedBox } from "../components/Untrusted.tsx";
import type { ActivityActor, ActivityEntry } from "../contract.ts";
import { clockTime, shortTime, stampTime, wallParts } from "../format.ts";

// What the office asked the user to bring or do, each with its quote and
// source. Built from accepted evidence, so these are not model output.
export function ChecklistPanel({ items }: { items: ChecklistItem[] }) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <Icon name="checklist" />
        <p>Nothing yet. What the office asks you to bring or do shows here once you accept it.</p>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="section-head">
        <h3>
          To bring or do
          <InfoTip label="About the checklist">
            <p>From the office requests that were accepted. Each item shows its quote and where it came from.</p>
          </InfoTip>
        </h3>
      </div>
      <ul className="stack">
        {items.map((item) => (
          <li key={item.text} className="card">
            {item.untrustedLabel ? <UntrustedBox label={item.untrustedLabel} text={item.text} /> : <strong>{item.text}</strong>}
            {item.sources.map((s) =>
              s.untrustedLabel && s.quote ? (
                <div key={s.evidenceId} className="stack-sm">
                  <UntrustedBox label={s.untrustedLabel} text={s.quote} />
                  <span className="source-meta">{s.sourceLabel}</span>
                </div>
              ) : (
                <div key={s.evidenceId} className="source">
                  <span>{s.quote ? `“${s.quote}”` : "No quote."}</span>
                  <span className="source-meta">{s.sourceLabel}</span>
                </div>
              ),
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Every event of the case in order, including undo, as a timeline.
export function HistoryPanel({ entries }: { entries: HistoryEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="empty">
        <Icon name="activity" />
        <p>No events yet.</p>
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="small muted">All {entries.length} events of this case, oldest first. Labels are written by code.</p>
      <ol className="timeline">
        {entries.map((h) => (
          <li key={h.seq}>
            <span>
              <span className={h.undone ? "undone" : undefined}>
                {h.label}
                {h.undone && " (undone)"}
              </span>
              <time dateTime={h.at}>
                #{h.seq} · {stampTime(h.at)}
              </time>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const ACTOR_ICONS: Record<ActivityActor, IconName> = { agent: "sparkle", you: "user", mcp: "robot" };

// The activity, newest first, grouped by day on the case's clock.
export function ActivityPanel({ entries }: { entries: ActivityEntry[] }) {
  const { activity, google } = useAgent();
  if (entries.length === 0) {
    return (
      <div className="empty">
        <Fox />
        <p className="empty-title">Quiet so far</p>
        <p>Each thing the assistant, an external agent or you do to this case shows here, with Undo.</p>
      </div>
    );
  }
  const days = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    const day = wallParts(Date.parse(e.at)).date;
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return (
    <div className="stack">
      <div className="section-head">
        <h3>
          Everything that happened
          <InfoTip label="About the activity">
            <p>Every action on this case, newest first, by the assistant, an external agent over MCP or you. The sentences are written by code.</p>
          </InfoTip>
        </h3>
      </div>
      {[...days].map(([day, list]) => (
        <section key={day} className="stack-sm" aria-label={dateLabel(day)}>
          <h3 className="day-head">{dateLabel(day)}</h3>
          <ol className="activity">
            {list.map((e) => {
              // 0018, H5: an event the person removed in Google since.
              const gone = removedInGoogle(activity, google?.calendarOwn, e);
              return (
                <li key={e.id} className={`activity-row${e.undone ? " is-undone" : ""}`}>
                  <span className={`avatar avatar-${e.actor}`} aria-hidden="true">
                    <Icon name={ACTOR_ICONS[e.actor]} size="sm" />
                  </span>
                  <div className="activity-body">
                    <p className="activity-text">{entryText(e)}</p>
                    <p className="activity-meta">
                      <span>{ACTOR_WORDS[e.actor]}</span>
                      <time dateTime={e.at} title={shortTime(e.at)}>
                        {clockTime(e.at)}
                      </time>
                      {e.undone && <span>Undone{e.undoneAt ? ` ${clockTime(e.undoneAt)}` : ""}</span>}
                      {gone && <span>Since removed in Google Calendar</span>}
                    </p>
                    <BlockedReason entries={[e]} />
                  </div>
                  {!gone && <UndoButton entries={[e]} label={`Undo: ${entryText(e)}`} />}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

// The Activity tab: the activity from the server, or, in a build that does
// not have it yet, the case history.
export function ActivityTab({ history }: { history: HistoryEntry[] }) {
  const { activity } = useAgent();
  if (activity) return <ActivityPanel entries={activity.entries} />;
  return (
    <div className="stack">
      <p className="notice">
        <Icon name="info" />
        <span>Undo from Activity is not available in this build yet. The case history is below.</span>
      </p>
      <HistoryPanel entries={history} />
    </div>
  );
}
