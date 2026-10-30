// The app shell (0015): a left sidebar with the navigation and the
// account, and the work area beside it, the chat and the schedule. Laptop
// (1024 px and up): the sidebar is 248 px and folds to a rail, and the
// schedule is a column on the right that folds to its own rail. Tablet (768
// to 1023 px): the sidebar is the rail and the schedule a side sheet.
// Phone: the sidebar is a drawer and the schedule a bottom sheet. A sidebar
// page opens in the work area in place of the case. The shell reads the
// case, the settings and the activity together, and gives the settings and
// activity to every part through AgentContext.
import { caseNeedsCards, loadCaseCards } from "./case/lazyCards.tsx";
import { scopeReadback } from "./case/readback.ts";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { realBackend, type AgentBackend } from "./agentApi.ts";
import { AgentContext, type AgentState } from "./agent/AgentContext.tsx";
import { keep, sendDeviceZone, settle } from "./agent/reads.ts";
import { runUndo, serialUndo } from "./agent/undo.ts";
import { api, type AppState, type FixtureScenario } from "./api.ts";
import type { Run } from "./components/ActionButton.tsx";
import { LoadError } from "./components/LoadError.tsx";
import { Icon } from "./components/Icon.tsx";
import { DEFAULT_SETTINGS, deviceZone, type ActivityLog, type GoogleStatus, type Settings } from "./contract.ts";
import { ChatView } from "./chat/ChatView.tsx";
import { DEMO_IDS, createFixturesLoader } from "./chat/demo.ts";
import type { ScriptedLog } from "./chat/mockStream.ts";
import { realTransport } from "./chat/transport.ts";
import type { ChatTransport } from "./chat/types.ts";
import { useChat } from "./chat/useChat.ts";
import { errorSentence, setCaseZone, signInReturn } from "./format.ts";
import { TABS, railLabel, slotElementId, waitingCount, type PanelTab } from "./schedule/tabs.ts";
import { SchedulePanel, loadPanel } from "./schedule/lazyPanel.tsx";
import { useLiveRefresh } from "./useLiveRefresh.ts";
import { LAPTOP, TABLET_UP, chipRef, findChip, focusSoon, useMedia, type ChipRef } from "./layout.ts";
import { ZoneNotice, caseDeletedShown } from "./pages/shared.tsx";
import { Avatar } from "./shell/AccountMenu.tsx";
import { Sidebar, type SideLayout } from "./shell/Sidebar.tsx";
import { Toasts, type Toast } from "./shell/Toasts.tsx";
import { VIEW_TITLES, openersFor, person, shellModes, readFolded, saveFolded, setupLink, viewIn, type ToastLink, type View } from "./shell/shell.ts";
import { hostedApi, hostedSignInError, signedOut, type SessionInfo, type SignedInSession } from "./hosted/session.ts";


// The scripted chat is a development tool. It makes real case writes, so
// only a development build has it (or a check build made with
// APP_UI_FAKES=1, see vite.config.ts). In `pnpm build` both flags are
// false, the branch below is dropped, and the module is left out of the
// bundle. A production page ignores ?mockchat=1. Every route is the
// server's, in every build (0011, U51).
const fakesBuilt = import.meta.env.DEV || import.meta.env.APP_FAKES === true;
type ScriptedModule = typeof import("./chat/mockStream.ts");
// Started with the page, beside the first reads.
const scriptedLoad: Promise<ScriptedModule> | null = fakesBuilt && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mockchat") === "1" ? import("./chat/mockStream.ts") : null;
const scriptedChat = () => fakesBuilt && new URLSearchParams(window.location.search).get("mockchat") === "1";

// 0019, P18: what is not on the case screen loads on demand. Each import
// is one function, so every caller (the sidebar, the account menu, a
// toast, the model pill, Open Usage) opens the same chunk, and the idle
// prefetch below warms it.
export const loadPages = () => import("./shell/PageView.tsx");
const PageView = lazy(loadPages);
// The panel and the case's cards start loading with the page, beside the
// first reads (0019, P18).
void loadPanel().catch(() => {});
void loadCaseCards().catch(() => {});
const SignIn = lazy(() => import("./hosted/SignIn.tsx").then((m) => ({ default: m.SignIn })));

// While a page's chunk loads: the page's frame, quiet, so nothing jumps.
function PageLoading() {
  return (
    <div className="page-inner" aria-busy="true">
      <span className="skeleton-line w-40" />
      <span className="skeleton-block" />
    </div>
  );
}

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

// Who the page is open for: local, signed out, or one hosted account. Kept
// in memory only.
export const sessionOwner = (s: SessionInfo | null) =>
  !s ? "none" : s.mode === "local" ? "local" : s.signedIn ? `hosted:${s.account.kind}:${s.account.email ?? s.account.name ?? ""}` : "signed-out";

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
  // Fix round 2, N6: reply ticks belong to this session and account.
  scopeReadback(sessionOwner(session));
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
      <Suspense fallback={<main className="loading" aria-busy="true" />}>
        <SignIn
          googleSignIn={session.googleSignIn}
          notice={notice}
          onSignedIn={(s) => {
            setNotice(null);
            setSession(s);
          }}
        />
      </Suspense>
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
  // The scripted chat's own entries (0019, P21), in development and check
  // builds only.
  // The module loads only in those builds, and only with ?mockchat=1, so
  // no part of it reaches the production bundle (0019, P18).
  const [mock, setMock] = useState<ScriptedModule | null>(null);
  useEffect(() => {
    if (fakesBuilt && scripted) void (scriptedLoad ?? import("./chat/mockStream.ts")).then((m) => setMock(m));
  }, [scripted]);
  const scriptedLog = useMemo(() => (fakesBuilt && mock ? mock.createScriptedLog(sessionStorage) : null), [mock]);
  const backend: AgentBackend = useMemo(() => (fakesBuilt && mock && scriptedLog ? mock.scriptedBackend(realBackend, scriptedLog) : realBackend), [mock, scriptedLog]);
  const [state, setState] = useState<AppState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [activity, setActivity] = useState<ActivityLog | null>(null);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const sentZone = useRef(false);

  const toast = useCallback((kind: Toast["kind"], text: string, link?: ToastLink) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, kind, text, ...(link ? { link } : {}) }]);
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
      // 0019, P18: the first render of a case that shows these cards waits
      // for their chunk, which started with the page, so no placeholder is
      // swapped for a card in view.
      if (caseNeedsCards(next)) await loadCaseCards().catch(() => {});
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
    // The scripted chat reads through its own backend, once it is in.
    if (scripted && !mock) return;
    void refresh();
    const back = signInReturn(new URLSearchParams(window.location.search));
    if (back) {
      toast(back.kind, back.text);
      window.history.replaceState(null, "", `${window.location.pathname}${back.rest ? `?${back.rest}` : ""}`);
    }
  }, [refresh, toast, scripted, mock]);


  // Runs an action, says what went wrong in a plain sentence, and reloads
  // the case. A 409 means the record changed since it was shown, so the
  // reload shows the current one.
  const run: Run = useCallback(
    async (action) => {
      try {
        await action();
      } catch (e) {
        if (signedOut(e)) return onSignedOutRef.current("Your session ended. Sign in again.");
        toast("error", errorSentence(e), setupLink(e));
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

  if (!state || (scripted && !mock)) {
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
          <span className="skeleton-composer" />
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
      mock={mock}
      scriptedLog={scriptedLog}
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
  mock,
  scriptedLog,
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
  toast: (kind: Toast["kind"], text: string, link?: ToastLink) => void;
  toasts: Toast[];
  setToasts: (f: (t: Toast[]) => Toast[]) => void;
  scripted: boolean;
  mock: ScriptedModule | null;
  scriptedLog: ScriptedLog | null;
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
    () => (fakesBuilt && scripted && mock ? mock.createMockTransport({ api, storage: sessionStorage, activity: () => backend.activity(), google: () => backend.google(), scriptedLog }) : realTransport),
    [scripted, mock, backend, scriptedLog],
  );
  const { chat, send, streaming, stop } = useChat(transport, `${state.live.generation}:${state.live.seq}`, () => {}, () => void refresh());
  // A change by an agent, the chat or another tab shows without a reload.
  // It asks often while a turn or an undo runs, and backs off when quiet
  // (0019, P20).
  useLiveRefresh(state.live, refresh, streaming || undoing);
  const mode = hosted ? "hosted" : "local";
  const [sheetOpen, setSheetOpen] = useState(false);
  // The phone sheet's height (0019, P16). It opens full.
  const [snap, setSnap] = useState<Snap>("full");
  useEffect(() => {
    if (sheetOpen) setSnap("full");
  }, [sheetOpen]);
  // The generation a Delete case left (0017, fix round 1, R7).
  const [deletedFrom, setDeletedFrom] = useState<number | null>(null);
  const [railed, setRailed] = useState(false);
  const [tab, setTab] = useState<PanelTab>("schedule");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<FixtureScenario["messages"]>([]);
  // The view the work area shows (0015). A page covers the case, which
  // stays mounted under it, so the chat, its scroll and the draft stay.
  const [view, setView] = useState<View>("case");
  const [folded, setFolded] = useState(readFolded);
  const device = useMemo(deviceZone, []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sheetToggle = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const laptop = useMedia(LAPTOP);
  const phone = !useMedia(TABLET_UP);
  const online = useOnline();
  const layout: SideLayout = phone ? "drawer" : laptop && !folded ? "full" : "rail";
  // What is modal and what is inert (shellModes, 0015).
  const { pageOpen, sheetModal, drawerModal, inert } = shellModes({ laptop, phone, sheetOpen, drawerOpen, railed, view });
  // The fact chip that opened the schedule. Focus goes back to it when the
  // sheet closes.
  const returnTo = useRef<ChipRef | null>(null);

  const giveBackFocus = (fallback: HTMLElement | null) => {
    const ref = returnTo.current;
    returnTo.current = null;
    // After React has rendered the chat again.
    requestAnimationFrame(() => ((ref ? findChip(document, ref) : null) ?? fallback)?.focus());
  };
  // What opened the sheet when it was not a fact chip, such as Open
  // Activity on the Agent access page. Focus goes back to it (Muse round 1,
  // finding 11).
  const opener = useRef<HTMLElement | null>(null);
  const closeSchedule = () => {
    setSheetOpen(false);
    const back = opener.current && opener.current.isConnected ? opener.current : sheetToggle.current;
    opener.current = null;
    giveBackFocus(back);
  };
  const closeRef = useRef(closeSchedule);
  closeRef.current = closeSchedule;
  const focusPanel = () => focusSoon(() => document.getElementById("panel-title"));
  const openPanel = (t?: PanelTab) => {
    const from = document.activeElement;
    // A page's button goes away with the page, so focus then goes back to
    // the Schedule button.
    opener.current = from instanceof HTMLElement && from !== document.body && !pageOpen ? from : null;
    setView("case");
    setDrawerOpen(false);
    if (t) setTab(t);
    if (laptop) setRailed(false);
    else setSheetOpen(true);
    focusPanel();
  };

  // Opens a view of the work area and puts focus on its heading (Z8). A
  // view this mode does not have shows the case.
  const focusTitle = () => focusSoon(() => title.current);
  const openView = (next: View) => {
    const to = viewIn(mode, next);
    setView(to);
    setDrawerOpen(false);
    setSheetOpen(false);
    // Choosing the view already open leaves focus where it is.
    if (to !== view) focusTitle();
  };
  const fold = () =>
    setFolded((f) => {
      saveFolded(!f);
      return !f;
    });
  // The drawer takes focus at its close button when it opens, after it is
  // no longer inert.
  const openDrawer = () => {
    setDrawerOpen(true);
    focusSoon(() => drawerClose.current);
  };
  const closeDrawer = () => {
    setDrawerOpen(false);
    focusSoon(() => menuButton.current);
  };
  const closeDrawerRef = useRef(closeDrawer);
  closeDrawerRef.current = closeDrawer;

  // 0019, P17: the fixtures load only when the person opens the demo or the
  // import sheet, or once the demo is in the case (for "Next demo
  // message"), never on a plain first load.
  const fixturesLoader = useRef<(() => Promise<FixtureScenario["messages"]>) | null>(null);
  fixturesLoader.current ??= createFixturesLoader(() => api.fixtures(), setFixtures);
  const ensureFixtures = fixturesLoader.current;
  const demoStarted = state.messages.some((m) => DEMO_IDS.includes(m.id));
  useEffect(() => {
    if (demoStarted) void ensureFixtures();
  }, [demoStarted, ensureFixtures]);

  // 0019, P18: the cards a conflict, a reply or a question need load as
  // soon as the case has one, beside the first reads.
  const needsCards = caseNeedsCards(state);
  useEffect(() => {
    if (needsCards) void loadCaseCards().catch(() => {});
  }, [needsCards]);

  // 0019, P18: once the case is on screen and the browser is idle, the
  // pages' chunk loads, so opening one later does not wait.
  useEffect(() => {
    const idle = (cb: () => void) => (typeof requestIdleCallback === "function" ? requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 2500));
    const t = window.setTimeout(() => idle(() => void Promise.all([loadPages(), loadCaseCards()]).catch(() => {})), 1500);
    return () => window.clearTimeout(t);
  }, []);

  // Escape closes the sheet or the drawer. An open dialog, such as the
  // import sheet, and an open menu take Escape first.
  useEffect(() => {
    if (!sheetModal && !drawerModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
      if (drawerModal) closeDrawerRef.current();
      else closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetModal, drawerModal]);


  // Opens the schedule at one appointment, outlines it and moves focus to
  // it, so a keyboard or screen reader user lands there, not behind the
  // sheet.
  const showSlot = (slotKey: string, from?: HTMLElement) => {
    returnTo.current = chipRef(from, slotKey);
    setView("case");
    setTab("schedule");
    if (laptop) setRailed(false);
    else setSheetOpen(true);
    setHighlight(slotKey);
    focusSoon(() => {
      const el = document.getElementById(slotElementId(slotKey));
      el?.scrollIntoView({ block: "center" });
      return el;
    });
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
    const list = await ensureFixtures();
    const imported = new Set(state.messages.map((m) => m.id));
    return list.find((m) => DEMO_IDS.includes(m.id) && !imported.has(m.id)) ?? null;
  };

  const waiting = waitingCount(state);
  // What the composer's indicator says when no provider is picked, or when
  // the settings cannot be read.
  const modelLabel = scripted ? "Scripted demo, no model" : settings ? "No model set" : "Model settings unavailable";
  const who = person(hosted, google);

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
    report: (e) => toast("error", errorSentence(e), setupLink(e)),
    notify: (text) => toast("info", text),
    reload: refresh,
    hosted,
    // S8: the model pill, the setup notice and Open Usage.
    ...openersFor(openView),
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
  const back = () => openView("case");

  return (
    <AgentContext.Provider value={agent}>
      <div className="app" data-snap={snap} data-panel={sheetOpen ? "open" : "closed"} data-rail={railed ? "folded" : "open"} data-side={layout} data-drawer={drawerOpen ? "open" : "closed"} data-view={view}>
        {/* The top bar comes first in the DOM so Tab meets the fold toggle
            before the sidebar (review r2). The grid places both. */}
        <header className="topbar" inert={inert.topbar}>
          <button
            ref={menuButton}
            type="button"
            className="btn btn-ghost menu-btn"
            aria-expanded={drawerOpen}
            aria-controls="sidebar"
            aria-label={`Open the menu. ${who.name}, ${who.line}`}
            onClick={openDrawer}
          >
            <Icon name="menu" />
            <Avatar who={who} />
          </button>
          {/* Z11: the sidebar's fold toggle, where the phone's menu
              button sits, so the app name fits the sidebar's head. */}
          {laptop && (
            <button
              type="button"
              className="btn btn-ghost btn-icon side-fold"
              aria-expanded={!folded}
              aria-controls="sidebar"
              aria-label={folded ? "Open the sidebar" : "Fold the sidebar"}
              title={folded ? "Open the sidebar" : "Fold the sidebar"}
              onClick={fold}
            >
              <Icon name="sidebar" />
            </button>
          )}
          <h1 ref={title} id="view-title" className="view-title" tabIndex={-1}>
            {VIEW_TITLES[view]}
          </h1>
          {/* 0019: on a laptop the top bar says how the case stands. */}
          {view === "case" && <span className="view-sub">{caseLine(state, waiting)}</span>}
          {!pageOpen && (
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
          )}
        </header>
        <Sidebar
          mode={mode}
          layout={layout}
          view={view}
          who={who}
          session={hosted}
          waiting={waiting}
          drawerOpen={drawerOpen}
          inert={inert.sidebar}
          closeRef={drawerClose}
          onClose={closeDrawer}
          onOpen={openView}
          onSignOut={() => void signOut()}
        />
        <button type="button" className="drawer-scrim" aria-label="Close the menu" tabIndex={-1} onClick={closeDrawer} />
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
          {settings && (
            <ZoneNotice settings={settings} device={device} run={run} save={(zone) => backend.setTimezone(zone, settings.settingsVersion, "you")} />
          )}
        </div>
        <main className="main">
          <div className="chat-slot" inert={inert.chat}>
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
              loadFixtures={ensureFixtures}
              modelLabel={modelLabel}
            />
          </div>
          <button type="button" className="scrim" aria-label="Close the schedule" tabIndex={-1} onClick={closeSchedule} />
          {laptop && railed && (
            <nav className="rail" aria-label="Schedule panel" inert={inert.rail}>
              <button type="button" className="rail-btn" onClick={() => openPanel()} aria-label="Open the schedule panel" title="Open the schedule panel">
                <Icon name="rail" />
              </button>
              {TABS.map((t) => (
                <button key={t.id} type="button" className="rail-btn" onClick={() => openPanel(t.id)} aria-label={railLabel(t, waiting)} title={t.label}>
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
            inert={inert.panel}
          >
            {!laptop && <SheetHandle onClose={closeSchedule} snap={snap} onSnap={setSnap} />}
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
          {pageOpen && view !== "case" && (
            <section className="page" aria-labelledby="view-title" inert={inert.page}>
              <Suspense fallback={<PageLoading />}>
                <PageView
                  view={view}
                  state={state}
                  run={run}
                  onBack={back}
                  onActivity={() => openPanel("activity")}
                  caseDeleted={caseDeletedShown(deletedFrom, state)}
                  onCaseDeleted={() => setDeletedFrom(state.generation)}
                />
              </Suspense>
            </section>
          )}
        </main>
        <Toasts toasts={toasts} inert={inert.toasts} onDismiss={(id) => setToasts((all) => all.filter((x) => x.id !== id))} onOpen={openView} />
      </div>
    </AgentContext.Provider>
  );
}

// "4 appointments · 1 waiting for you", written by code from the case.
export function caseLine(state: Pick<AppState, "case" | "records">, waiting: number): string {
  const archived = new Set(state.records.filter((r) => r.archived).map((r) => r.id));
  const n = state.case.slots.filter((s) => !archived.has(s.key)).length;
  const parts = [n === 0 ? "No appointments yet" : `${n} appointment${n === 1 ? "" : "s"}`];
  if (waiting > 0) parts.push(`${waiting} waiting for you`);
  return parts.join(" · ");
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

// The bottom sheet's handle. A tap closes the sheet. 0019, P16: it snaps
// to two heights. A drag down from full goes to half, a drag down from half
// closes it, and a drag up from half goes back to full.
export type Snap = "full" | "half";
export function snapAfterDrag(snap: Snap, dy: number): Snap | "close" | null {
  if (Math.abs(dy) <= 48) return null;
  if (dy < 0) return "full";
  return snap === "full" ? "half" : "close";
}

function SheetHandle({ onClose, snap, onSnap }: { onClose: () => void; snap: Snap; onSnap: (s: Snap) => void }) {
  const start = useRef<number | null>(null);
  const dragged = useRef(false);
  return (
    <button
      type="button"
      className="sheet-handle"
      aria-label="Close the schedule"
      onClick={() => {
        if (dragged.current) dragged.current = false;
        else onClose();
      }}
      onPointerDown={(e) => {
        start.current = e.clientY;
        dragged.current = false;
      }}
      onPointerUp={(e) => {
        const next = start.current === null ? null : snapAfterDrag(snap, e.clientY - start.current);
        start.current = null;
        if (next === null) return;
        dragged.current = true;
        if (next === "close") onClose();
        else onSnap(next);
      }}
    >
      <span aria-hidden="true" />
    </button>
  );
}
