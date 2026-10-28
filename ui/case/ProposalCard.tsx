// One change an agent proposed through its grant. The change is in plain
// words built by code. The agent's statement and any place or item it wrote
// are untrusted text. Only the user confirms or rejects, here. No MCP tool
// does.
import { describeChange } from "../../src/records/types.ts";
import { api, type ProposalView, type RecordView } from "../api.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { denverTime } from "../format.ts";
import { UntrustedText } from "./Source.tsx";

const STATUS_WORDS: Record<ProposalView["status"], string> = { pending: "Waiting for you", confirmed: "Confirmed", rejected: "Rejected" };

export function ProposalCard({ proposal, records, run }: { proposal: ProposalView; records: RecordView[]; run: Run }) {
  const c = proposal.change;
  const target = c.kind === "archive" || c.kind === "detail_edit" ? c.appointment_id : null;
  const recordVersion = target === null ? undefined : (records.find((r) => r.id === target)?.version ?? 0);
  const place = "location" in c ? c.location : null;
  const item = "request_item" in c ? c.request_item : null;
  return (
    <section className="card" aria-label={`Change proposed by ${proposal.grantName}`}>
      <div className="card-head">
        <div className="card-title">
          <Icon name="robot" /> Proposed by {proposal.grantName}
        </div>
        <span className={`claim-status ${proposal.status === "confirmed" ? "accepted" : proposal.status}`}>{STATUS_WORDS[proposal.status]}</span>
      </div>
      <p className="small muted">
        {proposal.id} · {denverTime(proposal.proposedAt)}
      </p>
      <p>
        <strong>{describeChange(c)}</strong>
      </p>
      <UntrustedText label={`What ${proposal.grantName} says you told it`} text={c.statement} />
      {place !== null && <UntrustedText label={`Place written by ${proposal.grantName}`} text={place} />}
      {item !== null && <UntrustedText label={`Item or task written by ${proposal.grantName}`} text={item} />}
      {proposal.status === "pending" && (
        <>
          <p className="small">
            Nothing changes until you confirm.
            {c.kind !== "archive" && ` Confirming records this as reported by you through ${proposal.grantName}.`}
          </p>
          <div className="btn-row">
            <ActionButton run={run} variant="primary" action={() => api.confirmProposal(proposal.id, proposal.version, recordVersion)}>
              Confirm
            </ActionButton>
            <ActionButton run={run} action={() => api.rejectProposal(proposal.id, proposal.version)}>
              Reject
            </ActionButton>
          </div>
        </>
      )}
      {proposal.decidedAt && <p className="small muted">Decided {denverTime(proposal.decidedAt)}</p>}
    </section>
  );
}
