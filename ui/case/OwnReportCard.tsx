// "Record this as your own report?" (0009, D1'). The assistant asks when a
// message reads as something that happened to the person, such as a phone
// call. Only the person answers. Until then the assistant cannot accept or
// reject the message's facts, so the card stays in the thread and in
// "Waiting for you". Yes makes the message and its facts the person's own
// report, logged with Undo. No keeps it as a message, also with Undo.
// A Yes on clinical text is refused with the fixed scope decline.
import { useState } from "react";
import { OWN_REPORT_QUESTION } from "../../src/agent/types.ts";
import { SCOPE_DECLINE } from "../../src/domain/scope.ts";
import { entryFor, useAgent } from "../agent/AgentContext.tsx";
import { Receipt } from "../agent/Receipts.tsx";
import { senderShown } from "./Source.tsx";
import { ApiError, api, type AppState } from "../api.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { UntrustedInline } from "../components/Untrusted.tsx";

export const OWN_REPORT_YES = "Recorded as your own report";
export const OWN_REPORT_NO = "Not recorded as your own report";

// The start of the message, so two open questions can be told apart.
export const excerpt = (text: string, max = 90) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
};

// The messages whose question waits for the person.
export const openOwnReports = (state: Pick<AppState, "messages">) => state.messages.filter((m) => m.ownReport === "offered");

export function OwnReportCard({ messageId, state, run }: { messageId: string; state: AppState; run: Run }) {
  const { activity } = useAgent();
  const [declined, setDeclined] = useState(false);
  const m = state.messages.find((x) => x.id === messageId);
  if (!m) {
    return (
      <div className="card card-quiet">
        <p className="small muted">This message is no longer in the case.</p>
      </div>
    );
  }
  const entry = activity?.entries.find((e) => e.kind === "own_report_recorded" && e.target?.type === "message" && e.target.id === m.id && !e.undone) ?? entryFor(activity, "message", m.id);
  const answer = (choice: "yes" | "no") => async () => {
    try {
      await api.ownReport(m.id, choice, m.version);
    } catch (e) {
      // Yes on clinical text: the fixed decline, not an error toast.
      if (e instanceof ApiError && e.body.error === "out_of_scope") {
        setDeclined(true);
        return;
      }
      throw e;
    }
  };
  if (m.ownReport === "yes" || m.ownReport === "no") {
    return (
      <div className="card own-report is-answered" aria-label={OWN_REPORT_QUESTION}>
        <Receipt quiet text={m.ownReport === "yes" ? OWN_REPORT_YES : OWN_REPORT_NO} entries={entry && entry.kind === "own_report_recorded" ? [entry] : []} />
      </div>
    );
  }
  if (m.ownReport !== "offered") return null;
  return (
    <section className="card own-report" aria-label={OWN_REPORT_QUESTION}>
      <div className="own-report-line">
        <span className="claims-icon" aria-hidden="true">
          <Icon name="user" size="sm" />
        </span>
        <div className="stack-xs own-report-text">
          <strong>{OWN_REPORT_QUESTION}</strong>
          <span className="small muted">
            {senderShown(m, state)}: <UntrustedInline label="Message text, shown as data" text={excerpt(m.message.text)} />
          </span>
          <span className="small muted">Yes counts its facts as your own words.</span>
        </div>
        <div className="claim-actions">
          <ActionButton run={run} variant="primary" size="sm" action={answer("yes")} label={`Yes, record the message from ${senderShown(m, state)} as your own report`}>
            Yes
          </ActionButton>
          <ActionButton run={run} variant="ghost" size="sm" action={answer("no")} label={`No, keep the message from ${senderShown(m, state)} as a message`}>
            No
          </ActionButton>
        </div>
      </div>
      {declined && (
        <div className="declined" role="note">
          <Icon name="shield" />
          <div className="stack-sm">
            <strong className="small">Outside this app's scope</strong>
            <p>{SCOPE_DECLINE}</p>
          </div>
        </div>
      )}
    </section>
  );
}
