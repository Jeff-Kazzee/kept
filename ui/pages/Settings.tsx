// The sidebar's pages for the settings (0015, Z4). Connections: the model
// provider and sign-in, the model, and Google. Settings: the time zone, the
// theme, what the app is, and Delete case. Usage, on the hosted site. Each
// write sends the settings version it was shown at. A key goes to the
// server once and is never shown again.
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { DELETE_CONFIRMATION } from "../../src/case/constants.ts";
import { safeAuthorizeUrl, type GoogleGrants } from "../agentApi.ts";
import { googleOrOff, useAgent } from "../agent/AgentContext.tsx";
import { ModelSelect } from "../agent/ModelPicker.tsx";
import { api } from "../api.ts";
import { deviceZone, knownZones, validZone, type CalendarRead, type Provider, type Settings } from "../contract.ts";
import { clockTime, wallNow, zoneWithShortName } from "../format.ts";
import { dateLabel } from "../../src/slots/labels.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { CASE_DELETED_PENDING_TEXT, CASE_DELETED_SHARED_TEXT, CASE_DELETED_TEXT, ThemeSetting, zoneSourceWords } from "./shared.tsx";
import { DeleteAccountPanel, HostedProviderSetting, UsageSection } from "../hosted/Usage.tsx";

export { CASE_DELETED_PENDING_TEXT, CASE_DELETED_SHARED_TEXT, CASE_DELETED_TEXT, ThemeSetting, ZoneNotice, caseDeletedShown, zoneMismatch, zoneSourceWords } from "./shared.tsx";


// Connections: the model provider and the model, and Google.
export function ConnectionsPage({ modelClient, run }: { modelClient: string; run: Run }) {
  const { settings, settingsAvailable, hosted } = useAgent();
  return (
    <div className="stack settings">
      <section className="card stack-sm" aria-labelledby="set-model">
        <h2 id="set-model">Model provider</h2>
        {settingsAvailable ? (
          <>
            {hosted ? <HostedProviderSetting /> : <ProviderSetting settings={settings} run={run} />}
            <ModelSelect />
          </>
        ) : (
          <p className="small muted">
            The app could not read its model settings, so the provider cannot be chosen here now. The assistant uses {modelClient}.
          </p>
        )}
      </section>
      <section className="card stack-sm" aria-labelledby="set-google">
        <h2 id="set-google">
          <Icon name="google" size="sm" /> Google
        </h2>
        <GoogleSetting run={run} />
      </section>
    </div>
  );
}

// Settings: the time zone, the theme, what the app is, Delete case, and on
// the hosted site Delete account.
export function SettingsPage({
  version,
  erasePending,
  run,
  caseDeleted = false,
  onCaseDeleted,
}: {
  version: number;
  erasePending: boolean;
  run: Run;
  caseDeleted?: boolean;
  onCaseDeleted?: () => void;
}) {
  const { hosted, signedOut, google } = useAgent();
  return (
    <div className="stack settings">
      <section className="card stack-sm" aria-labelledby="set-zone">
        <h2 id="set-zone">Time zone</h2>
        <TimeZoneSetting run={run} />
      </section>
      <section className="card">
        <ThemeSetting />
      </section>
      <section className="card stack-sm" aria-labelledby="set-about">
        <h2 id="set-about">About this app</h2>
        <p className="small">
          Administrative facts only: times, places, confirmations and what the office asked you to bring or do.{" "}
          {google?.demo
            ? "It reads only the demo Gmail inbox, a made-up person's shared by judges, and only to search for appointment messages."
            : "It reads your email only when you connect Google, and then only to search for appointment messages."}{" "}
          Sending a reply is simulated. All data here is synthetic.
        </p>
        <p className="small muted">Appointments are built by code from the accepted facts. Model text never changes an appointment. A clash check assumes a length for each appointment, because messages do not state an end time. The info button beside Appointments shows it.</p>
      </section>
      <DeleteCasePanel version={version} erasePending={erasePending} run={run} deleted={caseDeleted} onDeleted={onCaseDeleted} sharedCalendar={Boolean(google?.demo)} />
      {hosted && <DeleteAccountPanel run={run} onDeleted={signedOut} />}
    </div>
  );
}

// Usage, on the hosted site.
export function UsagePage({ run }: { run: Run }) {
  return (
    <div className="stack settings">
      <UsageSection run={run} />
    </div>
  );
}

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
        <span className="small muted"> · {zoneSourceWords(settings.timezoneSource, settings.timezone, device)}</span>
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
                {current === p.id && (ready ? <span className="pill pill-accepted">In use</span> : <span className="pill pill-pending">Needs setup</span>)}
              </div>
              <p className="small muted">{p.receives}</p>
              <p.Body settings={settings} run={run} />
              {!ready &&
                (current === p.id ? (
                  <p className="small warn" role="status">
                    {p.id === "meta" ? "Meta is still the provider, but it has no key. Add a key, or pick another provider." : "ChatGPT is still the provider, but you are signed out. Sign in again, or pick another provider."}
                  </p>
                ) : (
                  <p className="small muted">{p.id === "meta" ? "Add a key to use Meta." : "Sign in to use ChatGPT."}</p>
                ))}
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
  const { backend, reload, notify } = useAgent();
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
            const answer = (await backend.chatgptSignOut(settings.settingsVersion)) as { notice?: string | null } | undefined;
            // ChatGPT may not confirm the sign-out on its side (0010).
            if (answer?.notice) notify(answer.notice);
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
// event the assistant adds is an action with Undo. Each connect and
// disconnect states the connection version it was shown at (0012, G2).
export function GoogleSetting({ run }: { run: Run }) {
  const { backend, google, reload, notify } = useAgent();
  const uid = useId();
  const [want, setWant] = useState<GoogleGrants>({ gmail: true, calendar: true });
  if (google === null) return <p className="small muted">Connecting Google is not available in this build yet.</p>;
  const g = googleOrOff(google);
  if (!g.configured) {
    return (
      <p className="small muted">Google is not set up on this server yet, so it cannot be connected here.</p>
    );
  }
  // 0021: the hosted site's shared demo Gmail and Calendar, for an account
  // with no Google of its own. One quiet line, no address, and no buttons
  // for judges (D7, D8).
  const shared = g.demo ? (
    <div className="stack-xs" data-testid="demo-google">
      <p className="small muted">
        <Icon name="google" size="sm" /> {DEMO_GOOGLE_LINE}: {g.demo.connected ? "connected" : "needs reconnecting"}.
      </p>
      <p className="small muted">{DEMO_GOOGLE_PRIVACY}</p>
      {g.demo.connected && g.calendar && <CalendarReadLine read={g.calendarRead ?? null} />}
    </div>
  ) : null;
  if (g.demo && !g.demo.ownConnect) return shared;
  // Opens Google's sign-in page. Google comes back to /?connected=google
  // or /?google_error=<code>.
  const connect = (grants: GoogleGrants) => async () => {
    const { authorizeUrl } = await backend.googleConnect(g.version, grants);
    const url = safeAuthorizeUrl(authorizeUrl, window.location.origin);
    if (!url) throw new Error("The sign-in address was not one this app opens.");
    window.location.assign(url);
  };
  const disconnect = async () => {
    const answer = await backend.googleDisconnect(g.version);
    if (!answer.revoked) notify("Disconnected Google. Google did not confirm it removed the app's access, so you can remove it in your Google Account's security settings.");
    await reload();
  };
  const grants: Array<{ on: boolean; label: string }> = [
    { on: g.gmail, label: "Gmail, read-only: search for messages about appointments" },
    { on: g.calendar, label: `Google Calendar: read events for clashes, and add, update or remove your appointments${g.calendar && g.calendarId ? ` (calendar ${g.calendarId})` : ""}` },
  ];
  const grantList = (
    <ul className="grants" aria-label={g.connected ? "Permissions granted" : "Permissions last granted"}>
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
  );
  if (g.needsReconnect) {
    // Reconnect asks again for what was connected, or both when the
    // server no longer knows.
    const again = g.gmail || g.calendar ? { gmail: g.gmail, calendar: g.calendar } : { gmail: true, calendar: true };
    return (
      <div className="stack-sm">
        <p className="warn" role="status">
          <Icon name="alert" size="sm" /> Google needs you to sign in again. The assistant cannot read Gmail or Google Calendar until you reconnect.
        </p>
        {g.email && (
          <p className="small account-line">
            <Icon name="user" size="sm" /> Last connected as {g.email}
          </p>
        )}
        {(g.gmail || g.calendar) && grantList}
        <div className="btn-row">
          <ActionButton run={run} action={connect(again)}>
            <Icon name="google" size="sm" /> Reconnect Google
          </ActionButton>
          <ActionButton run={run} variant="ghost" action={disconnect}>
            Disconnect
          </ActionButton>
        </div>
      </div>
    );
  }
  if (!g.connected) {
    return (
      <div className="stack-sm">
        {shared}
        <p className="small muted">Connect Google so the assistant can find appointment emails in Gmail and keep your appointments on Google Calendar. Google receives what the assistant adds to your calendar.</p>
        <fieldset className="stack-xs">
          <legend className="small">What the assistant may use</legend>
          <label className="check small" htmlFor={`${uid}-gmail`}>
            <input id={`${uid}-gmail`} name="google-gmail" type="checkbox" checked={want.gmail} onChange={(e) => setWant((w) => ({ ...w, gmail: e.target.checked }))} />
            <span>{grants[0]!.label}</span>
          </label>
          <label className="check small" htmlFor={`${uid}-calendar`}>
            <input id={`${uid}-calendar`} name="google-calendar" type="checkbox" checked={want.calendar} onChange={(e) => setWant((w) => ({ ...w, calendar: e.target.checked }))} />
            <span>Google Calendar: read events for clashes, and add, update or remove your appointments (your main calendar)</span>
          </label>
        </fieldset>
        {!want.gmail && !want.calendar && <p className="hint">Check Gmail, Google Calendar or both to connect.</p>}
        <div>
          <ActionButton run={run} disabled={!want.gmail && !want.calendar} action={connect(want)}>
            <Icon name="google" size="sm" /> Connect Google
          </ActionButton>
        </div>
      </div>
    );
  }
  const missing = !g.gmail || !g.calendar;
  return (
    <div className="stack-sm">
      <p className="small account-line">
        <Icon name="user" size="sm" /> Connected as {g.email ?? "a Google account"}
      </p>
      {grantList}
      {g.calendar && <CalendarReadLine read={g.calendarRead ?? null} />}
      <div className="btn-row">
        {g.calendar && <CalendarReadButton run={run} onRead={(read) => read && notify(calendarReadSentence(read))} />}
        {missing && (
          <ActionButton run={run} variant="ghost" action={connect({ gmail: true, calendar: true })}>
            Connect again with both
          </ActionButton>
        )}
        <ActionButton run={run} variant="ghost" action={disconnect}>
          Disconnect
        </ActionButton>
      </div>
    </div>
  );
}

// 0016, H2: when the app last read Google Calendar for the clash checks,
// how many events it found and for which days. "Read at 6:52 PM, 3 events
// in the next 31 days."
export function calendarReadSentence(read: CalendarRead, today = wallNow().slice(0, 10)): string {
  if (!read.readAt) return "Google Calendar has not been read yet.";
  const events = `${read.events} event${read.events === 1 ? "" : "s"}`;
  const days = read.from === today ? `in the next ${read.days} days` : read.from && read.to ? `from ${dateLabel(read.from)} to ${dateLabel(read.to)}` : "";
  return `Read at ${clockTime(read.readAt)}, ${events} ${days}`.trim() + ".";
}

// 0021, D7 and D8: what Connections says about the shared demo Gmail and
// Calendar.
export const DEMO_GOOGLE_LINE = "Demo Gmail and Calendar: a made-up account shared by judges";
export const DEMO_GOOGLE_PRIVACY = "The inbox and calendar belong to a made-up person and are shared with other judges, so add nothing private there.";

const CALENDAR_ERRORS: Record<string, string> = {
  google_demo_reconnect: "The demo Gmail and Calendar need reconnecting by the site's owner.",
  google_reconnect_needed: "The Google connection expired. Connect it again.",
  google_scope_missing: "The connection does not include Google Calendar. Connect again with it turned on.",
  google_not_connected: "Google is not connected.",
};

export const calendarErrorSentence = (e: { code: string; at: string }) =>
  `The read at ${clockTime(e.at)} failed. ${CALENDAR_ERRORS[e.code] ?? "Google did not answer. Try again in a moment."}`;

function CalendarReadLine({ read }: { read: CalendarRead | null }) {
  return (
    <div className="stack-xs">
      <p className="small muted" data-testid="calendar-read">
        <Icon name="calendar" size="sm" /> {read ? calendarReadSentence(read) : "Google Calendar has not been read yet."}
      </p>
      {read?.error && (
        <p className="small warn" role="alert">
          <Icon name="alert" size="sm" /> {calendarErrorSentence(read.error)}
        </p>
      )}
    </div>
  );
}

// "Read the calendar again", with its own busy label while it reads.
function CalendarReadButton({ run, onRead }: { run: Run; onRead: (read: CalendarRead | undefined) => void }) {
  const { backend } = useAgent();
  const [reading, setReading] = useState(false);
  return (
    <ActionButton
      run={run}
      variant="ghost"
      action={async () => {
        setReading(true);
        try {
          onRead((await backend.googleCalendarRefresh()).read);
        } finally {
          setReading(false);
        }
      }}
    >
      {reading ? "Reading the calendar…" : "Read the calendar again"}
    </ActionButton>
  );
}

// Delete case. The only permanent deletion, with its own typed
// confirmation. No agent can reach it. `onDeleted` runs once it finished.
// What the page says once Delete case finished. On the shared demo
// calendar, whether its events went or wait for the site's sweep.
export function deletedSentence(sharedCalendar: boolean, demoCalendar: "removed" | "pending" | null): string {
  if (demoCalendar === "pending") return CASE_DELETED_PENDING_TEXT;
  return sharedCalendar || demoCalendar === "removed" ? CASE_DELETED_SHARED_TEXT : CASE_DELETED_TEXT;
}

export function DeleteCasePanel({
  version,
  erasePending = false,
  run,
  deleted = false,
  onDeleted,
  sharedCalendar = false,
}: {
  version: number;
  erasePending?: boolean;
  run: Run;
  deleted?: boolean;
  onDeleted?: () => void;
  sharedCalendar?: boolean;
}) {
  const [typed, setTyped] = useState("");
  // 0021, round 2, finding 5: whether the demo calendar's events went, as
  // the server answered.
  const [demoCalendar, setDemoCalendar] = useState<"removed" | "pending" | null>(null);
  return (
    <section className="card danger-zone">
      <h2>
        <Icon name="trash" size="sm" /> Delete case
      </h2>
      <div role="status">
        {deleted && (
          <p className="notice">
            <Icon name="check" />
            <span>{deletedSentence(sharedCalendar, demoCalendar)}</span>
          </p>
        )}
      </div>
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
            const done = await api.deleteCase(version, typed);
            setDemoCalendar(done.demoCalendar ?? null);
            setTyped("");
            onDeleted?.();
          }}
        >
          Delete this case and all its data permanently. This cannot be undone.
        </ActionButton>
      </div>
    </section>
  );
}
