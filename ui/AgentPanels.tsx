// Agent access in the app (sprint 6): the grant screen, agent proposals in
// the review queue, notes on a slot and the live refresh. Grants are created,
// named and revoked only here or with `pnpm grant`. No MCP tool manages
// them, and no MCP tool confirms a proposal.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { untrustedLabel } from "../src/domain/untrusted.ts";
import { describeChange } from "../src/records/types.ts";
import { UntrustedBox } from "./Untrusted.tsx";
import { api, isNotPaired, versionChanged, type GrantInfo, type LiveVersion, type ProposalView, type RecordView, type Tier } from "./api.ts";

type Run = (action: () => Promise<unknown>) => Promise<void>;

export const POLL_MS = 2000;

export const PROVIDER_NOTICE = "Your agent's model provider may receive the case data it reads.";
export const TOKEN_NOTICE = `Shown once. Anyone with this token can use the access you chose. ${PROVIDER_NOTICE}`;

const TIER_TEXT: Record<Tier, string> = {
  read: "read: list appointments, read one with its evidence and history, list open questions",
  annotate: "annotate: read, plus add notes and set tags",
  propose: "propose: annotate, plus send proposed changes to your review queue",
};

const DENVER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Denver",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

// A stored instant in the case's time zone, America/Denver, with MDT or
// MST, so the hour on either side of the 2026-11-01 change is clear:
// "2026-11-01 01:30 MDT" and, an hour later, "2026-11-01 01:30 MST".
export function denverTime(iso: string): string {
  const parts = Object.fromEntries(DENVER.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

// Text an agent or an imported message wrote, shown as data in a labeled
// box. Never rendered as markup.
export function UntrustedText({ label, text }: { label: string; text: string }) {
  return <UntrustedBox label={untrustedLabel(label)} text={text} />;
}

// Review round 2, B1: until this browser is paired, every /api route
// answers not_paired, and the app shows only this screen. The code is the
// one the app printed in its terminal at start. An agent cannot see it.
export function PairingScreen({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    try {
      await api.pair(code);
      setCode("");
      onPaired();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <form className="card token" onSubmit={(e) => void submit(e)}>
      <div className="label">Pair this browser with the app</div>
      <p>
        Enter the pairing code the app printed in its terminal when it started. The browser stays paired until the app
        restarts. An agent cannot see that terminal.
      </p>
      {message && (
        <p className="error" role="alert">
          {message}
        </p>
      )}
      <label>
        Pairing code <input name="pairing-code" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={20} autoComplete="off" />
      </label>
      <button type="submit">Pair</button>
    </form>
  );
}

// G-d: while the tab is visible, asks every POLL_MS whether anything changed
// and reloads the case view when it did. One request at a time.
export function useLiveRefresh(current: LiveVersion | null, refresh: () => Promise<void>): void {
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== "visible" || latest.current === null) return;
      busy = true;
      try {
        const now = await api.liveVersion();
        if (latest.current && versionChanged(now, latest.current)) await refresh();
      } catch (e) {
        // After a restart the session is gone. The reload shows the pairing
        // screen. Any other failure is tried again at the next poll.
        if (isNotPaired(e)) await refresh();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void check(), POLL_MS);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
}

// G-e: one change an agent proposed. The change is in plain words built by
// code. The agent's statement and any place or item it wrote are untrusted
// text. Only the user confirms, here.
export function ProposalCard({ proposal, records, run }: { proposal: ProposalView; records: RecordView[]; run: Run }) {
  const c = proposal.change;
  const target = c.kind === "archive" || c.kind === "detail_edit" ? c.appointment_id : null;
  const recordVersion = target === null ? undefined : (records.find((r) => r.id === target)?.version ?? 0);
  const place = "location" in c ? c.location : null;
  const item = "request_item" in c ? c.request_item : null;
  return (
    <div className="card agent">
      <div className="label">
        Proposed by {proposal.grantName} · {proposal.id} · <span className="nowrap">{denverTime(proposal.proposedAt)}</span> · {proposal.status}
      </div>
      <p>
        <strong>{describeChange(c)}</strong>
      </p>
      <UntrustedText label={`What ${proposal.grantName} says you told it`} text={c.statement} />
      {place !== null && <UntrustedText label={`Place written by ${proposal.grantName}`} text={place} />}
      {item !== null && <UntrustedText label={`Item or task written by ${proposal.grantName}`} text={item} />}
      {proposal.status === "pending" && (
        <>
          <p>
            Nothing changes until you confirm.
            {c.kind !== "archive" && ` Confirming records this as reported by you through ${proposal.grantName}.`}
          </p>
          <button onClick={() => run(() => api.confirmProposal(proposal.id, proposal.version, recordVersion))}>Confirm</button>
          <button onClick={() => run(() => api.rejectProposal(proposal.id, proposal.version))}>Reject</button>
        </>
      )}
      {proposal.decidedAt && <div>Decided {denverTime(proposal.decidedAt)}</div>}
    </div>
  );
}

// The notes and tags on one appointment. A note an agent wrote is
// untrusted text.
export function RecordNotes({ record }: { record: RecordView | undefined }) {
  if (!record || (record.notes.length === 0 && record.tags.length === 0)) return <span>none</span>;
  return (
    <>
      {record.tags.length > 0 && <div>Tags: {record.tags.join(", ")}</div>}
      {record.notes.map((n) =>
        n.by.kind === "agent" ? (
          <UntrustedText key={n.id} label={`Note by ${n.by.grant_name}, ${denverTime(n.at)}`} text={n.text} />
        ) : (
          <div key={n.id} className="quote">
            Note by you, {denverTime(n.at)}: {n.text}
          </div>
        ),
      )}
    </>
  );
}

// SP6.1 and G-a: create, list and revoke grants.
export function GrantPanel({ grants, run }: { grants: GrantInfo[]; run: Run }) {
  const [name, setName] = useState("");
  const [tier, setTier] = useState<Tier>("read");
  // The new token, held only in this component until the user closes it.
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const result = await api.createGrant(name, tier);
      setCreated({ name: result.grant.name, token: result.token });
      setCopied(false);
      setName("");
    });
  };

  return (
    <>
      <p>
        A grant lets an agent you use reach this case through the MCP server. Nothing is shared until you create one. Pick
        the lowest tier that does the job. An agent can never confirm, cancel or change a slot, contact the office, send a
        reply, delete the case or manage grants. {PROVIDER_NOTICE} Grants are app settings and stay after Delete case.
      </p>
      {created && (
        <div className="card token" role="status">
          <div className="label">New token for {created.name}</div>
          <p className="warn">{TOKEN_NOTICE}</p>
          <code className="secret">{created.token}</code>
          <div>
            <button
              onClick={() =>
                void navigator.clipboard.writeText(created.token).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              Copy token
            </button>
            {copied && <span> Copied.</span>}
            <button onClick={() => setCreated(null)}>I saved it. Hide the token</button>
          </div>
        </div>
      )}
      <form onSubmit={submit} className="card">
        <div className="label">Create a grant</div>
        <label>
          Name <input name="grant-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} maxLength={60} aria-label="Grant name" />
        </label>
        <label>
          Tier{" "}
          <select name="grant-tier" value={tier} onChange={(e) => setTier(e.target.value as Tier)} aria-label="Grant tier">
            {(Object.keys(TIER_TEXT) as Tier[]).map((t) => (
              <option key={t} value={t}>
                {TIER_TEXT[t]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Create grant</button>
      </form>
      {grants.length === 0 ? (
        <p>No grants.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Tier</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id}>
                <td>{g.name}</td>
                <td>{g.tier}</td>
                <td className="nowrap">{denverTime(g.createdAt)}</td>
                <td className="nowrap">{g.lastUsedAt ? denverTime(g.lastUsedAt) : "not in this case"}</td>
                <td>{g.status === "active" ? "active" : `revoked ${g.revokedAt ? denverTime(g.revokedAt) : ""}`}</td>
                <td>
                  {g.status === "active" &&
                    (revoking === g.id ? (
                      <>
                        <span className="warn">Revoke {g.name}? Its next call fails. </span>
                        <button onClick={() => run(async () => {
                          await api.revokeGrant(g.id, g.version);
                          setRevoking(null);
                        })}>
                          Yes, revoke
                        </button>
                        <button onClick={() => setRevoking(null)}>Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => setRevoking(g.id)}>Revoke</button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
