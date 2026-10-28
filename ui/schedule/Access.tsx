// Agent access (MCP): create, list and revoke grants. Grants are created,
// named and revoked only here or with `pnpm grant`. No MCP tool manages
// them. A new token is shown once and held only in this component until the
// user hides it.
import { useState, type FormEvent } from "react";
import { api, type GrantInfo, type Tier } from "../api.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { denverTime } from "../format.ts";

export const PROVIDER_NOTICE = "Your agent's model provider may receive the case data it reads.";
export const TOKEN_NOTICE = `Shown once. Anyone with this token can use the access you chose. ${PROVIDER_NOTICE}`;

const TIER_TEXT: Record<Tier, string> = {
  read: "List appointments, read one with its evidence and history, list open questions.",
  annotate: "Everything in read, plus add notes and set tags.",
  propose: "Everything in annotate, plus send proposed changes to your review queue.",
};

export function GrantPanel({ grants, run }: { grants: GrantInfo[]; run: Run }) {
  const [name, setName] = useState("");
  const [tier, setTier] = useState<Tier>("read");
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
    <div className="stack">
      <p className="small">
        A grant lets an agent you use reach this case through the MCP server. Nothing is shared until you create one. Pick the lowest tier that does the job. An agent can never confirm, cancel or
        change a slot, contact the office, send a reply, delete the case or manage grants. {PROVIDER_NOTICE} Grants are app settings and stay after Delete case.
      </p>
      {created && (
        <div className="card token-box" role="status">
          <h3>New token for {created.name}</h3>
          <p className="warn">{TOKEN_NOTICE}</p>
          <code className="secret">{created.token}</code>
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              onClick={() =>
                void navigator.clipboard.writeText(created.token).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              <Icon name="copy" size="sm" /> Copy token
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setCreated(null)}>
              I saved it. Hide the token
            </button>
            {copied && <span className="small success">Copied.</span>}
          </div>
        </div>
      )}
      <form onSubmit={submit} className="card">
        <h3>Create a grant</h3>
        <label className="field" htmlFor="grant-name">
          <span>Name</span>
          <input id="grant-name" name="grant-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} maxLength={60} />
        </label>
        <label className="field" htmlFor="grant-tier">
          <span>Tier</span>
          <select id="grant-tier" name="grant-tier" className="select" value={tier} onChange={(e) => setTier(e.target.value as Tier)} aria-describedby="grant-tier-text">
            {(Object.keys(TIER_TEXT) as Tier[]).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <span id="grant-tier-text" className="hint">
            {TIER_TEXT[tier]}
          </span>
        </label>
        <div>
          <button type="submit" className="btn btn-primary">
            Create grant
          </button>
        </div>
      </form>
      <h3>Grants ({grants.length})</h3>
      {grants.length === 0 ? (
        <p className="muted">No grants.</p>
      ) : (
        <ul className="stack-sm">
          {grants.map((g) => (
            <li key={g.id} className="grant">
              <div className="section-head">
                <strong>{g.name}</strong>
                <span className={`claim-status ${g.status === "active" ? "accepted" : "rejected"}`}>{g.status === "active" ? "Active" : "Revoked"}</span>
              </div>
              <dl>
                <dt>Tier</dt>
                <dd>{g.tier}</dd>
                <dt>Created</dt>
                <dd>{denverTime(g.createdAt)}</dd>
                <dt>Last used</dt>
                <dd>{g.lastUsedAt ? denverTime(g.lastUsedAt) : "not in this case"}</dd>
                {g.revokedAt && (
                  <>
                    <dt>Revoked</dt>
                    <dd>{denverTime(g.revokedAt)}</dd>
                  </>
                )}
              </dl>
              {g.status === "active" &&
                (revoking === g.id ? (
                  <div className="warn-box stack-sm">
                    <p>Revoke {g.name}? Its next call fails.</p>
                    <div className="btn-row">
                      <ActionButton
                        run={run}
                        variant="danger"
                        action={async () => {
                          await api.revokeGrant(g.id, g.version);
                          setRevoking(null);
                        }}
                      >
                        Yes, revoke
                      </ActionButton>
                      <button type="button" className="btn" onClick={() => setRevoking(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <button type="button" className="btn" onClick={() => setRevoking(g.id)}>
                      Revoke
                    </button>
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
