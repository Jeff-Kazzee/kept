// The hosted site's parts of the sidebar pages (0014, design item 6, and
// 0015): the provider choice as usage credits or ChatGPT (not here yet) in
// Connections, the Usage page with the balance, each recent charge and the
// plans, and Delete account in Settings.
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { DELETE_CONFIRMATION } from "../../src/case/constants.ts";
import { useAgent } from "../agent/AgentContext.tsx";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { errorSentence } from "../format.ts";
import { forgetJudgeSigninKey, hostedApi, usageTime, type UsageView } from "./session.ts";

export function HostedProviderSetting() {
  const { settings } = useAgent();
  const chosen = settings.models.find((m) => m.id === settings.model);
  return (
    <div className="providers" role="radiogroup" aria-label="Provider the assistant uses">
      <section className="provider is-current is-main" aria-labelledby="hp-credits">
        <div className="provider-head">
          <label className="check" htmlFor="hp-credits-radio">
            <input id="hp-credits-radio" type="radio" name="provider" value="meta" checked readOnly />
            <span id="hp-credits" className="provider-title">
              <span className="nowrap">Usage credits (Meta models)</span>
            </span>
          </label>
          <span className="pill pill-accepted">In use</span>
        </div>
        <p className="small muted">
          The assistant uses Meta's Muse models on this site's key, paid from your usage credit. Meta receives what the assistant reads to answer you: the messages you paste, your schedule and your notes.
          {chosen?.turnCost ? ` ${chosen.label} costs ${chosen.turnCost} at your price.` : ""}
        </p>
      </section>
      <section className="provider is-off" aria-labelledby="hp-chatgpt">
        <div className="provider-head">
          <label className="check" htmlFor="hp-chatgpt-radio">
            <input id="hp-chatgpt-radio" type="radio" name="provider" value="chatgpt" checked={false} disabled readOnly />
            <span id="hp-chatgpt" className="provider-title">
              <span>Sign in with ChatGPT (not available on the hosted site yet)</span>
            </span>
          </label>
        </div>
        <p className="small muted">OpenAI allows Sign in with ChatGPT only for apps that run on your own computer for now. It works when you run this app locally.</p>
      </section>
    </div>
  );
}

export function UsageSection({ run }: { run: Run }) {
  const { reload, report, notify } = useAgent();
  const uid = useId();
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const load = useCallback(async () => {
    try {
      setUsage(await hostedApi.usage());
      setFailed(null);
    } catch (e) {
      setFailed(errorSentence(e).replace(/ Nothing was saved\.$/, ""));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const addCode = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (c === "") return;
    void run(async () => {
      try {
        const next = await hostedApi.addJudgeCode(c);
        setUsage(next);
        notify(`Added the judge code's credit. Your balance is ${next.balance}.`);
      } catch (err) {
        report(err);
      } finally {
        setCode("");
      }
      await reload();
    });
  };

  return (
    <section id="set-usage" className="card stack-sm" aria-labelledby="set-usage-title">
      <h2 id="set-usage-title">Balance and charges</h2>
      {failed && (
        <p className="warn" role="status">
          <Icon name="alert" size="sm" /> {failed}
        </p>
      )}
      {usage && (
        <>
          <p className="usage-balance">
            <span className="small muted">Balance</span>
            <strong>{usage.balance}</strong>
          </p>
          <p className="small muted">Each model call on this site is charged at {usage.markup} times the model's token cost, from what Meta reports it used. The assistant holds the most a step can cost before it runs, and gives back what it did not use.</p>
          <h3 className="field-label">Recent charges</h3>
          {usage.charges.length === 0 ? (
            <p className="small muted">No charges yet.</p>
          ) : (
            <div className="usage-table-wrap">
              <table className="usage-table">
                <caption className="sr-only">Recent charges, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">What</th>
                    <th scope="col">Model</th>
                    <th scope="col" className="num">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {usage.charges.map((c, i) => (
                    <tr key={`${c.at}-${i}`}>
                      <td>{usageTime(c.at)}</td>
                      <td>
                        {c.what}
                        {c.calls > 1 && <span className="small muted"> · {c.calls} calls</span>}
                      </td>
                      <td>{c.modelLabel}</td>
                      <td className="num">{c.cost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3 className="field-label">Get more credit</h3>
          <div className="btn-row">
            {usage.plans.map((p) => (
              <button key={p.id} type="button" className="btn" disabled={!p.available} aria-describedby={`${uid}-soon`}>
                {p.label}
              </button>
            ))}
          </div>
          <p id={`${uid}-soon`} className="small muted">
            Plans are coming soon.
          </p>
          {usage.canAddCode && (
            <form className="stack-sm" onSubmit={addCode}>
              <label className="field" htmlFor={`${uid}-code`}>
                <span>Add a judge code to this account</span>
                <input id={`${uid}-code`} name="judge-code" className="input" type="password" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
              </label>
              <div>
                <button type="submit" className="btn" disabled={code.trim() === ""}>
                  Add the code
                </button>
              </div>
            </form>
          )}
          <details className="small">
            <summary>Rough cost of a chat turn</summary>
            <ul className="usage-models">
              {usage.models.map((m) => (
                <li key={m.id}>
                  {m.label}: {m.turnCost ?? "no price set"}
                </li>
              ))}
            </ul>
            <p className="muted">A turn that reads the case, runs one step and answers. Long pastes cost more.</p>
          </details>
        </>
      )}
    </section>
  );
}

// Delete account: the workspace and every session go. The ledger keeps
// its rows for accounting, without the email.
export function DeleteAccountPanel({ run, onDeleted }: { run: Run; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <section className="card danger-zone stack-sm">
      <h2>
        <Icon name="trash" size="sm" /> Delete account
      </h2>
      <p className="small">Delete account erases your case, its chat and activity, your settings, your password and passkeys, and your Google connection on this site, and signs you out everywhere. The record of what you were charged stays, without your email. This cannot be undone.</p>
      <label className="field" htmlFor="delete-account-confirm">
        <span>Type {DELETE_CONFIRMATION} to confirm</span>
        <input id="delete-account-confirm" name="delete-account-confirm" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
      </label>
      <div>
        <ActionButton
          run={run}
          variant="danger"
          disabled={typed !== DELETE_CONFIRMATION}
          action={async () => {
            await hostedApi.deleteAccount(typed);
            forgetJudgeSigninKey();
            setTyped("");
            onDeleted();
          }}
        >
          Delete my account and all its data permanently
        </ActionButton>
      </div>
    </section>
  );
}
