import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CLAIM_TYPES, type Channel, type ClaimType, type Effort } from "../src/domain/claim.ts";
import { parseIcs, type IcsEvent } from "../src/domain/ics.ts";
import { ApiError, api, type AppState, type EvidenceView, type FixtureScenario, type MessageView } from "./api.ts";

const CHANNELS: Channel[] = ["sms", "email", "portal", "voicemail_transcript", "user_report"];

const slotText = (s: { date: string | null; time: string | null; location: string | null }) =>
  [s.date ?? "no date", s.time ?? "no time", s.location ?? "no location"].join(" · ");

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Runs an action, shows its error, and reloads state. A 409 means the
  // record changed since it was shown, so the reload shows the current one.
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setError(null);
      try {
        await action();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) setError("This record changed since it was shown. The current version is loaded.");
        else setError(e instanceof Error ? e.message : String(e));
      }
      await refresh();
    },
    [refresh],
  );

  if (!state) return <p>Loading…</p>;
  const pending = state.evidence.filter((e) => e.status === "pending");
  const decided = state.evidence.filter((e) => e.status !== "pending");

  return (
    <>
      <h1>Appointment evidence intake</h1>
      <p>
        Administrative facts only: times, places, confirmations and what the office asked you to bring or do. No inbox
        access. All data here is synthetic. Model: <strong>{state.mode === "live" ? "live model" : "recorded responses"}</strong>.
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      <section>
        <h2>1. Add messages</h2>
        <PasteForm onAdd={(m) => run(() => api.addMessage(m))} />
        <FixturePicker
          imported={new Set(state.messages.map((m) => m.id))}
          onAdd={(messages) => run(async () => {
            for (const m of messages) await api.addMessage(m);
          })}
        />
      </section>

      <section>
        <h2>2. Calendar</h2>
        <CalendarPanel />
      </section>

      <section>
        <h2>3. Messages and extraction</h2>
        {state.messages.length === 0 && <p>No messages yet.</p>}
        {state.messages.map((m) => (
          <MessageCard key={m.id} view={m} run={run} />
        ))}
      </section>

      <section>
        <h2>4. Review queue ({pending.length})</h2>
        <p>Nothing counts as evidence until you accept it.</p>
        {pending.length === 0 && <p>No claims wait for review.</p>}
        {pending.map((e) => (
          <EvidenceCard key={e.id} item={e} state={state} run={run} />
        ))}
      </section>

      <section>
        <h2>5. Reviewed claims</h2>
        {decided.length === 0 && <p>None yet.</p>}
        {decided.map((e) => (
          <EvidenceCard key={e.id} item={e} state={state} run={run} />
        ))}
      </section>
    </>
  );
}

function PasteForm({ onAdd }: { onAdd: (m: { channel: Channel; from: string; received_at: string; text: string }) => void }) {
  const [channel, setChannel] = useState<Channel>("sms");
  const [from, setFrom] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [text, setText] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const at = receivedAt ? new Date(receivedAt) : new Date();
    onAdd({ channel, from, received_at: at.toISOString(), text });
    setText("");
  };

  return (
    <form onSubmit={submit} className="card">
      <div className="label">Paste a message</div>
      <label>
        Channel{" "}
        <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {c === "user_report" ? "my own report (a call, a visit)" : c}
            </option>
          ))}
        </select>
      </label>
      <label>
        Sender <input value={from} onChange={(e) => setFrom(e.target.value)} required maxLength={200} />
      </label>
      <label>
        Received <input type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} /> (empty means now)
      </label>
      <label>
        Text
        <br />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} cols={80} required maxLength={20000} />
      </label>
      <button type="submit">Add message</button>
    </form>
  );
}

function FixturePicker({ imported, onAdd }: { imported: Set<string>; onAdd: (m: FixtureScenario["messages"]) => void }) {
  const [scenarios, setScenarios] = useState<FixtureScenario[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    void api.fixtures().then(setScenarios);
  }, []);

  const all = new Map(scenarios.flatMap((s) => s.messages.map((m) => [m.id, m] as const)));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="card">
      <div className="label">Or select synthetic fixture messages</div>
      {scenarios.map((s) => (
        <details key={s.id}>
          <summary>
            {s.id}: {s.title}
          </summary>
          {s.messages.map((m) => (
            <label key={`${s.id}-${m.id}`}>
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                disabled={imported.has(m.id)}
                onChange={() => toggle(m.id)}
              />{" "}
              {m.id} · {m.channel} · {m.from} · {m.received_at}
              {imported.has(m.id) && " (added)"}
            </label>
          ))}
        </details>
      ))}
      <button
        disabled={selected.size === 0}
        onClick={() => {
          onAdd([...selected].map((id) => all.get(id)!).sort((a, b) => a.received_at.localeCompare(b.received_at)));
          setSelected(new Set());
        }}
      >
        Add selected ({selected.size})
      </button>
    </div>
  );
}

function CalendarPanel() {
  const [events, setEvents] = useState<IcsEvent[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = (fileName: string, text: string) => {
    try {
      setEvents(parseIcs(text));
      setName(fileName);
      setError(null);
    } catch (e) {
      setEvents(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="card">
      <label>
        Load a synthetic .ics file{" "}
        <input
          type="file"
          accept=".ics,text/calendar"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) load(file.name, await file.text());
          }}
        />
      </label>
      <button onClick={async () => {
        const cal = await api.calendar();
        load(cal.name, cal.text);
      }}>
        Load demo calendar (dana.ics)
      </button>
      {error && <p className="error">{error}</p>}
      {events && (
        <>
          <p>
            {name}: {events.length} events
          </p>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Start</th>
                <th>End</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev, i) => (
                <tr key={ev.uid ?? i}>
                  <td>{ev.start.date}</td>
                  <td>
                    {ev.start.time ?? "all day"} {ev.start.utc ? "UTC" : (ev.start.tzid ?? "")}
                  </td>
                  <td>{ev.end?.time ?? ""}</td>
                  <td>
                    {ev.summary}
                    {ev.recurring && " (repeats, first instance shown)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function MessageCard({ view, run }: { view: MessageView; run: (a: () => Promise<unknown>) => Promise<void> }) {
  const [effort, setEffort] = useState<Effort>("low");
  const [manualOpen, setManualOpen] = useState(false);
  const m = view.message;

  return (
    <div className="card">
      <div>
        <strong>{m.from}</strong> · {m.channel} · received {m.received_at} ·{" "}
        {view.sourceType === "reported_by_user" ? "reported by you" : "office message"}
      </div>
      <div className="label">Message text (shown as data, never followed)</div>
      <pre>{m.text}</pre>
      <div>Status: {statusText(view.status)}</div>

      {view.status === "imported" && (
        <div>
          <select value={effort} onChange={(e) => setEffort(e.target.value as Effort)}>
            <option value="low">effort low</option>
            <option value="minimal">effort minimal</option>
          </select>
          <button onClick={() => run(() => api.extract(view.id, effort, view.version))}>Extract claims</button>
        </div>
      )}

      {view.attempts.length > 0 && (
        <ul>
          {view.attempts.map((a) => (
            <li key={a.attempt}>
              Attempt {a.attempt} ({a.effort}, {a.latency_ms} ms): {a.outcome}
              {a.problem && ` · ${a.problem}`}
              {a.detail && ` · ${a.detail}`}
            </li>
          ))}
        </ul>
      )}

      {view.rejections.length > 0 && (
        <div>
          <div className="label">Model output rejected by code checks</div>
          {view.rejections.map((r, i) => (
            <div key={i} className="card rejected">
              Attempt {r.attempt}: {r.claim.claim_type} · {slotText(r.claim)} · problems: {r.problems.join(", ")}
              <pre>Quote from model: {r.claim.quote}</pre>
            </div>
          ))}
        </div>
      )}

      {view.status === "manual_entry_needed" && <p>Extraction failed after one retry. Enter the claims by hand.</p>}
      {(view.status === "manual_entry_needed" || manualOpen) && (
        <ManualEntryForm messageId={view.id} run={run} onDone={() => setManualOpen(false)} />
      )}
      {view.status !== "manual_entry_needed" && !manualOpen && (
        <button onClick={() => setManualOpen(true)}>Add a claim by hand</button>
      )}
    </div>
  );
}

function statusText(status: MessageView["status"]): string {
  switch (status) {
    case "imported":
      return "not extracted yet";
    case "claims_pending":
      return "claims extracted, waiting for your review";
    case "no_claims":
      return "no appointment facts found";
    case "manual_entry_needed":
      return "manual entry needed";
  }
}

function ManualEntryForm({
  messageId,
  run,
  onDone,
}: {
  messageId: string;
  run: (a: () => Promise<unknown>) => Promise<void>;
  onDone: () => void;
}) {
  const [claimType, setClaimType] = useState<ClaimType>("offer");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [location, setLocation] = useState("");
  const [quote, setQuote] = useState("");
  const [requestItem, setRequestItem] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const orNull = (s: string) => (s.trim() ? s.trim() : null);
    void run(async () => {
      await api.manual(messageId, {
        claim_type: claimType,
        date: orNull(date),
        time: orNull(time),
        location: orNull(location),
        quote: orNull(quote),
        request_item: orNull(requestItem),
      });
      onDone();
    });
  };

  return (
    <form onSubmit={submit} className="card">
      <div className="label">Manual entry (recorded as reported by you)</div>
      <label>
        Claim type{" "}
        <select value={claimType} onChange={(e) => setClaimType(e.target.value as ClaimType)}>
          {CLAIM_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        Date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label>
        Time <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <label>
        Location <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={300} />
      </label>
      {claimType === "office_request" && (
        <label>
          Item to bring or task <input value={requestItem} onChange={(e) => setRequestItem(e.target.value)} maxLength={300} />
        </label>
      )}
      <label>
        Quote from the message (optional, must match exactly){" "}
        <input value={quote} onChange={(e) => setQuote(e.target.value)} size={60} />
      </label>
      <button type="submit">Save claim for review</button>
    </form>
  );
}

function EvidenceCard({
  item,
  state,
  run,
}: {
  item: EvidenceView;
  state: AppState;
  run: (a: () => Promise<unknown>) => Promise<void>;
}) {
  const c = item.claim;
  const source = state.messages.find((m) => m.id === item.messageId);
  return (
    <div className={`card ${item.origin === "model" ? "model" : ""}`}>
      <div className="label">
        {item.origin === "model" ? "Model output, passed the quote check" : "Entered by you"} · {item.status}
      </div>
      <div>
        <strong>{c.claim_type}</strong> · {slotText(c.slot)}
        {c.request_item && ` · ${c.request_item}`}
      </div>
      {c.quote && <pre>“{c.quote}”</pre>}
      <div>
        Source: {c.source_type.replaceAll("_", " ")} · sender {c.sender_kind} · from {source?.message.from ?? item.messageId}{" "}
        · evidence time {c.evidence_time}
        {c.event_time && ` · event time ${c.event_time}`}
      </div>
      {item.status === "pending" && (
        <div>
          <button onClick={() => run(() => api.accept(item.id, item.version))}>Accept</button>
          <button onClick={() => run(() => api.reject(item.id, item.version))}>Reject</button>
        </div>
      )}
      {item.decidedAt && <div>Decided {item.decidedAt}</div>}
    </div>
  );
}
