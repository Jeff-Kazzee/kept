// Replies to the office. The user replies only through templates that fix
// what the reply asserts. Code fills every field, the user reads each one
// back, and approval sends nothing: the send is simulated and labeled.
import { useEffect, useId, useState } from "react";
import { EDITED_LABEL, SIMULATED_SEND_LABEL } from "../../src/reply/templates.ts";
import type { DraftView, ReplyView, SentView, SuggestionView } from "../../src/reply/types.ts";
import { api, type AppState } from "../api.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { UntrustedBox } from "../components/Untrusted.tsx";
import { shortTime } from "../format.ts";

const ORIGIN_LABELS: Record<DraftView["origin"], string> = {
  choice: "Started from your answer to the question",
  model: "Template and time picked by the model, checked by code",
  manual: "Template and time picked by you",
};

// The reply card: the draft while it is open, then its simulated send.
export function ReplyCard({ draftId, state, run }: { draftId: string; state: AppState; run: Run }) {
  const reply = state.case.reply;
  if (reply.draft?.id === draftId) return <DraftCard draft={reply.draft} version={reply.version} run={run} />;
  const sent = reply.sent.find((s) => s.draftId === draftId);
  if (sent) return <SentCard sent={sent} />;
  return (
    <div className="card">
      <p className="small muted">This reply draft was discarded or replaced. Nothing was sent.</p>
    </div>
  );
}

// The reply section of the Schedule tab: the open draft, the templates the
// user can pick by hand, and the replies already approved.
export function ReplyPanel({ reply, run }: { reply: ReplyView; run: Run }) {
  return (
    <div className="stack">
      {reply.draft && <DraftCard draft={reply.draft} version={reply.version} run={run} />}
      {reply.suggestion && <SuggestionNotice suggestion={reply.suggestion} />}
      {(reply.options.length > 0 || reply.withheld.length > 0) && (
        <details className="stack-sm">
          <summary className="small">Pick a reply template yourself</summary>
          <div className="choices">
            {reply.options.map((o) => (
              <ActionButton key={`${o.template}-${o.slotKey}`} run={run} action={() => api.startDraft(o.template, o.slotKey, reply.version)}>
                {o.title}: {o.slotLabel}
              </ActionButton>
            ))}
          </div>
          {reply.withheld.map((w) => (
            <p key={`${w.template}-${w.slotKey}`} className="warn">
              Not offered: {w.title} for {w.slotLabel}. The slot has no {w.missing.join(" or ")}.
            </p>
          ))}
        </details>
      )}
      {reply.sent.map((s) => (
        <SentCard key={s.draftId} sent={s} />
      ))}
    </div>
  );
}

export function SentCard({ sent }: { sent: SentView }) {
  return (
    <section className="card" aria-label="Approved reply">
      <div className="card-head">
        <div className="card-title">
          <Icon name="reply" /> {sent.title}: {sent.slotLabel}
        </div>
        <span className="sent-label" role="status">
          <Icon name="check" size="sm" />
          {SIMULATED_SEND_LABEL}
        </span>
      </div>
      <p className="small muted">
        Approved {shortTime(sent.approvedAt)}
        {sent.evidenceIds.length > 0 && ` · recorded as ${sent.evidenceIds.join(", ")}`}
      </p>
      {sent.edited && <p className="warn">{EDITED_LABEL}</p>}
      {sent.claims === "not_confirmed" && <p className="warn">No appointment change was recorded. You edited the text and did not confirm what it asserts.</p>}
      <pre className="reply-text">{sent.text}</pre>
      <div>
        <CopyButton text={sent.text} label="Copy the reply" />
      </div>
    </section>
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

export function DraftCard({ draft, version, run }: { draft: DraftView; version: number; run: Run }) {
  const [text, setText] = useState(draft.text);
  const [read, setRead] = useState<Readback>({ at: version, names: new Set() });
  const [confirmClaim, setConfirmClaim] = useState(false);
  const uid = useId();
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
  const ticked = draft.fields.filter((f) => read.at === version && read.names.has(f.name)).length;
  const toggle = (name: string) =>
    setRead((prev) => {
      const names = new Set(prev.at === version ? prev.names : []);
      if (names.has(name)) names.delete(name);
      else names.add(name);
      return { at: version, names };
    });

  return (
    <section className="card reply-draft" aria-label="Reply draft">
      <div className="card-head">
        <div className="card-title">
          <Icon name="reply" /> {draft.title}: {draft.slotLabel}
        </div>
        <span className="model-tag">{ORIGIN_LABELS[draft.origin]}</span>
      </div>
      <p className="small">{draft.asserts}</p>
      {!draft.valid && (
        <p className="warn-box" role="status">
          {draft.invalidNotice} ({draft.problems.join(", ")})
        </p>
      )}

      <div className="stack-sm">
        <h3>Read back every field before you approve</h3>
        <p className="small muted">
          Tick each field after you check it against its source. Your ticks are not saved. If you close and reopen the app, the draft and your edit are kept, and you read each field again.
        </p>
        <ul className="readback">
          {draft.fields.map((f) => {
            const id = `${uid}-${f.name}`;
            return (
              <li key={f.name} className="readback-row">
                <label className="check" htmlFor={id}>
                  <input id={id} name={`read-${f.name}`} type="checkbox" aria-label={`I read ${f.label}`} checked={read.at === version && read.names.has(f.name)} onChange={() => toggle(f.name)} />
                  <span>
                    <span className="muted small">{f.label}</span>
                    <br />
                    <span className="readback-value">{f.display ?? <em>Not in any accepted evidence. Left out of the reply.</em>}</span>
                  </span>
                </label>
                {f.untrustedLabel && <p className="warn">{f.untrustedLabel}</p>}
                {f.sources.length > 0 && (
                  <div className="stack-sm">
                    {f.sources.map((s, i) =>
                      s.untrustedLabel ? (
                        <div key={i} className="stack-sm">
                          {s.evidenceId && <code className="small muted">{s.evidenceId}</code>}
                          <UntrustedBox label={s.untrustedLabel} text={s.text} />
                        </div>
                      ) : (
                        <div key={i} className="source small">
                          <span>
                            {s.evidenceId && <code>{s.evidenceId}</code>} {s.text}
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="field-head">
        <label className="field-label" htmlFor={`${uid}-text`}>
          Reply text
        </label>
        <CopyButton text={text} label="Copy the reply" />
      </div>
      <label className="field" htmlFor={`${uid}-text`}>
        <span className="sr-only">Reply text</span>
        {draft.edited && <span className="warn">{EDITED_LABEL}</span>}
        <textarea id={`${uid}-text`} name="reply-text" className="textarea" value={text} onChange={(e) => setText(e.target.value)} rows={7} maxLength={2000} />
      </label>
      {draft.claimConfirmation && !unsaved && (
        <div className="warn-box stack-sm">
          <label className="check" htmlFor={`${uid}-claim`}>
            <input id={`${uid}-claim`} name="confirm-claim" type="checkbox" checked={confirmClaim} onChange={(e) => setConfirmClaim(e.target.checked)} />
            <span>{draft.claimConfirmation}</span>
          </label>
          <p>You edited the text. Tick this only if your text still says it. If you leave it unticked, approval records no slot change.</p>
        </div>
      )}
      <div className="btn-row">
        {unsaved && (
          <ActionButton run={run} action={() => api.editDraft(draft.id, text, version)}>
            Save edit
          </ActionButton>
        )}
        <ActionButton
          run={run}
          variant="primary"
          disabled={!allRead || !draft.valid || unsaved}
          action={() => api.approveDraft(draft.id, draft.fields.map((f) => f.name), read.at, confirmClaim)}
        >
          Approve and send (simulated)
        </ActionButton>
        <ActionButton run={run} variant="ghost" action={() => api.discardDraft(draft.id, version)}>
          Discard
        </ActionButton>
      </div>
      {unsaved ? (
        <p className="small muted">Save or undo your edit before you approve.</p>
      ) : !allRead ? (
        <p className="small muted">
          {ticked} of {draft.fields.length} fields read.
        </p>
      ) : null}
      <p className="small muted">Sending is simulated. Nothing leaves this app.</p>
    </section>
  );
}

const NO_FIT_TEXT: Record<"time_not_offered" | "template_not_allowed", string> = {
  time_not_offered: "it names a date or time that no open slot has",
  template_not_allowed: "the slot's state does not allow the reply it asks for",
};

// The outcome of the model's template pick, in words. The model's raw
// output is never shown.
export function SuggestionNotice({ suggestion }: { suggestion: SuggestionView }) {
  const text =
    suggestion.outcome === "valid"
      ? "The model picked a template and a time, and code checked the pick."
      : suggestion.outcome === "no_fit"
        ? `Model output: no template fits your note, because ${NO_FIT_TEXT[suggestion.noFitReason ?? "time_not_offered"]}. Pick a template yourself below.`
        : suggestion.caseChanged.length > 0
          ? "The case changed during the model call, so its pick no longer fits. Pick a template yourself below."
          : "The model's pick failed the code checks twice. Pick a template yourself below.";
  return (
    <div className="notice">
      <Icon name="info" />
      <div className="stack-sm">
        <p>{text}</p>
        {suggestion.intent && <UntrustedBox label="Your note" text={suggestion.intent} />}
      </div>
    </div>
  );
}
