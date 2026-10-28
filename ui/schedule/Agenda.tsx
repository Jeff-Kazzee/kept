// The schedule as an agenda grouped by day. Each appointment shows its state
// as a badge with words, the source of that state, its place, calendar
// clashes and notes. The calendar's own events on the same days are listed
// beside them. Slot states are built by code from accepted evidence only.
import { useState } from "react";
import type { IcsEvent, IcsTime } from "../../src/domain/ics.ts";
import { dateLabel, slotIdPart, timeLabel } from "../../src/slots/labels.ts";
import type { SlotView } from "../../src/slots/types.ts";
import { api, type AppState, type EvidenceView, type RecordView } from "../api.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { StateBadge } from "../components/StateBadge.tsx";
import { stampTime, wallParts } from "../format.ts";
import { AgentQuote, UntrustedText } from "../case/Source.tsx";
import { onGoogleCalendar, useAgent } from "../agent/AgentContext.tsx";

export const slotElementId = (key: string) => `slot-${slotIdPart(key)}`;

// A calendar time on the case's clock. A UTC time is moved to the case
// time zone.
export function icsLocal(t: IcsTime): { date: string; time: string | null } {
  if (!t.utc || t.time === null) return { date: t.date, time: t.time };
  return wallParts(Date.parse(`${t.date}T${t.time}:00Z`));
}

export function icsTimeText(t: IcsTime | null): string {
  if (!t) return "";
  const local = icsLocal(t);
  return local.time === null ? "all day" : timeLabel(local.time);
}

// The latest archive of a record that is still in effect, which Undo
// reverses.
export function activeArchive(record: RecordView | undefined): number | null {
  return record?.history.filter((h) => h.type === "record_archived" && !h.undone).at(-1)?.version ?? null;
}

type Row = { kind: "slot"; date: string; time: string | null; slot: SlotView } | { kind: "event"; date: string; time: string | null; event: IcsEvent };

export function Agenda({
  state,
  run,
  initialShowArchived = false,
  highlight = null,
}: {
  state: AppState;
  run: Run;
  initialShowArchived?: boolean;
  highlight?: string | null;
}) {
  const [showArchived, setShowArchived] = useState(initialShowArchived);
  const kase = state.case;
  if (kase.slots.length === 0) {
    return (
      <div className="empty">
        <Icon name="calendar" />
        <p>No appointments yet. Paste a message from the office in the chat. The assistant adds the times it finds here.</p>
      </div>
    );
  }
  const records = new Map(state.records.map((r) => [r.id, r]));
  const archivedCount = kase.slots.filter((s) => records.get(s.key)?.archived).length;
  const shown = kase.slots.filter((s) => showArchived || !records.get(s.key)?.archived);
  const days = new Set(shown.map((s) => s.date));
  const rows: Row[] = [
    ...shown.map((slot): Row => ({ kind: "slot", date: slot.date, time: slot.time, slot })),
    ...(kase.calendar?.events ?? [])
      .map((event): Row => ({ kind: "event", ...icsLocal(event.start), event }))
      .filter((r) => days.has(r.date)),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  const byDay = new Map<string, Row[]>();
  for (const r of rows) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);

  return (
    <div className="stack">
      {(archivedCount > 0 || showArchived) && (
        <label className="check small" htmlFor="show-archived">
          <input id="show-archived" name="show-archived" type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          <span>Show archived ({archivedCount})</span>
        </label>
      )}
      {[...byDay].map(([date, dayRows]) => {
        const n = dayRows.filter((r) => r.kind === "slot").length;
        return (
        <section key={date} className="day" aria-label={dateLabel(date)}>
          <h3 className="day-head">
            {dateLabel(date)}
            <span className="day-count tabular">
              {n} appointment{n === 1 ? "" : "s"}
            </span>
          </h3>
          {dayRows.map((r) =>
            r.kind === "slot" ? (
              <SlotRow key={r.slot.key} slot={r.slot} record={records.get(r.slot.key)} state={state} run={run} highlight={highlight === r.slot.key} />
            ) : (
              <CalendarRow key={`${r.event.uid ?? r.event.summary}-${r.time}`} event={r.event} />
            ),
          )}
        </section>
        );
      })}
      {shown.length === 0 && <p className="muted">Every appointment is archived. Tick Show archived to see them.</p>}
    </div>
  );
}

function CalendarRow({ event }: { event: IcsEvent }) {
  return (
    <div className="slot calendar">
      <div className="slot-time tabular">{icsTimeText(event.start)}</div>
      <div className="slot-body">
        <div className="slot-line">
          <span className="slot-title">{event.summary}</span>
          <span className="badge badge-calendar">Your calendar</span>
        </div>
        <span className="small muted tabular">
          {icsTimeText(event.start)}
          {event.end ? ` to ${icsTimeText(event.end)}` : ""}
          {event.recurring && " · repeats, first time shown"}
        </span>
      </div>
    </div>
  );
}

// One appointment as a compact agenda row: the time, a colored rail by
// state, the place, the state pill and small markers for a clash and Google
// Calendar. The quote, notes, Archive and replies are behind Details.
function SlotRow({ slot: s, record, state, run, highlight }: { slot: SlotView; record: RecordView | undefined; state: AppState; run: Run; highlight: boolean }) {
  const kase = state.case;
  const { activity } = useAgent();
  const archiveVersion = activeArchive(record);
  const options = kase.reply.options.filter((o) => o.slotKey === s.key);
  const clashes = s.clashes ?? [];
  const onGoogle = onGoogleCalendar(activity, s.key);
  const clashWords = clashes.map((c) => `Clashes with ${c.summary} (${icsTimeText(c.start)}${c.end ? ` to ${icsTimeText(c.end)}` : ""})`);
  return (
    <article
      id={slotElementId(s.key)}
      tabIndex={-1}
      data-state={s.state}
      className={["slot", record?.archived ? "archived" : "", highlight ? "highlight" : ""].filter(Boolean).join(" ")}
      aria-label={`${s.label}: ${s.stateLabel}`}
    >
      <div className="slot-time tabular">{s.time ? timeLabel(s.time) : "No time"}</div>
      <div className="slot-body">
        <div className="slot-line">
          <span className="slot-title">{s.locationDisputed ? "Place disputed" : (s.location ?? "Place not stated")}</span>
          {clashes.length > 0 && (
            <span className="marker marker-clash" title={clashWords.join(". ")}>
              <Icon name="alert" size="sm" />
              <span>Clash</span>
              <span className="sr-only">: {clashWords.join(". ")}</span>
            </span>
          )}
          {onGoogle && (
            <span className="marker marker-gcal" title="The assistant added this to Google Calendar">
              <Icon name="google" size="sm" />
              <span className="sr-only">On Google Calendar</span>
            </span>
          )}
          {record?.archived && <span className="badge">Archived</span>}
        </div>
        <div className="slot-meta">
          <StateBadge state={s.state} />
          <span className="small muted">{s.sourceLabel}</span>
        </div>
        {s.missing.length > 0 && (
          <p className="warn">
            <Icon name="alert" size="sm" /> Incomplete: no {s.missing.map((m) => (m === "time" ? "time" : "place")).join(", no ")}
          </p>
        )}
        <details className="slot-more">
          <summary className="small">Details</summary>
          <div className="stack-sm">
            {s.locationDisputed && <span className="warn">The sources disagree on the place</span>}
            <StateQuote id={s.stateEvidenceId} state={state} />
            {s.staleEvidenceIds.length > 0 && <p className="warn">A reminder for this time may be out of date: {s.staleEvidenceIds.join(", ")}</p>}
            {clashes.length > 0 ? (
              clashWords.map((w) => (
                <p key={w} className="clash">
                  <Icon name="alert" size="sm" /> {w}
                </p>
              ))
            ) : (
              <span className="small muted">{s.clashes === null ? (s.time === null || !kase.calendar ? "Calendar not checked" : "Calendar not checked (closed)") : "No calendar clash"}</span>
            )}
            <RecordNotes record={record} />
            <div className="btn-row">
              {record?.archived && archiveVersion !== null ? (
                <ActionButton run={run} variant="ghost" action={() => api.undo(s.key, archiveVersion, record.version)}>
                  <Icon name="undo" size="sm" /> Undo archive
                </ActionButton>
              ) : (
                <ActionButton run={run} variant="ghost" action={() => api.archive(s.key, record?.version ?? 0)}>
                  <Icon name="archive" size="sm" /> Archive
                </ActionButton>
              )}
            </div>
            {options.length > 0 && !kase.reply.draft && (
              <div className="stack-sm">
                <span className="small muted">Reply to the office about this time</span>
                <div className="choices">
                  {options.map((o) => (
                    <ActionButton key={o.template} run={run} action={() => api.startDraft(o.template, o.slotKey, kase.reply.version)}>
                      {o.title}
                    </ActionButton>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>
      </div>
    </article>
  );
}

// The quote of the evidence that set a slot's state, so the state and its
// words are on screen together.
function StateQuote({ id, state }: { id: string | null; state: AppState }) {
  const item: EvidenceView | undefined = id ? state.evidence.find((e) => e.id === id) : undefined;
  const quote = item?.claim.quote;
  if (!id || !item || !quote) return null;
  if (item.origin === "agent") return <AgentQuote item={item} />;
  return (
    <blockquote className="source quote small">
      “{quote}” <code className="muted">{id}</code>
    </blockquote>
  );
}

// The notes and tags on one appointment. A note an agent wrote is
// untrusted text.
export function RecordNotes({ record }: { record: RecordView | undefined }) {
  if (!record || (record.notes.length === 0 && record.tags.length === 0)) return null;
  return (
    <div className="stack-sm">
      {record.tags.length > 0 && <p className="small">Tags: {record.tags.join(", ")}</p>}
      {record.notes.map((n) =>
        n.by.kind === "agent" ? (
          <UntrustedText key={n.id} label={`Note by ${n.by.grant_name}, ${stampTime(n.at)}`} text={n.text} />
        ) : (
          <p key={n.id} className="small">
            Note by you, {stampTime(n.at)}: {n.text}
          </p>
        ),
      )}
    </div>
  );
}
