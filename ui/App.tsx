// The app shell: the pairing screen until the browser is paired, then the
// chat with the schedule beside it. Laptop (1024 px and up): the schedule
// is a column on the right. Tablet (768 to 1023 px): a side sheet. Phone:
// a tab bar switches between Chat and Schedule.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isNotPaired, type AppState, type FixtureScenario } from "./api.ts";
import type { Run } from "./components/ActionButton.tsx";
import { Icon } from "./components/Icon.tsx";
import { ChatView } from "./chat/ChatView.tsx";
import { DEMO_IDS } from "./chat/demo.ts";
import { createMockTransport } from "./chat/mockStream.ts";
import { realTransport } from "./chat/transport.ts";
import type { ChatTransport } from "./chat/types.ts";
import { useChat } from "./chat/useChat.ts";
import { errorSentence } from "./format.ts";
import { PairingScreen } from "./PairingScreen.tsx";
import { SchedulePanel, waitingCount, type PanelTab } from "./schedule/SchedulePanel.tsx";
import { slotElementId } from "./schedule/Agenda.tsx";
import { useLiveRefresh } from "./useLiveRefresh.ts";
import { PHONE, TABLET, chipRef, findChip, useMedia, type ChipRef } from "./layout.ts";

type Toast = { id: number; kind: "error" | "info"; text: string };

// The scripted chat is a development tool. It makes real case writes, so
// only a development build has it: Vite sets import.meta.env.DEV to false
// in `pnpm build`, the branch below is dropped, and the mock module is left
// out of the bundle. A production page ignores ?mockchat=1.
const scriptedChat = () => import.meta.env.DEV && new URLSearchParams(window.location.search).get("mockchat") === "1";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unpaired, setUnpaired] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    if (kind === "info") setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setUnpaired(false);
      setLoadError(null);
    } catch (e) {
      if (isNotPaired(e)) setUnpaired(true);
      else setLoadError(errorSentence(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        if (isNotPaired(e)) setUnpaired(true);
        else toast("error", errorSentence(e));
      }
      await refresh();
    },
    [refresh, toast],
  );

  if (unpaired) {
    return (
      <PairingScreen
        onPaired={() => {
          setToasts([]);
          void refresh();
        }}
      />
    );
  }
  if (!state) {
    return (
      <main className="loading" aria-busy={loadError === null}>
        <p role={loadError ? "alert" : "status"}>{loadError ?? "Loading your case…"}</p>
      </main>
    );
  }
  return <Shell state={state} run={run} refresh={refresh} toast={toast} toasts={toasts} setToasts={setToasts} onNotPaired={() => setUnpaired(true)} />;
}

function Shell({
  state,
  run,
  refresh,
  toast,
  toasts,
  setToasts,
  onNotPaired,
}: {
  state: AppState;
  run: Run;
  refresh: () => Promise<void>;
  toast: (kind: Toast["kind"], text: string) => void;
  toasts: Toast[];
  setToasts: (f: (t: Toast[]) => Toast[]) => void;
  onNotPaired: () => void;
}) {
  const scripted = useMemo(scriptedChat, []);
  const transport: ChatTransport = useMemo(() => (import.meta.env.DEV && scripted ? createMockTransport({ api, storage: sessionStorage }) : realTransport), [scripted]);
  const { chat, send, streaming } = useChat(transport, `${state.live.generation}:${state.live.seq}`, onNotPaired, () => void refresh());
  const [view, setView] = useState<"chat" | "schedule">("chat");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>("schedule");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<FixtureScenario["messages"]>([]);
  const sheetToggle = useRef<HTMLButtonElement>(null);
  const chatTab = useRef<HTMLButtonElement>(null);
  const phone = useMedia(PHONE);
  const tablet = useMedia(TABLET);
  // The tablet sheet is a modal dialog while it is open: the rest of the
  // page is inert (review 2, B4).
  const sheetModal = tablet && sheetOpen;
  // The fact chip that opened the schedule. Focus goes back to it when the
  // schedule closes: the tablet sheet, or the phone back to Chat.
  const returnTo = useRef<ChipRef | null>(null);

  const giveBackFocus = (fallback: HTMLElement | null) => {
    const ref = returnTo.current;
    returnTo.current = null;
    // After React has rendered the chat again.
    requestAnimationFrame(() => ((ref ? findChip(document, ref) : null) ?? fallback)?.focus());
  };
  // Closes the schedule where it covers the chat: the tablet sheet, or the
  // phone's Schedule view, which goes back to Chat (review 2, B3).
  const closeSchedule = () => {
    if (phone) {
      setView("chat");
      giveBackFocus(chatTab.current);
    } else {
      setSheetOpen(false);
      giveBackFocus(sheetToggle.current);
    }
  };
  const closeRef = useRef(closeSchedule);
  closeRef.current = closeSchedule;
  const openSheet = () => {
    setSheetOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById("panel-title")?.focus()));
  };

  useEffect(() => {
    void api.fixtures().then(
      (s) => setFixtures(s.flatMap((x) => x.messages).filter((m, i, all) => all.findIndex((y) => y.id === m.id) === i)),
      () => setFixtures([]),
    );
  }, []);

  // Escape closes the tablet sheet, and on a phone goes from Schedule back
  // to Chat. An open dialog, such as the import sheet, takes Escape first.
  const escapeCloses = (tablet && sheetOpen) || (phone && view === "schedule");
  useEffect(() => {
    if (!escapeCloses) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [escapeCloses]);

  // Opens the schedule at one appointment, outlines it and moves focus to
  // it, so a keyboard or screen reader user lands there, not behind the
  // sheet or on a hidden chat.
  const showSlot = (slotKey: string, from?: HTMLElement) => {
    returnTo.current = chipRef(from, slotKey);
    setTab("schedule");
    setView("schedule");
    setSheetOpen(true);
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
  const modeText = scripted ? "Scripted chat" : state.mode === "live" ? "Live model" : "Recorded responses";

  return (
    <div className="app" data-view={view} data-panel={sheetOpen ? "open" : "closed"}>
      <header className="topbar" inert={sheetModal}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="calendar" />
          </span>
          <h1>Appointment assistant</h1>
        </div>
        <span className="mode-pill" title="Where the assistant's answers come from">
          <Icon name={scripted ? "chat" : "sparkle"} size="sm" />
          <span className="mode-long">{modeText}</span>
        </span>
        <button
          ref={sheetToggle}
          type="button"
          className="btn btn-ghost sheet-toggle"
          aria-expanded={sheetOpen}
          aria-controls="schedule-panel"
          onClick={() => (sheetOpen ? closeSchedule() : openSheet())}
        >
          <Icon name="panel" /> Schedule
          {waiting > 0 && <span className="count">{waiting}</span>}
        </button>
      </header>
      <main className="main">
        <div className="chat-slot" inert={sheetModal}>
        <ChatView
          state={state}
          run={run}
          chat={chat}
          streaming={streaming}
          scripted={scripted}
          send={send}
          onShowSlot={showSlot}
          onLoadCalendar={loadCalendar}
          onLoadDemo={loadDemo}
          fixtures={fixtures}
        />
        </div>
        <button type="button" className="scrim" aria-label="Close the schedule" tabIndex={-1} onClick={closeSchedule} />
        <aside
          id="schedule-panel"
          className="panel"
          aria-label="Schedule"
          role={sheetModal ? "dialog" : undefined}
          aria-modal={sheetModal || undefined}
        >
          <SchedulePanel
            state={state}
            run={run}
            tab={tab}
            onTab={setTab}
            highlight={highlight}
            onClose={closeSchedule}
          />
        </aside>
      </main>
      <div className="tabbar" role="tablist" aria-label="Views">
        <button
          ref={chatTab}
          type="button"
          role="tab"
          aria-selected={view === "chat"}
          onClick={(e) => {
            setView("chat");
            if (returnTo.current) giveBackFocus(e.currentTarget);
          }}
        >
          <Icon name="chat" /> Chat
        </button>
        <button type="button" role="tab" aria-selected={view === "schedule"} onClick={() => setView("schedule")}>
          <Icon name="calendar" /> Schedule
          {waiting > 0 && <span className="count">{waiting}</span>}
        </button>
      </div>
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
  );
}
