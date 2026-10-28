// Reply to the office. The user replies only through templates that fix
// what the reply asserts. Code fills every field, the user reads each one
// back, and approval sends nothing: the send is simulated and labeled.
import { useEffect, useState } from "react";
import { EDITED_LABEL, SIMULATED_SEND_LABEL } from "../src/reply/templates.ts";
import type { DraftView, ReplyView, SuggestionView } from "../src/reply/types.ts";
import { api } from "./api.ts";
import { UntrustedBox } from "./Untrusted.tsx";

type Run = (action: () => Promise<unknown>) => Promise<void>;

const ORIGIN_LABELS: Record<DraftView["origin"], string> = {
  choice: "Started from your answer to the question",
  model: "Model output: template and slot picked by the model, passed the code checks",
  manual: "Template and slot picked by you",
};

export function ReplyPanel({ reply, run }: { reply: ReplyView; run: Run }) {
  const [note, setNote] = useState("");
  return (
    <>
      <p>
        You reply to the office only through templates. Each template fixes what the reply says. Code fills every field from
        the case, and you read each one back before you approve. Sending is simulated.
      </p>
      {reply.draft ? <DraftCard draft={reply.draft} version={reply.version} run={run} /> : <p>No reply draft is open.</p>}

      <div className="card">
        <div className="label">Ask the model to pick a template</div>
        <p>
          Say what you want to tell the office, for example “I want Monday.” The model picks a template and a slot, and code
          checks the pick. Health questions are out of scope.
        </p>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} cols={80} maxLength={500} />
        <div>
          <button onClick={() => run(() => api.suggestReply(note.trim() ? note : null, reply.version))}>Suggest a reply</button>
        </div>
        {reply.suggestion && <SuggestionCard suggestion={reply.suggestion} />}
      </div>

      <div className="card">
        <div className="label">Or pick a template yourself</div>
        {reply.options.length === 0 && <p>No template fits any slot right now.</p>}
        {reply.options.map((o) => (
          <button key={`${o.template}-${o.slotKey}`} onClick={() => run(() => api.startDraft(o.template, o.slotKey, reply.version))}>
            {o.title}: {o.slotLabel}
          </button>
        ))}
        {reply.withheld.map((w) => (
          <div key={`${w.template}-${w.slotKey}`} className="warn">
            Not offered: {w.title} for {w.slotLabel}. The slot has no {w.missing.join(" or ")}.
          </div>
        ))}
      </div>

      {reply.sent.length > 0 && (
        <div>
          <div className="label">Replies you approved ({reply.sent.length})</div>
          {reply.sent.map((s) => (
            <div key={s.draftId} className="card sent">
              <div className="simulated" role="status">
                {SIMULATED_SEND_LABEL}
              </div>
              <div>
                {s.title}: {s.slotLabel} · approved <span className="nowrap">{shortTime(s.approvedAt)}</span>
                {s.evidenceIds.length > 0 && ` · recorded as ${s.evidenceIds.join(", ")}`}
              </div>
              {s.edited && <div className="warn">{EDITED_LABEL}</div>}
              {s.claims === "not_confirmed" && (
                <div className="warn">No slot change was recorded. You edited the text and did not confirm what it asserts.</div>
              )}
              <pre>{s.text}</pre>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// The fields the user ticked and the reply-stream version they were ticked
// at. Approval states that version, so the server refuses a readback made
// before a later edit.
export type Readback = { at: number; names: ReadonlySet<string> };

// True when every field was ticked at the current version. A saved edit or
// any other change to the draft moves the version, so old ticks no longer
// count.
export function readbackDone(read: Readback, draft: DraftView, version: number): boolean {
  return read.at === version && draft.fields.every((f) => read.names.has(f.name));
}

function DraftCard({ draft, version, run }: { draft: DraftView; version: number; run: Run }) {
  const [text, setText] = useState(draft.text);
  const [read, setRead] = useState<Readback>({ at: version, names: new Set() });
  const [confirmClaim, setConfirmClaim] = useState(false);
  const fieldKey = JSON.stringify(draft.fields.map((f) => [f.name, f.value]));
  // A new draft, a saved edit or any new version resets the local copy, the
  // readback and the claim confirmation.
  useEffect(() => {
    setText(draft.text);
  }, [draft.id, draft.text]);
  useEffect(() => {
    setRead({ at: version, names: new Set() });
    setConfirmClaim(false);
  }, [draft.id, draft.text, version, fieldKey]);

  const unsaved = text !== draft.text;
  const allRead = readbackDone(read, draft, version);
  const toggle = (name: string) =>
    setRead((prev) => {
      const names = new Set(prev.at === version ? prev.names : []);
      if (names.has(name)) names.delete(name);
      else names.add(name);
      return { at: version, names };
    });

  return (
    <div className={`card ${draft.origin === "model" ? "model" : ""}`}>
      <div className="label">
        Reply draft {draft.id} · {ORIGIN_LABELS[draft.origin]}
      </div>
      <p>
        <strong>{draft.title}</strong> for {draft.slotLabel}. {draft.asserts}
      </p>
      {!draft.valid && (
        <p className="warn" role="status">
          {draft.invalidNotice} ({draft.problems.join(", ")})
        </p>
      )}

      <div className="label">Read back every field before you approve</div>
      <p>Your ticks are not saved. If you close and reopen the app, the draft and your edit are kept, and you read each field again.</p>
      <table>
        <thead>
          <tr>
            <th>Read</th>
            <th>Field</th>
            <th>In the reply</th>
            <th>Where it comes from</th>
          </tr>
        </thead>
        <tbody>
          {draft.fields.map((f) => (
            <tr key={f.name}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`I read ${f.label}`}
                  checked={read.at === version && read.names.has(f.name)}
                  onChange={() => toggle(f.name)}
                />
              </td>
              <td>{f.label}</td>
              <td>
                {f.display ?? <em>Not in any accepted evidence. Left out of the reply.</em>}
                {f.untrustedLabel && <div className="warn">{f.untrustedLabel}</div>}
              </td>
              <td>
                {f.sources.length === 0
                  ? "none"
                  : f.sources.map((s, i) =>
                      s.untrustedLabel ? (
                        <div key={i}>
                          {s.evidenceId && <code>{s.evidenceId}</code>}
                          <UntrustedBox label={s.untrustedLabel} text={s.text} />
                        </div>
                      ) : (
                        <div key={i}>
                          {s.evidenceId && <code>{s.evidenceId}</code>} {s.text}
                        </div>
                      ),
                    )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="label">Reply text</div>
      {draft.edited && <div className="warn">{EDITED_LABEL}</div>}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} cols={80} maxLength={2000} />
      {draft.claimConfirmation && !unsaved && (
        <div className="card">
          <label>
            <input type="checkbox" checked={confirmClaim} onChange={(e) => setConfirmClaim(e.target.checked)} /> {draft.claimConfirmation}
          </label>
          <div>You edited the text. Tick this only if your text still says it. If you leave it unticked, approval records no slot change.</div>
        </div>
      )}
      <div>
        {unsaved && <button onClick={() => run(() => api.editDraft(draft.id, text, version))}>Save edit</button>}
        <button
          disabled={!allRead || !draft.valid || unsaved}
          onClick={() => run(() => api.approveDraft(draft.id, draft.fields.map((f) => f.name), read.at, confirmClaim))}
        >
          Approve and send (simulated)
        </button>
        <button onClick={() => run(() => api.discardDraft(draft.id, version))}>Discard</button>
      </div>
      {!allRead && <div>Tick each field after you check it against the source.</div>}
      {unsaved && <div>Save or undo your edit before you approve.</div>}
    </div>
  );
}

const NO_FIT_TEXT: Record<"time_not_offered" | "template_not_allowed", string> = {
  time_not_offered: "it names a date or time that no open slot has",
  template_not_allowed: "the slot's state does not allow the reply it asks for",
};

function SuggestionCard({ suggestion }: { suggestion: SuggestionView }) {
  return (
    <div className={`card ${suggestion.outcome === "manual_needed" ? "rejected" : "model"}`}>
      <div className="label">
        {suggestion.outcome === "valid"
          ? `Model output (${suggestion.model}, effort ${suggestion.effort}), passed the code checks`
          : suggestion.outcome === "no_fit"
            ? `Model output: no template fits your note, because ${NO_FIT_TEXT[suggestion.noFitReason ?? "time_not_offered"]}. Pick a template yourself below.`
            : suggestion.caseChanged.length > 0
            ? `The case changed during the model call, so its pick no longer fits (${suggestion.caseChanged.join(", ")}). Pick a template yourself below.`
            : "Model output failed the code checks twice. Pick a template yourself below."}
      </div>
      {suggestion.intent && <div>Your note: “{suggestion.intent}”</div>}
      <ul>
        {suggestion.attempts.map((a, i) => (
          <li key={a.attempt}>
            Attempt {a.attempt}: {a.outcome}
            {a.problems.length > 0 && ` · ${a.problems.join(", ")}`} · model output{" "}
            <code>{suggestion.outputs[i] === null ? "not readable" : JSON.stringify(suggestion.outputs[i])}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

// "2026-11-04T11:40:00-07:00" becomes "2026-11-04 11:40", in the sender's
// own clock. A UTC time keeps its zone: "2026-11-05 09:00 UTC".
export function shortTime(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")}${iso.endsWith("Z") ? " UTC" : ""}`;
}
