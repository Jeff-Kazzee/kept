// The app shell: a centered chat with the schedule beside it. Laptop (1024
// px and up): the schedule is a column on the right that folds to a narrow
// rail. Tablet (768 to 1023 px): a side sheet. Phone: a bottom sheet. The
// shell reads the case, the settings and the activity together, and gives
// the settings and activity to every part through AgentContext.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { realBackend, type AgentBackend } from "./agentApi.ts";
import { AgentContext, type AgentState } from "./agent/AgentContext.tsx";
import { keep, sendDeviceZone, settle } from "./agent/reads.ts";
import { runUndo, serialUndo } from "./agent/undo.ts";
import { ApiError, api, type AppState, type FixtureScenario } from "./api.ts";
import type { Run } from "./components/ActionButton.tsx";
import { Mark } from "./components/Art.tsx";
import { LoadError } from "./components/LoadError.tsx";
import { Icon } from "./components/Icon.tsx";
import { DEFAULT_SETTINGS, deviceZone, type ActivityLog, type GoogleStatus, type Settings } from "./contract.ts";
import { ChatView } from "./chat/ChatView.tsx";
import { DEMO_IDS } from "./chat/demo.ts";
import { createMockTransport } from "./chat/mockStream.ts";
import { realTransport } from "./chat/transport.ts";
import type { ChatTransport } from "./chat/types.ts";
import { useChat } from "./chat/useChat.ts";
import { errorSentence, setCaseZone, signInReturn } from "./format.ts";
import { SchedulePanel, TABS, waitingCount, type PanelTab } from "./schedule/SchedulePanel.tsx";
import { slotElementId } from "./schedule/Agenda.tsx";
import { useLiveRefresh } from "./useLiveRefresh.ts";
import { LAPTOP, chipRef, findChip, useMedia, type ChipRef } from "./layout.ts";
import { AccountMenu } from "./hosted/AccountMenu.tsx";
import { SignIn } from "./hosted/SignIn.tsx";
import { hostedApi, hostedSignInError, signedOut, type SessionInfo, type SignedInSession } from "./hosted/session.ts";

// `settings`: the toast links to Settings, for the setup sentence (J12).
type Toast = { id: number; kind: "error" | "info"; text: string; settings?: boolean };

// J12: the server refused a model step because no provider is ready.
const needsSetup = (e: unknown) => e instanceof ApiError && (e.body.error === "provider_not_ready" || e.body.error === "credits_exhausted");

// The scripted chat is a development tool. It makes real case writes, so
// only a development build has it (or a check build made with
// APP_UI_FAKES=1, see vite.config.ts). In `pnpm build` both flags are
// false, the branch below is dropped, and the module is left out of the
// bundle. A production page ignores ?mockchat=1. Every route is the
// server's, in every build (0011, U51).
const fakesBuilt = import.meta.env.DEV || import.meta.env.APP_FAKES === true;
const scriptedChat = () => fakesBuilt && new URLSearchParams(window.location.search).get("mockchat") === "1";

// The page first asks which mode the server runs in (0014). Local mode is
// the app as it was. The hosted site shows the sign-in screen until a
// session is open, and the app after.
export function Root() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setSession(await hostedApi.session());
      setFailed(null);
    } catch (e) {
      setFailed(errorSentence(e));
    }
  }, []);
  const toSignIn = useCallback((text: string | null) => {
    setNotice(text);
    setSession((s) => (s && s.mode === "hosted" ? { mode: "hosted", signedIn: false, googleSignIn: s.googleSignIn } : s));
  }, []);
  useEffect(() => {
    // A failed Sign in with Google comes back as /?signInError=<code>.
    const params = new URLSearchParams(window.location.search);
    const code = params.get("signInError");
    void hostedApi.session().then(
      (s) => {
        if (s.mode === "hosted" && code !== null) {
          setNotice(hostedSignInError(code));
          params.delete("signInError");
          window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
        }
        if (s.mode === "hosted" && params.get("signedIn") === "google") {
          params.delete("signedIn");
          window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
        }
        setSession(s);
      },
      (e) => setFailed(errorSentence(e)),
    );
  }, []);
  if (failed) return <LoadError message={failed} onRetry={() => void load()} />;
  return <RootView session={session} notice={notice} setNotice={setNotice} setSession={setSession} toSignIn={toSignIn} />;
}

function RootView({
  session,
  notice,
  setNotice,
  setSession,
  toSignIn,
}: {
  session: SessionInfo | null;
  notice: string | null;
  setNotice: (t: string | null) => void;
  setSession: (s: SessionInfo) => void;
  toSignIn: (text: string | null) => void;
}) {
  if (!session) {
    return (
      <main className="loading" aria-busy="true">
        <p className="sr-only" role="status">
          Loading…
        </p>
      </main>
    );
  }
  if (session.mode === "hosted" && !session.signedIn) {
    return (
      <SignIn
        googleSignIn={session.googleSignIn}
        notice={notice}
        onSignedIn={(s) => {
          setNotice(null);
          setSession(s);
        }}
      />
    );
  }
  return <App hosted={session.mode === "hosted" ? session : null} onSession={setSession} onSignedOut={toSignIn} />;
}

export function App({
  hosted = null,
  onSession = () => {},
  onSignedOut = () => {},
}: { hosted?: SignedInSession | null; onSession?: (s: SessionInfo) => void; onSignedOut?: (text: string | null) => void } = {}) {
  const scripted = useMemo(scriptedChat, []);
  // Read through refs, so a new balance does not start another read.
  const hostedRef = useRef(hosted);
  hostedRef.current = hosted;
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const onSignedOutRef = useRef(onSignedOut);
  onSignedOutRef.current = onSignedOut;
  const backend: AgentBackend = realBackend;
  const [state, setState] = useState<AppState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [activity, setActivity] = useState<ActivityLog | null>(null);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const sentZone = useRef(false);

  const toast = useCallback((kind: Toast["kind"], text: string, settings = false) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, kind, text, ...(settings ? { settings } : {}) }]);
    if (kind === "info") setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  // Reads the case, the settings, the activity and Google together. Reads
  // can overlap (a card mid-turn, the turn's end, the poll), so only the
  // latest one is applied, checked again after every wait, and an older
  // answer never replaces a newer one. A route this build does not have
  // reads as null: the default zone, and the case history in Activity. Any
  // other failure keeps the last good value (Muse round 1, finding 5).
  const reads = useRef(0);
  const last = useRef<{ settings: Settings | null; activity: ActivityLog | null; google: GoogleStatus | null }>({ settings: null, activity: null, google: null });
  const [degraded, setDegraded] = useState(false);
  const refresh = useCallback(async () => {
    const mine = ++reads.current;
    const stale = () => mine !== reads.current;
    try {
      const [next, sRead, aRead, gRead] = await Promise.all([api.state(), settle(() => backend.settings()), settle(() => backend.activity()), settle(() => backend.google())]);
      if (stale()) return;
      // The balance moves with every turn on the hosted site.
      if (hostedRef.current) void hostedApi.session().then((x) => onSessionRef.current(x), () => {});
      const s = keep(sRead, last.current.settings);
      const a = keep(aRead, last.current.activity);
      const g = keep(gRead, last.current.google);
      last.current = { settings: s, activity: a, google: g };
      // The zone is set before the render that uses it.
      setCaseZone(s?.timezone ?? DEFAULT_SETTINGS.timezone);
      setSettings(s);
      setActivity(a);
      setGoogle(g);
      setDegraded(!sRead.ok || !aRead.ok || !gRead.ok);
      setState(next);
      setLoadError(null);
      // On first load with no zone set, the page sends this device's zone.
      // It counts as done once sent, or when someone else set the settings
      // first. A failed send is tried again at the next read (finding 8).
      if (s && s.timezoneSource === "default" && !sentZone.current) {
        const zone = deviceZone();
        if (!zone) {
          sentZone.current = true;
          return;
        }
        sentZone.current = true;
        const outcome = await sendDeviceZone(backend, s, zone);
        if (outcome === "failed") sentZone.current = false;
        else if (!stale()) void refreshRef.current();
      }
    } catch (e) {
      if (signedOut(e)) return onSignedOutRef.current("Your session ended. Sign in again.");
      if (!stale()) setLoadError(errorSentence(e));
    }
  }, [backend]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    const back = signInReturn(new URLSearchParams(window.location.search));
    if (back) {
      toast(back.kind, back.text);
      window.history.replaceState(null, "", `${window.location.pathname}${back.rest ? `?${back.rest}` : ""}`);
    }
  }, [refresh, toast]);

  // A change by an agent, the chat or another tab shows without a reload.
  useLiveRefresh(state?.live ?? null, refresh);

  // Runs an action, says what went wrong in a plain sentence, and reloads
  // the case. A 409 means the record changed since it was shown, so the
  // reload shows the current one.
  const run: Run = useCallback(
    async (action) => {
      try {
        await action();
      } catch (e) {
        if (signedOut(e)) return onSignedOutRef.current("Your session ended. Sign in again.");
        toast("error", errorSentence(e), needsSetup(e));
      }
      await refresh();
    },
    [refresh, toast],
  );

  // Undo, through runUndo: newest first, one run at a time, after a fresh
  // read of the activity (Muse round 1, findings 3 and 4). A refusal shows
  // its reason beside the entry.
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const [undoing, setUndoing] = useState(false);
  const serial = useRef(serialUndo());
  const undo = useCallback(
    async (ids: string[]) => {
      await serial.current(async () => {
        setUndoing(true);
        setBlocked((b) => Object.fromEntries(Object.entries(b).filter(([k]) => !ids.includes(k))));
        try {
          const out = await runUndo(backend, ids);
          if (out.blocked) setBlocked((b) => ({ ...b, [out.blocked!.id]: errorSentence(out.blocked!.error) }));
          if (out.error) toast("error", errorSentence(out.error));
          await refresh();
        } finally {
          setUndoing(false);
        }
      });
    },
    [backend, refresh, toast],
  );

  if (!state) {
    // Loading: a skeleton of the chat and the schedule. A failed load: the
    // reason in a sentence and Try again.
    return loadError ? (
      <LoadError message={loadError} onRetry={() => void refresh()} />
    ) : (
      <main className="skeleton" aria-busy="true">
        <p className="sr-only" role="status">
          Loading your case…
        </p>
        <div className="skeleton-chat" aria-hidden="true">
          <span className="skeleton-line w-40" />
          <span className="skeleton-line w-80" />
          <span className="skeleton-line w-60" />
          <span className="skeleton-block" />
        </div>
        <div className="skeleton-panel" aria-hidden="true">
          <span className="skeleton-line w-40" />
          <span className="skeleton-block short" />
          <span className="skeleton-block short" />
        </div>
      </main>
    );
  }
  return (
    <Shell
      state={state}
      run={run}
      refresh={refresh}
      toast={toast}
      toasts={toasts}
      setToasts={setToasts}
      scripted={scripted}
      backend={backend}
      settings={settings}
      activity={activity}
      google={google}
      undo={undo}
      blocked={blocked}
      undoing={undoing}
      degraded={degraded}
      hosted={hosted}
      onSignedOut={onSignedOut}
    />
  );
}

function Shell({
  state,
  run,
  refresh,
  toast,
  toasts,
  setToasts,
  scripted,
  backend,
  settings,
  activity,
  google,
  undo,
  blocked,
  undoing,
  degraded,
  hosted,
  onSignedOut,
}: {
  hosted: SignedInSession | null;
  onSignedOut: (text: string | null) => void;
  state: AppState;
  run: Run;
  refresh: () => Promise<void>;
  toast: (kind: Toast["kind"], text: string, settings?: boolean) => void;
  toasts: Toast[];
  setToasts: (f: (t: Toast[]) => Toast[]) => void;
  scripted: boolean;
  backend: AgentBackend;
  settings: Settings | null;
  activity: ActivityLog | null;
  google: GoogleStatus | null;
  undo: AgentState["undo"];
  blocked: AgentState["blocked"];
  undoing: boolean;
  degraded: boolean;
}) {
  const transport: ChatTransport = useMemo(
    () => (fakesBuilt && scripted ? createMockTransport({ api, storage: sessionStorage, activity: () => backend.activity(), google: () => backend.google() }) : realTransport),
    [scripted, backend],
  );
  const { chat, send, streaming, stop } = useChat(transport, `${state.live.generation}:${state.live.seq}`, () => {}, () => void refresh());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [railed, setRailed] = useState(false);
  const [tab, setTab] = useState<PanelTab>("schedule");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<FixtureScenario["messages"]>([]);
  const sheetToggle = useRef<HTMLButtonElement>(null);
  const laptop = useMedia(LAPTOP);
  const online = useOnline();
  // Below a laptop the schedule is a sheet: at the side on a tablet, at the
  // bottom on a phone. It is a modal dialog while open (review 2, B4).
  const sheetModal = !laptop && sheetOpen;
  const panelShown = laptop ? !railed : sheetOpen;
  // The fact chip that opened the schedule. Focus goes back to it when the
  // sheet closes.
  const returnTo = useRef<ChipRef | null>(null);

  const giveBackFocus = (fallback: HTMLElement | null) => {
    const ref = returnTo.current;
    returnTo.current = null;
    // After React has rendered the chat again.
    requestAnimationFrame(() => ((ref ? findChip(document, ref) : null) ?? fallback)?.focus());
  };
  // What opened the sheet when it was not a fact chip, such as the
  // composer's model pill opening Settings. Focus goes back to it (Muse
  // round 1, finding 11).
  const opener = useRef<HTMLElement | null>(null);
  const closeSchedule = () => {
    setSheetOpen(false);
    const back = opener.current && opener.current.isConnected ? opener.current : sheetToggle.current;
    opener.current = null;
    giveBackFocus(back);
  };
  const closeRef = useRef(closeSchedule);
  closeRef.current = closeSchedule;
  const focusPanel = () => requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById("panel-title")?.focus()));
  const openPanel = (t?: PanelTab) => {
    const from = document.activeElement;
    opener.current = from instanceof HTMLElement && from !== document.body ? from : null;
    if (t) setTab(t);
    if (laptop) setRailed(false);
    else setSheetOpen(true);
    focusPanel();
  };

  useEffect(() => {
    void api.fixtures().then(
      (s) => setFixtures(s.flatMap((x) => x.messages).filter((m, i, all) => all.findIndex((y) => y.id === m.id) === i)),
      () => setFixtures([]),
    );
  }, []);

  // Escape closes the sheet. An open dialog, such as the import sheet,
  // takes Escape first.
  useEffect(() => {
    if (!sheetModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetModal]);

  // Opens the schedule at one appointment, outlines it and moves focus to
  // it, so a keyboard or screen reader user lands there, not behind the
  // sheet.
  const showSlot = (slotKey: string, from?: HTMLElement) => {
    returnTo.current = chipRef(from, slotKey);
    setTab("schedule");
    if (laptop) setRailed(false);
    else setSheetOpen(true);
    setHighlight(slotKey);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.getElementById(slotElementId(slotKey));
        el?.scrollIntoView({ block: "center" });
        el?.focus({ preventScroll: true });
      }),
    );
  };

  const loadCalendar = async (file: File) => {
    if (file.size > 1_000_000) {
      toast("error", "That calendar file is larger than 1 MB. Nothing was loaded.");
      return;
    }
    const text = await file.text();
    await run(async () => {
      await api.loadCalendar(file.name, text, state.case.calendarVersion);
      toast("info", `Loaded the calendar ${file.name}. Clashes are checked against it.`);
    });
  };

  // Loads the demo calendar if none is loaded, and gives the first demo
  // message not yet in the case to the composer.
  const loadDemo = async () => {
    if (!state.case.calendar) {
      await run(async () => {
        const demo = await api.calendar();
        await api.loadCalendar(demo.name, demo.text, state.case.calendarVersion);
        toast("info", "Loaded the demo calendar. Press Enter to send the first demo message.");
      });
    }
    const imported = new Set(state.messages.map((m) => m.id));
    return fixtures.find((m) => DEMO_IDS.includes(m.id) && !imported.has(m.id)) ?? null;
  };

  const waiting = waitingCount(state);
  // What the composer's indicator says when no provider is picked.
  // What the composer's indicator says when no provider is picked, or when
  // the settings cannot be read.
  const modelLabel = scripted ? "Scripted demo, no model" : settings ? "No model set" : "Model settings unavailable";

  const agent: AgentState = {
    backend,
    settingsAvailable: settings !== null,
    settings: settings ?? DEFAULT_SETTINGS,
    activity,
    google,
    undo,
    blocked,
    // Undo waits while a turn streams or another undo runs (finding 4).
    undoBusy: streaming || undoing,
    report: (e) => toast("error", errorSentence(e), needsSetup(e)),
    notify: (text) => toast("info", text),
    reload: refresh,
    openSettings: () => openPanel("settings"),
    hosted,
    openUsage: () => {
      openPanel("settings");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const el = document.getElementById("set-usage");
          el?.scrollIntoView({ block: "start" });
          el?.focus({ preventScroll: true });
        }),
      );
    },
    signedOut: () => onSignedOut(null),
  };
  const signOut = async () => {
    try {
      await hostedApi.signOut();
      onSignedOut(null);
    } catch (e) {
      toast("error", errorSentence(e));
    }
  };

  return (
    <AgentContext.Provider value={agent}>
      <div className="app" data-panel={sheetOpen ? "open" : "closed"} data-rail={railed ? "folded" : "open"}>
        <header className="topbar" inert={sheetModal}>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Mark size={20} />
            </span>
            <h1>Appointment assistant</h1>
          </div>
          {hosted && <AccountMenu session={hosted} onUsage={agent.openUsage} onSignOut={() => void signOut()} />}
          <button
            ref={sheetToggle}
            type="button"
            className="btn btn-ghost sheet-toggle"
            aria-expanded={sheetOpen}
            aria-controls="schedule-panel"
            onClick={() => (sheetOpen ? closeSchedule() : openPanel())}
          >
            <Icon name="calendar" /> Schedule
            {waiting > 0 && (
              <span className="count" aria-label={`${waiting} waiting for you`}>
                {waiting}
              </span>
            )}
          </button>
        </header>
        <div className="banners">
          {!online && (
            <p className="offline" role="status">
              <Icon name="wifiOff" size="sm" /> You are offline. Nothing can be saved until the connection is back.
            </p>
          )}
          {degraded && online && (
            <p className="offline degraded" role="status">
              <Icon name="info" size="sm" /> Some settings could not be read just now. The app shows the last ones it read.
            </p>
          )}
        </div>
        <main className="main">
          <div className="chat-slot" inert={sheetModal}>
            <ChatView
              state={state}
              run={run}
              chat={chat}
              streaming={streaming}
              scripted={scripted}
              send={send}
              onStop={stop}
              onShowSlot={showSlot}
              onLoadCalendar={loadCalendar}
              onLoadDemo={loadDemo}
              fixtures={fixtures}
              modelLabel={modelLabel}
            />
          </div>
          <button type="button" className="scrim" aria-label="Close the schedule" tabIndex={-1} onClick={closeSchedule} />
          {laptop && railed && (
            <nav className="rail" aria-label="Schedule panel">
              <button type="button" className="rail-btn" onClick={() => openPanel()} aria-label="Open the schedule panel" title="Open the schedule panel">
                <Icon name="rail" />
              </button>
              {TABS.map((t) => (
                <button key={t.id} type="button" className="rail-btn" onClick={() => openPanel(t.id)} aria-label={`Open ${t.label}`} title={t.label}>
                  <Icon name={t.icon} />
                  {t.id === "schedule" && waiting > 0 && <span className="count">{waiting}</span>}
                </button>
              ))}
            </nav>
          )}
          {/* SP12.7: a div, so it may take either role. It is the
              complementary landmark beside the chat, and a modal dialog
              while it is the open sheet on a phone or a tablet. An aside
              may not be a dialog. */}
          <div
            id="schedule-panel"
            className="panel"
            aria-label="Schedule"
            hidden={laptop && railed}
            role={sheetModal ? "dialog" : "complementary"}
            aria-modal={sheetModal || undefined}
            inert={!laptop && !panelShown}
          >
            {!laptop && <SheetHandle onClose={closeSchedule} />}
            <SchedulePanel
              state={state}
              run={run}
              tab={tab}
              onTab={setTab}
              highlight={highlight}
              onClose={laptop ? undefined : closeSchedule}
              onCollapse={laptop ? () => setRailed(true) : undefined}
            />
          </div>
        </main>
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
              <Icon name={t.kind === "error" ? "alert" : "info"} />
              <p>{t.text}</p>
              {t.settings && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setToasts((all) => all.filter((x) => x.id !== t.id));
                    openPanel("settings");
                  }}
                >
                  Open Settings
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
                <Icon name="close" size="sm" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </AgentContext.Provider>
  );
}

// True while the browser says it is online.
function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

// The bottom sheet's handle: a tap or a downward drag closes the sheet.
function SheetHandle({ onClose }: { onClose: () => void }) {
  const start = useRef<number | null>(null);
  return (
    <button
      type="button"
      className="sheet-handle"
      aria-label="Close the schedule"
      onClick={onClose}
      onPointerDown={(e) => {
        start.current = e.clientY;
      }}
      onPointerUp={(e) => {
        if (start.current !== null && e.clientY - start.current > 48) onClose();
        start.current = null;
      }}
    >
      <span aria-hidden="true" />
    </button>
  );
}
