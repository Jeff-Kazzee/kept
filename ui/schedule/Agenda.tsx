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
import { TIME_ZONE, denverTime } from "../format.ts";
import { AgentQuote, UntrustedText } from "../case/Source.tsx";

export const slotElementId = (key: string) => `slot-${slotIdPart(key)}`;

const DENVER_PARTS = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// A calendar time on the case's clock. A UTC time is moved to America/Denver.
export function icsLocal(t: IcsTime): { date: string; time: string | null } {
  if (!t.utc || t.time === null) return { date: t.date, time: t.time };
  const p = Object.fromEntries(DENVER_PARTS.formatToParts(new Date(`${t.date}T${t.time}:00Z`)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
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
        <p>No appointments yet. Paste a message from the office in the chat, then accept the facts it finds.</p>
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
      <label className="check" htmlFor="show-archived">
        <input id="show-archived" name="show-archived" type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        <span>Show archived ({archivedCount})</span>
      </label>
      {[...byDay].map(([date, dayRows]) => (
        <section key={date} className="day" aria-label={dateLabel(date)}>
          <h3 className="day-head">{dateLabel(date)}</h3>
          {dayRows.map((r) =>
            r.kind === "slot" ? (
              <SlotRow key={r.slot.key} slot={r.slot} record={records.get(r.slot.key)} state={state} run={run} highlight={highlight === r.slot.key} />
            ) : (
              <CalendarRow key={`${r.event.uid ?? r.event.summary}-${r.time}`} event={r.event} />
            ),
          )}
        </section>
      ))}
      {shown.length === 0 && <p className="muted">Every appointment is archived. Tick Show archived to see them.</p>}
    </div>
  );
}

function CalendarRow({ event }: { event: IcsEvent }) {
  return (
    <div className="slot calendar">
      <div className="slot-time">{icsTimeText(event.start)}</div>
      <div className="slot-body">
        <div className="slot-line">
          <span className="badge badge-calendar">Your calendar</span>
          <span>{event.summary}</span>
        </div>
        <span className="small muted">
          {icsTimeText(event.start)}
          {event.end ? ` to ${icsTimeText(event.end)}` : ""}
          {event.recurring && " · repeats, first time shown"}
        </span>
      </div>
    </div>
  );
}

function SlotRow({ slot: s, record, state, run, highlight }: { slot: SlotView; record: RecordView | undefined; state: AppState; run: Run; highlight: boolean }) {
  const kase = state.case;
  const archiveVersion = activeArchive(record);
  const options = kase.reply.options.filter((o) => o.slotKey === s.key);
  return (
    <article id={slotElementId(s.key)} tabIndex={-1} className={["slot", record?.archived ? "archived" : "", highlight ? "highlight" : ""].filter(Boolean).join(" ")} aria-label={`${s.label}: ${s.stateLabel}`}>
      <div className="slot-time">{s.time ? timeLabel(s.time) : "No time"}</div>
      <div className="slot-body">
        <div className="slot-line">
          <StateBadge state={s.state} />
          <span className="small muted">{s.sourceLabel}</span>
          {record?.archived && <span className="badge">Archived</span>}
        </div>
        <span className="slot-place">
          {s.locationDisputed ? <span className="warn">The sources disagree on the place</span> : (s.location ?? <span className="muted">Place not stated</span>)}
        </span>
        <StateQuote id={s.stateEvidenceId} state={state} />
        {s.missing.length > 0 && (
          <p className="warn">
            <Icon name="alert" size="sm" /> Incomplete: no {s.missing.map((m) => (m === "time" ? "time" : "place")).join(", no ")}
          </p>
        )}
        {s.staleEvidenceIds.length > 0 && <p className="warn">A reminder for this time may be out of date: {s.staleEvidenceIds.join(", ")}</p>}
        {s.clashes !== null && s.clashes.length > 0
          ? s.clashes.map((c, i) => (
              <p key={i} className="clash">
                <Icon name="alert" size="sm" /> Clashes with {c.summary} ({icsTimeText(c.start)}
                {c.end ? ` to ${icsTimeText(c.end)}` : ""})
              </p>
            ))
          : (
              <span className="small muted">
                {s.clashes === null ? (s.time === null || !kase.calendar ? "Calendar not checked" : "Calendar not checked (closed)") : "No calendar clash"}
              </span>
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
          <details className="stack-sm">
            <summary className="small">Reply to the office about this time</summary>
            <div className="choices">
              {options.map((o) => (
                <ActionButton key={o.template} run={run} action={() => api.startDraft(o.template, o.slotKey, kase.reply.version)}>
                  {o.title}
                </ActionButton>
              ))}
            </div>
          </details>
        )}
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
          <UntrustedText key={n.id} label={`Note by ${n.by.grant_name}, ${denverTime(n.at)}`} text={n.text} />
        ) : (
          <p key={n.id} className="small">
            Note by you, {denverTime(n.at)}: {n.text}
          </p>
        ),
      )}
    </div>
  );
}
