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
import { createFakeBackend, createHybridBackend, type FakeBackend } from "./dev/fakeBackend.ts";
import { errorSentence, setCaseZone, signInErrorSentence } from "./format.ts";
import { SchedulePanel, TABS, waitingCount, type PanelTab } from "./schedule/SchedulePanel.tsx";
import { slotElementId } from "./schedule/Agenda.tsx";
import { useLiveRefresh } from "./useLiveRefresh.ts";
import { LAPTOP, chipRef, findChip, useMedia, type ChipRef } from "./layout.ts";

type Toast = { id: number; kind: "error" | "info"; text: string };

// The scripted chat and the fakes of the sprint 8 and 10 routes are
// development tools. They make real case writes, so only a development
// build has them (or a check build made with APP_UI_FAKES=1, see
// vite.config.ts). In `pnpm build` both flags are false, the branches
// below are dropped, and the modules are left out of the bundle. A
// production page ignores ?mockchat=1.
const fakesBuilt = import.meta.env.DEV || import.meta.env.APP_FAKES === true;
const scriptedChat = () => fakesBuilt && new URLSearchParams(window.location.search).get("mockchat") === "1";

export function App() {
  const scripted = useMemo(scriptedChat, []);
  // The fake covers only what sprint 8 does not serve yet: the provider,
  // model, sign-in and Google (0011, U37).
  const fake = useMemo(() => (fakesBuilt && scripted ? createFakeBackend({ storage: sessionStorage }) : null), [scripted]);
  const backend: AgentBackend = useMemo(() => (fakesBuilt && fake ? createHybridBackend(realBackend, fake) : realBackend), [fake]);
  const [state, setState] = useState<AppState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [activity, setActivity] = useState<ActivityLog | null>(null);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const sentZone = useRef(false);
  const generation = useRef<number | null>(null);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
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
      let aNow = aRead;
      // Delete case moves the generation. The fake activity goes with it.
      if (generation.current !== null && generation.current !== next.generation && fake) {
        fake.clearActivity();
        aNow = await settle(() => backend.activity());
        if (stale()) return;
      }
      generation.current = next.generation;
      const s = keep(sRead, last.current.settings);
      const a = keep(aNow, last.current.activity);
      const g = keep(gRead, last.current.google);
      last.current = { settings: s, activity: a, google: g };
      // The zone is set before the render that uses it.
      setCaseZone(s?.timezone ?? DEFAULT_SETTINGS.timezone);
      setSettings(s);
      setActivity(a);
      setGoogle(g);
      setDegraded(!sRead.ok || !aNow.ok || !gRead.ok);
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
      if (!stale()) setLoadError(errorSentence(e));
    }
  }, [backend, fake]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    // The ChatGPT sign-in comes back to /?signedIn=chatgpt.
    const params = new URLSearchParams(window.location.search);
    // Google comes back to /?connected=google. A failed ChatGPT sign-in
    // comes back to /?signInError=<code> (0010).
    const back = params.get("signedIn") === "chatgpt" ? "chatgpt" : params.get("connected") === "google" ? "google" : null;
    const failed = params.get("signInError");
    if (back || failed) {
      if (failed) toast("error", signInErrorSentence(failed));
      else toast("info", back === "chatgpt" ? "Signed in with ChatGPT. Settings shows it under Model provider." : "Connected Google. Settings lists what the assistant may use.");
      params.delete("signedIn");
      params.delete("connected");
      params.delete("signInError");
      const rest = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
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
        toast("error", errorSentence(e));
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
      fake={fake}
      settings={settings}
      activity={activity}
      google={google}
      undo={undo}
      blocked={blocked}
      undoing={undoing}
      degraded={degraded}
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
  fake,
  settings,
  activity,
  google,
  undo,
  blocked,
  undoing,
  degraded,
}: {
  state: AppState;
  run: Run;
  refresh: () => Promise<void>;
  toast: (kind: Toast["kind"], text: string) => void;
  toasts: Toast[];
  setToasts: (f: (t: Toast[]) => Toast[]) => void;
  scripted: boolean;
  backend: AgentBackend;
  fake: FakeBackend | null;
  settings: Settings | null;
  activity: ActivityLog | null;
  google: GoogleStatus | null;
  undo: AgentState["undo"];
  blocked: AgentState["blocked"];
  undoing: boolean;
  degraded: boolean;
}) {
  const transport: ChatTransport = useMemo(
    () => (fakesBuilt && scripted ? createMockTransport({ api, storage: sessionStorage, agent: fake, activity: () => backend.activity() }) : realTransport),
    [scripted, backend, fake],
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
  const modelLabel = scripted ? "Scripted demo, no model" : settings ? "No model set" : state.mode === "live" ? "Live model" : "Recorded responses";

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
    report: (e) => toast("error", errorSentence(e)),
    notify: (text) => toast("info", text),
    mode: state.mode,
    reload: refresh,
    openSettings: () => openPanel("settings"),
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
          <aside
            id="schedule-panel"
            className="panel"
            aria-label="Schedule"
            hidden={laptop && railed}
            role={sheetModal ? "dialog" : undefined}
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
          </aside>
        </main>
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
              <Icon name={t.kind === "error" ? "alert" : "info"} />
              <p>{t.text}</p>
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
