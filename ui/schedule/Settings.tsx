// Settings: the time zone, the model provider and sign-in, the theme, what
// the app is, and Delete case. Each write sends the settings version it
// was shown at. A key goes to the server once and is never shown again.
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { DELETE_CONFIRMATION } from "../../src/case/constants.ts";
import { safeAuthorizeUrl } from "../agentApi.ts";
import { googleOrOff, useAgent } from "../agent/AgentContext.tsx";
import { ModelSelect } from "../agent/ModelPicker.tsx";
import { api } from "../api.ts";
import { deviceZone, knownZones, validZone, type Provider, type Settings } from "../contract.ts";
import { zoneWithShortName } from "../format.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { readTheme, saveTheme, type ThemeChoice } from "../theme.ts";

const THEMES: Array<{ value: ThemeChoice; label: string; icon: IconName }> = [
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "system", label: "System", icon: "monitor" },
];

export function ThemeSetting() {
  const [choice, setChoice] = useState<ThemeChoice>(() => (typeof localStorage === "undefined" ? "dark" : readTheme()));
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
  const { settings, settingsAvailable } = useAgent();
  return (
    <div className="stack settings">
      <section className="card stack-sm" aria-labelledby="set-zone">
        <h3 id="set-zone">Time zone</h3>
        <TimeZoneSetting run={run} />
      </section>
      <section className="card stack-sm" aria-labelledby="set-model">
        <h3 id="set-model">Model provider</h3>
        {settingsAvailable && settings.providersInBuild ? (
          <>
            <ProviderSetting settings={settings} run={run} />
            <ModelSelect />
          </>
        ) : (
          <p className="small muted">
            Choosing a provider is not available in this build yet. The assistant uses {mode === "live" ? "the live model" : "recorded responses"} ({modelClient}).
          </p>
        )}
      </section>
      <section className="card stack-sm" aria-labelledby="set-google">
        <h3 id="set-google">
          <Icon name="google" size="sm" /> Google
        </h3>
        <GoogleSetting run={run} />
      </section>
      <section className="card">
        <ThemeSetting />
      </section>
      <section className="card stack-sm">
        <h3>About this app</h3>
        <p className="small">
          Administrative facts only: times, places, confirmations and what the office asked you to bring or do. It reads your email only when you connect Google, and then only to
          search for appointment messages. Sending a reply is simulated. All data here is synthetic.
        </p>
        <p className="small muted">Appointments are built by code from the accepted facts. Model text never changes an appointment. A clash check assumes a length for each appointment, because messages do not state an end time. The info button beside Appointments shows it.</p>
      </section>
      <DeleteCasePanel version={version} erasePending={erasePending} run={run} />
    </div>
  );
}

const SOURCE_WORDS: Record<Settings["timezoneSource"], string> = {
  you: "Set by you",
  agent: "Set by the assistant",
  browser: "From this device",
  default: "The app's default",
};

// The case time zone: a searchable list of every zone this browser knows,
// and "Use this device's zone". Every time the app shows uses it.
export function TimeZoneSetting({ run }: { run: Run }) {
  const { settings, settingsAvailable, backend, reload } = useAgent();
  const uid = useId();
  const zones = useMemo(knownZones, []);
  const [typed, setTyped] = useState("");
  const device = useMemo(deviceZone, []);
  const choice = typed.trim();
  const ok = validZone(choice) && choice !== settings.timezone;
  const save = (zone: string) =>
    run(async () => {
      await backend.setTimezone(zone, settings.settingsVersion, "you");
      setTyped("");
      await reload();
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ok) void save(choice);
  };
  return (
    <div className="stack-sm">
      <p className="zone-now">
        <strong>{zoneWithShortName(settings.timezone)}</strong>
        <span className="small muted"> · {SOURCE_WORDS[settings.timezoneSource]}</span>
      </p>
      <p className="small muted">Every time in the app uses this zone: the schedule, calendar clashes, the chat and the time a message was received. You or the assistant can change it.</p>
      {settingsAvailable ? (
        <form className="stack-sm" onSubmit={submit}>
          <label className="field" htmlFor={`${uid}-zone`}>
            <span>Find a time zone</span>
            <input
              id={`${uid}-zone`}
              name="timezone"
              className="input"
              list={`${uid}-zones`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="For example, Europe/Berlin"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <datalist id={`${uid}-zones`}>
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          {choice !== "" && !validZone(choice) && <p className="small warn">Pick a zone name from the list, such as America/Denver.</p>}
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={!ok}>
              Use this zone
            </button>
            {device && device !== settings.timezone && (
              <ActionButton run={run} variant="ghost" action={() => save(device)}>
                <Icon name="globe" size="sm" /> Use this device's zone ({device})
              </ActionButton>
            )}
          </div>
        </form>
      ) : (
        <p className="small muted">Changing the zone is not available in this build yet.</p>
      )}
    </div>
  );
}

type ProviderOption = {
  id: Provider;
  // The first option is the main path. The others are listed under their
  // own "Or ..." line, so a third provider fits without a redesign.
  title: string;
  altLine?: string;
  receives: string;
  ready: (s: Settings) => boolean;
  Body: (props: { settings: Settings; run: Run }) => ReactNode;
};

export const PROVIDERS: ProviderOption[] = [
  {
    id: "meta",
    title: "Meta Model API",
    receives: "Meta receives what the assistant reads to answer you: the messages you paste, your schedule and your notes. Your key stays on the server.",
    ready: (s) => s.meta.keySet,
    Body: MetaKeyBody,
  },
  {
    id: "chatgpt",
    title: "ChatGPT",
    altLine: "Or use your ChatGPT plan",
    receives: "OpenAI receives the same case text through your ChatGPT account, and the use counts toward your plan.",
    ready: (s) => s.chatgpt.signedIn,
    Body: ChatGptBody,
  },
];

// The provider the assistant uses. Meta is the default and the main path.
export function ProviderSetting({ settings, run }: { settings: Settings; run: Run }) {
  const { backend, reload } = useAgent();
  const uid = useId();
  const current = settings.provider;
  const pick = (id: Provider) =>
    run(async () => {
      await backend.setProvider(id, settings.settingsVersion);
      await reload();
    });
  return (
    <div className="providers" role="radiogroup" aria-label="Provider the assistant uses">
      {PROVIDERS.map((p, i) => {
        const ready = p.ready(settings);
        const id = `${uid}-${p.id}`;
        return (
          <div key={p.id} className="stack-sm">
            {i > 0 && p.altLine && <p className="provider-alt">{p.altLine}</p>}
            <section className={`provider${current === p.id ? " is-current" : ""}${i === 0 ? " is-main" : ""}`} aria-labelledby={`${id}-title`}>
              <div className="provider-head">
                <label className="check" htmlFor={id}>
                  <input id={id} type="radio" name="provider" value={p.id} checked={current === p.id} disabled={!ready} onChange={() => void pick(p.id)} />
                  <span id={`${id}-title`} className="provider-title">
                    <span className="nowrap">{p.title}</span>
                    {i === 0 && <span className="model-tag">Default</span>}
                  </span>
                </label>
                {current === p.id && <span className="pill pill-accepted">In use</span>}
              </div>
              <p className="small muted">{p.receives}</p>
              <p.Body settings={settings} run={run} />
              {!ready && <p className="small muted">{p.id === "meta" ? "Add a key to use Meta." : "Sign in to use ChatGPT."}</p>}
            </section>
          </div>
        );
      })}
    </div>
  );
}

function MetaKeyBody({ settings, run }: { settings: Settings; run: Run }) {
  const { backend, reload } = useAgent();
  const uid = useId();
  const [key, setKey] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (k === "") return;
    void run(async () => {
      try {
        await backend.saveMetaKey(k, settings.settingsVersion);
      } finally {
        // The page never keeps the key, saved or not.
        setKey("");
      }
      await reload();
    });
  };
  if (settings.meta.keySet) {
    return (
      <div className="btn-row">
        <span className="small">
          <Icon name="key" size="sm" /> {settings.meta.source === "server" ? "The server has a key from its own settings." : "Your key is saved on the server."}
        </span>
        {settings.meta.source === "you" && (
          <ActionButton
            run={run}
            variant="ghost"
            action={async () => {
              await backend.removeMetaKey(settings.settingsVersion);
              await reload();
            }}
          >
            Remove the key
          </ActionButton>
        )}
      </div>
    );
  }
  return (
    <form className="stack-sm" onSubmit={submit}>
      <label className="field" htmlFor={`${uid}-key`}>
        <span>Meta Model API key</span>
        <input id={`${uid}-key`} name="meta-key" className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <div>
        <button type="submit" className="btn btn-primary" disabled={key.trim() === ""}>
          Save the key
        </button>
      </div>
      <p className="small muted">The key goes to this app's server once. The page does not keep it and never shows it again.</p>
    </form>
  );
}

function ChatGptBody({ settings, run }: { settings: Settings; run: Run }) {
  const { backend, reload } = useAgent();
  const c = settings.chatgpt;
  if (c.signedIn) {
    return (
      <div className="btn-row">
        <span className="small">
          <Icon name="user" size="sm" /> Signed in{c.name ? ` as ${c.name}` : ""}
          {c.email ? ` (${c.email})` : ""}
          {c.planUsage ? ". Uses your plan." : "."}
        </span>
        <ActionButton
          run={run}
          variant="ghost"
          action={async () => {
            await backend.chatgptSignOut(settings.settingsVersion);
            await reload();
          }}
        >
          Sign out
        </ActionButton>
      </div>
    );
  }
  return (
    <div>
      <ActionButton
        run={run}
        action={async () => {
          const { authorizeUrl } = await backend.chatgptStart();
          const url = safeAuthorizeUrl(authorizeUrl, window.location.origin);
          if (!url) throw new Error("The sign-in address was not one this app opens.");
          window.location.assign(url);
        }}
      >
        Sign in with ChatGPT
      </ActionButton>
    </div>
  );
}


// Google: Gmail, read-only, to search for appointment emails, and Google
// Calendar, for clashes and the appointments the assistant adds. Every
// event the assistant adds is an action with Undo.
export function GoogleSetting({ run }: { run: Run }) {
  const { backend, google, reload } = useAgent();
  if (google === null) return <p className="small muted">Connecting Google is not available in this build yet.</p>;
  const g = googleOrOff(google);
  const grants: Array<{ on: boolean; label: string }> = [
    { on: g.gmail, label: "Gmail, read-only: search for messages about appointments" },
    { on: g.calendar, label: `Google Calendar: read events for clashes, and add, update or remove your appointments${g.calendarId ? ` (calendar ${g.calendarId})` : ""}` },
  ];
  if (!g.connected) {
    return (
      <div className="stack-sm">
        <p className="small muted">Connect Google so the assistant can find appointment emails in Gmail and keep your appointments on Google Calendar. Google receives what the assistant adds to your calendar.</p>
        <div>
          <ActionButton
            run={run}
            action={async () => {
              const { authorizeUrl } = await backend.googleConnect();
              const url = safeAuthorizeUrl(authorizeUrl, window.location.origin);
              if (!url) throw new Error("The sign-in address was not one this app opens.");
              window.location.assign(url);
            }}
          >
            <Icon name="google" size="sm" /> Connect Google
          </ActionButton>
        </div>
      </div>
    );
  }
  return (
    <div className="stack-sm">
      <p className="small">
        <Icon name="user" size="sm" /> Connected as {g.email ?? "a Google account"}
      </p>
      <ul className="grants" aria-label="Permissions granted">
        {grants.map((x) => (
          <li key={x.label} className={x.on ? "is-on" : "is-off"}>
            <Icon name={x.on ? "check" : "close"} size="sm" />
            <span>
              {x.label}
              <span className="sr-only">{x.on ? ": granted" : ": not granted"}</span>
            </span>
          </li>
        ))}
      </ul>
      <div>
        <ActionButton
          run={run}
          variant="ghost"
          action={async () => {
            await backend.googleDisconnect(g.version);
            await reload();
          }}
        >
          Disconnect
        </ActionButton>
      </div>
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
        Delete case erases every message, claim, review, slot, question, explanation, reply, note and tag of this case, the chat, its activity and the log of agent calls. It also clears them
        from the database file. This cannot be undone.
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
