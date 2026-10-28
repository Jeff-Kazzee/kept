// The Checklist and Activity tabs. Both are built by code from the case.
import type { ChecklistItem, HistoryEntry } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { UntrustedBox } from "../components/Untrusted.tsx";
import { denverTime } from "../format.ts";

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
      <p className="small muted">From the office requests you accepted. Each item shows its quote and where it came from.</p>
      <ul className="stack">
        {items.map((item) => (
          <li key={item.text} className="card">
            {item.untrustedLabel ? <UntrustedBox label={item.untrustedLabel} text={item.text} /> : <strong>{item.text}</strong>}
            {item.sources.map((s) =>
              s.untrustedLabel && s.quote ? (
                <div key={s.evidenceId} className="stack-sm">
                  <UntrustedBox label={s.untrustedLabel} text={s.quote} />
                  <span className="source-meta">
                    {s.sourceLabel} · <code>{s.evidenceId}</code>
                  </span>
                </div>
              ) : (
                <div key={s.evidenceId} className="source">
                  <span>{s.quote ? `“${s.quote}”` : "No quote."}</span>
                  <span className="source-meta">
                    {s.sourceLabel} · <code>{s.evidenceId}</code>
                  </span>
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
                #{h.seq} · {denverTime(h.at)}
              </time>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
