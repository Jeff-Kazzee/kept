// The question card and the explanation card. Both render the conflict
// from the live case view. Choices are built by code. A model's question or
// explanation passed the code checks and is labeled as model output.
import { useEffect, useState } from "react";
import type { ConflictKind } from "../../src/slots/types.ts";
import { api, type AppState } from "../api.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { denverShort } from "../format.ts";
import { ReplyCard } from "./ReplyCard.tsx";
import { SourceQuote } from "./Source.tsx";

export const KIND_TITLES: Record<ConflictKind, string> = {
  both_held: "Two times are held",
  change_proposed: "The office proposed a change",
  unknown_order: "The order of messages is unknown",
  ambiguous_date: "A date or time is unclear",
  possibly_stale: "A reminder may be out of date",
  location_mismatch: "Places disagree",
  incomplete_slot: "A detail is missing",
};

function Sources({ ids, state, open = false }: { ids: string[]; state: AppState; open?: boolean }) {
  if (ids.length === 0) return null;
  return (
    <details className="stack-sm" open={open || undefined}>
      <summary className="small">
        {ids.length} source{ids.length === 1 ? "" : "s"}
      </summary>
      <div className="stack-sm">
        {ids.map((id) => (
          <SourceQuote key={id} id={id} state={state} />
        ))}
      </div>
    </details>
  );
}

// `showDraft` false leaves out the reply draft the answer opened, for a
// place that already shows the draft (the Schedule tab).
export function QuestionCard({ conflictId, state, run, showDraft = true }: { conflictId: string; state: AppState; run: Run; showDraft?: boolean }) {
  const kase = state.case;
  const conflict = kase.conflicts.find((c) => c.id === conflictId);
  const q = kase.question?.conflictId === conflictId ? kase.question : null;
  const questionId = q?.id ?? conflict?.answer?.questionId ?? null;
  // The reply draft this question's answer opened. Kept after approval, so
  // the card can show the simulated send.
  const openDraft = kase.reply.draft && questionId !== null && kase.reply.draft.questionId === questionId ? kase.reply.draft.id : null;
  const [draftId, setDraftId] = useState<string | null>(openDraft);
  useEffect(() => {
    if (openDraft) setDraftId(openDraft);
  }, [openDraft]);

  if (!conflict) {
    return (
      <div className="card">
        <p className="small muted">This question no longer applies. The case changed since it was asked.</p>
        {showDraft && draftId && <ReplyCard draftId={draftId} state={state} run={run} />}
      </div>
    );
  }
  return (
    <section className="card" aria-label="Question">
      <div className="card-head">
        <div className="card-title">
          <Icon name="question" /> {KIND_TITLES[conflict.kind]}
        </div>
        {q && <span className="model-tag">{q.origin === "model" ? "Model output, checked by code" : "Fixed wording"}</span>}
      </div>
      {conflict.archivedSlotKeys.length > 0 && (
        <p className="warn">Not asked while an appointment in it is archived. Undo the archive in Schedule to answer it.</p>
      )}
      {q ? (
        <>
          <p>
            <strong>{q.text}</strong>
          </p>
          <div className="choices" role="group" aria-label="Your answer">
            {q.choices.map((c) => (
              <ActionButton key={c.id} run={run} action={() => api.answer(q.id, c.id, kase.questionsVersion, kase.reply.version)}>
                {c.label}
              </ActionButton>
            ))}
          </div>
          <p className="small muted">The choices are built by code. Your answer is recorded as reported by you.</p>
          {conflict.kind === "change_proposed" && <p className="small muted">Choosing a time opens a reply to the office. No appointment changes until you approve the reply.</p>}
          <Sources ids={q.citedEvidenceIds} state={state} />
        </>
      ) : conflict.answer ? (
        <p className="small">
          <Icon name="check" size="sm" /> You answered “{conflict.answer.label}” on {denverShort(conflict.answer.answeredAt)}.
        </p>
      ) : (
        <>
          <p>{conflict.summary}</p>
          {kase.question === null && kase.waiting > 0 && conflict.archivedSlotKeys.length === 0 && (
            <div className="btn-row">
              <ActionButton run={run} action={() => api.nextQuestion(kase.questionsVersion)}>
                Ask the next question
              </ActionButton>
            </div>
          )}
          <Sources ids={conflict.evidenceIds} state={state} />
        </>
      )}
      {showDraft && draftId && <ReplyCard draftId={draftId} state={state} run={run} />}
    </section>
  );
}

export function ExplanationCard({ conflictId, state, run }: { conflictId: string; state: AppState; run: Run }) {
  const conflict = state.case.conflicts.find((c) => c.id === conflictId);
  if (!conflict) {
    return (
      <div className="card">
        <p className="small muted">This conflict is settled. The case changed since it was explained.</p>
      </div>
    );
  }
  const x = conflict.explanation;
  return (
    <section className="card" aria-label="Explanation">
      <div className="card-head">
        <div className="card-title">
          <Icon name="info" /> {KIND_TITLES[conflict.kind]}
        </div>
        {x?.outcome === "valid" && <span className="model-tag">Model output, checked by code</span>}
      </div>
      {x?.outcome === "valid" ? (
        <>
          <p className="assistant-text">{x.text}</p>
          <p className="small muted">Every source it cites is shown below. Read them before you decide.</p>
          <Sources ids={x.citedEvidenceIds} state={state} open />
        </>
      ) : x?.outcome === "unavailable" ? (
        <>
          <p className="warn-box">The model's explanation failed the code checks twice. The sources are shown without it.</p>
          <p>{conflict.summary}</p>
          <Sources ids={conflict.evidenceIds} state={state} open />
        </>
      ) : (
        <>
          <p>{conflict.summary}</p>
          <div className="btn-row">
            <ActionButton run={run} action={() => api.explain(conflict.id, conflict.version)}>
              <Icon name="sparkle" size="sm" /> Explain with the model
            </ActionButton>
          </div>
          <Sources ids={conflict.evidenceIds} state={state} open />
        </>
      )}
    </section>
  );
}
