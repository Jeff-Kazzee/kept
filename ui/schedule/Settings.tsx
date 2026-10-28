// Settings: the theme, what the app is, and Delete case.
import { useState } from "react";
import { DELETE_CONFIRMATION } from "../../src/case/constants.ts";
import { api } from "../api.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { readTheme, saveTheme, type ThemeChoice } from "../theme.ts";

const THEMES: Array<{ value: ThemeChoice; label: string; icon: IconName }> = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

export function ThemeSetting() {
  const [choice, setChoice] = useState<ThemeChoice>(() => (typeof localStorage === "undefined" ? "system" : readTheme()));
  return (
    <fieldset className="stack-sm">
      <legend className="field-label">Theme</legend>
      <div className="segmented">
        {THEMES.map((t) => (
          <label key={t.value} htmlFor={`theme-${t.value}`}>
            <input
              id={`theme-${t.value}`}
              type="radio"
              name="theme"
              value={t.value}
              checked={choice === t.value}
              onChange={() => {
                setChoice(t.value);
                saveTheme(t.value);
              }}
            />
            <Icon name={t.icon} size="sm" /> {t.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SettingsPanel({ mode, modelClient, version, erasePending, run }: { mode: "recorded" | "live"; modelClient: string; version: number; erasePending: boolean; run: Run }) {
  return (
    <div className="stack">
      <section className="card">
        <ThemeSetting />
      </section>
      <section className="card stack-sm">
        <h3>About this app</h3>
        <p className="small">
          Administrative facts only: times, places, confirmations and what the office asked you to bring or do. It has no access to your inbox. Sending a reply is simulated. All data here is
          synthetic.
        </p>
        <p className="small muted">
          Model: {mode === "live" ? "live model" : "recorded responses"} ({modelClient}). Times are shown in America/Denver.
        </p>
      </section>
      <DeleteCasePanel version={version} erasePending={erasePending} run={run} />
    </div>
  );
}

// Delete case. The only permanent deletion, with its own typed
// confirmation. No agent can reach it.
export function DeleteCasePanel({ version, erasePending = false, run }: { version: number; erasePending?: boolean; run: Run }) {
  const [typed, setTyped] = useState("");
  return (
    <section className="card danger-zone">
      <h3>
        <Icon name="trash" size="sm" /> Delete case
      </h3>
      {erasePending && (
        <p className="warn-box" role="alert">
          A deleted case is not cleared from the database file yet, because another program kept the file busy. Close the MCP client or other programs that use it, then run Delete case again.
        </p>
      )}
      <p className="small">
        Delete case erases every message, claim, review, slot, question, explanation, reply, note, tag and proposal of this case, the chat, and the log of agent calls. It also clears them from the
        database file. Grants stay, because they are app settings. Revoke a grant separately. This cannot be undone.
      </p>
      <label className="field" htmlFor="delete-confirm">
        <span>Type {DELETE_CONFIRMATION} to confirm</span>
        <input id="delete-confirm" name="delete-confirm" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
      </label>
      <div>
        <ActionButton
          run={run}
          variant="danger"
          disabled={typed !== DELETE_CONFIRMATION}
          action={async () => {
            await api.deleteCase(version, typed);
            setTyped("");
          }}
        >
          Delete this case and all its data permanently. This cannot be undone.
        </ActionButton>
      </div>
    </section>
  );
}
