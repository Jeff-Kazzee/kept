// The chat column: a centered thread, the streamed turn and the floating
// composer. Assistant text is plain text on the page, labeled as model
// output quietly and the same way every time. The scripted chat
// (?mockchat=1) labels its text as scripted. Tool activity shows as quiet
// lines while a turn runs and folds into one line when it ends. What the
// agent did shows as receipts with Undo. Every card renders from the live
// case view.
import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Mark } from "../components/Art.tsx";
import { MALFORMED_TEXT, MODEL_UNAVAILABLE_TEXT, PARTIAL_TEXT, PASTE_TURN_NOTICE, TOKEN_LIMIT_TEXT, TOOL_LIMIT_TEXT, UNGROUNDED_TEXT } from "../../src/agent/types.ts";
import { usageStopText } from "../../src/model/usage-text.ts";
import { api, type AppState, type FixtureScenario } from "../api.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { onDemand } from "../components/onDemand.tsx";
import { Icon } from "../components/Icon.tsx";
import { canUndo, entriesById, useAgent } from "../agent/AgentContext.tsx";
import { ModelPicker, modelLabel, providerNeedsSetup } from "../agent/ModelPicker.tsx";
import { Receipts } from "../agent/Receipts.tsx";
import { DEFAULT_EXTRACTION_EFFORT, PartlyDoneError, clockTime, emailTime, reasonOnly, shortTime } from "../format.ts";
import { senderShown } from "../case/Source.tsx";
import { ClaimsCard, ExplanationCard, OwnReportCard, QuestionCard, ReplyCard } from "../case/lazyCards.tsx";
import type { ActivityEntry } from "../contract.ts";
import { Composer } from "./Composer.tsx";
import { DEMO_IDS, nextDemoMessage } from "./demo.ts";
import type { ImportRequest } from "./ImportSheet.tsx";
import { turnLost, type ChatState, type PendingTurn, type ToolLine } from "./state.ts";
import type { Card, ChatMessage, FactChip } from "./types.ts";

// 0019, P18: the import sheet loads when it first opens.
const sheet = onDemand(() => import("./ImportSheet.tsx"));
export const loadImportSheet = sheet.ensure;
const ImportSheet = sheet.part((m) => m.ImportSheet, "ImportSheet", null);

// 0019, P19: the composer's text lives in a small store, so typing renders
// the composer only, never the transcript.
export type DraftStore = { get(): string; set(next: string | ((d: string) => string)): void; subscribe(f: () => void): () => void };
export function createDraft(initial = ""): DraftStore {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const v = typeof next === "function" ? next(value) : next;
      if (v === value) return;
      value = v;
      for (const f of subs) f();
    },
    subscribe(f) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

export type ChatViewProps = {
  state: AppState;
  run: Run;
  chat: ChatState;
  streaming: boolean;
  scripted: boolean;
  send: (text: string) => Promise<void>;
  // Stops following the running turn.
  onStop?: () => void;
  onShowSlot: (slotKey: string, from?: HTMLElement) => void;
  onLoadCalendar: (file: File) => Promise<void>;
  onLoadDemo: () => Promise<FixtureScenario["messages"][number] | null>;
  fixtures: FixtureScenario["messages"];
  // 0019, P19: how many of the newest messages the first render draws. The
  // older ones render right after the first paint, in a transition, above
  // what is in view. Unset: all at once.
  firstWindow?: number;
  // A page the server rendered opens as a reversed column (P30).
  opensFromServer?: boolean;
  // Loads the fixtures when the import sheet opens (0019, P17).
  loadFixtures?: () => Promise<unknown>;
  // What the composer says when no provider is set, such as "No model set".
  modelLabel?: string | null;
};

export function ChatView(props: ChatViewProps) {
  const { state, run, chat, streaming, scripted, send, onStop, onShowSlot, onLoadCalendar, onLoadDemo, fixtures, loadFixtures, modelLabel = null, firstWindow, opensFromServer = false } = props;
  // 0019, round 3: the older messages join in steps of WINDOW_STEP, each a
  // transition after a pause, so no single task draws them all.
  const [shown, setShown] = useState(firstWindow ?? Number.POSITIVE_INFINITY);
  const windowed = shown < chat.messages.length;
  useEffect(() => {
    if (!windowed) return;
    const t = setTimeout(() => startTransition(() => setShown((n) => n + WINDOW_STEP)), WINDOW_PAUSE_MS);
    return () => clearTimeout(t);
  }, [windowed, shown]);
  const from = windowed ? Math.max(0, chat.messages.length - shown) : 0;
  // Round 2, finding 5: turns out of view are skipped only once every turn
  // has been laid out, a frame after the whole thread rendered.
  const [settled, setSettled] = useState(false);
  // Muse round 2, finding 4: two frames, so the turns were laid out and
  // painted once, and each keeps its real size, not the estimate.
  useEffect(() => {
    if (windowed || settled) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setSettled(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [windowed, settled]);
  const { activity } = useAgent();
  const draft = useRef<DraftStore | null>(null);
  draft.current ??= createDraft();
  const drafts = draft.current;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const unavailable = chat.status === "unavailable";

  // Office messages added through the import sheet, each shown as a claims
  // card after the chat message that was last when it was added.
  const [imports, setImports] = useState<Array<{ messageId: string; after: number }>>([]);
  const [importing, setImporting] = useState<ImportRequest | null>(null);
  // The sheet reads the fixtures when it opens, to know a demo message, so
  // they load first (0019, P17).
  const loadFixturesRef = useRef(loadFixtures);
  loadFixturesRef.current = loadFixtures;
  const openImport = useCallback((text: string) => {
    void Promise.all([loadFixturesRef.current?.(), loadImportSheet()]).finally(() => setImporting({ text }));
  }, []);
  // The shell's callback changes with each render of the shell. Turns get
  // one that does not, so a memoized turn is not rendered again for it.
  const showSlotRef = useRef(onShowSlot);
  showSlotRef.current = onShowSlot;
  const showSlot = useCallback((k: string, from?: HTMLElement) => showSlotRef.current(k, from), []);

  // A turn the server did not store gives its text back to the composer.
  const lostTurn = turnLost(chat.pending) ? chat.pending : null;
  const restored = useRef<PendingTurn | null>(null);
  useEffect(() => {
    if (lostTurn && restored.current !== lostTurn) {
      restored.current = lostTurn;
      drafts.set((d) => (d.trim() === "" ? lostTurn.userText : d));
    }
  }, [lostTurn]);

  // Follow the newest content while the user has not scrolled away.
  // Scrolled up, new content shows a "New messages" pill instead. Once a
  // turn ends, the view stops where the newest answer starts, so a long
  // card after it never pushes its words out of view (0017, E3).
  const content = `${chat.messages.length}:${chat.pending?.text.length ?? 0}:${chat.pending?.cards.length ?? 0}:${chat.pending?.tools.length ?? 0}:${chat.pending?.actions.length ?? 0}:${chat.pending?.status ?? ""}`;
  const [unseen, setUnseen] = useState(false);
  // Where the app last scrolled to, so its own scroll is not read as the
  // person scrolling away.
  const placed = useRef<number | null>(null);
  // 0019, P19: layout is read once, in the next frame, after React has
  // written the DOM, never in the middle of a commit. The one exception is
  // the first time the thread has content: it opens at its end before the
  // first paint, so the newest answer is the first thing drawn.
  const streamingNow = chat.pending?.status === "streaming";
  // 0019, P30: until then a server-rendered thread opens at its end in the
  // first paint, before any script: a reversed column (styles.css,
  // data-opening), which a browser scrolls from its end. A server-rendered
  // page keeps it until the person scrolls or the thread changes, and then
  // leaves it with the view where it was (P31). Leaving it at hydration
  // would lay the thread out anew and repaint it. The stop at an answer's
  // start (0017, E3) is for a turn that just ended.
  const opened = useRef(false);
  const keepOpening = useRef(false);
  const followedOnce = useRef(false);
  const [opening, setOpening] = useState(opensFromServer);
  const leaveOpening = () => {
    const el = threadRef.current;
    if (!el || !el.hasAttribute("data-opening")) return;
    // In a reversed column the offset counts up from the end, as zero or less.
    const fromEnd = Math.abs(el.scrollTop);
    el.removeAttribute("data-opening");
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - fromEnd);
    placed.current = el.scrollTop;
    setOpening(false);
  };
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (opened.current || !el || chat.messages.length === 0) return;
    opened.current = true;
    if (el.hasAttribute("data-opening") && el.closest("[data-server-rendered]") !== null) {
      keepOpening.current = true;
      return;
    }
    el.removeAttribute("data-opening");
    el.scrollTop = followTop(el, false);
    placed.current = el.scrollTop;
    setOpening(false);
  }, [chat.messages.length]);
  // When older messages join the first render's window, at each step, the
  // view stays where it was, in the same commit, so nothing in view moves.
  const steps = useRef(shown);
  useLayoutEffect(() => {
    const el = threadRef.current;
    const grew = shown !== steps.current;
    steps.current = shown;
    // A server-rendered page keeps where it opened: the browser anchors the
    // view while the older messages go in above it.
    if (!grew || firstWindow === undefined || !el || !opened.current || !pinned.current || keepOpening.current) return;
    el.scrollTop = followTop(el, false);
    placed.current = el.scrollTop;
  }, [shown, firstWindow]);
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (!pinned.current) {
      setUnseen(true);
      return;
    }
    // The follow on mount leaves a server-rendered page where it opened. A
    // later change leaves the opening first.
    if (keepOpening.current && el.hasAttribute("data-opening")) {
      if (!followedOnce.current) {
        followedOnce.current = true;
        return;
      }
      keepOpening.current = false;
      leaveOpening();
    }
    const frame = requestAnimationFrame(() => {
      el.scrollTop = followTop(el, streamingNow);
      placed.current = el.scrollTop;
    });
    return () => cancelAnimationFrame(frame);
  }, [content]);
  const toBottom = () => {
    leaveOpening();
    const el = threadRef.current;
    if (!el) return;
    pinned.current = true;
    setUnseen(false);
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: still ? "auto" : "smooth" });
  };

  const submit = async (text: string) => {
    if (text.trim() === "" || streaming || unavailable) return;
    drafts.set("");
    pinned.current = true;
    await send(text);
  };

  const fill = (text: string) => {
    drafts.set(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  // 0017, E3: one full facts card per office message in the thread.
  // 0019, P6: each answer shows only the chips for times that are new or
  // changed since the thread last showed them. Chips still come from code.
  const shownChips = useMemo(() => freshChips(chat.messages), [chat.messages]);
  const pendingChips = useMemo(() => (chat.pending ? freshChips([...chat.messages, { id: PENDING_MESSAGE, chips: chat.pending.chips }]).get(PENDING_MESSAGE) ?? NO_CHIPS : NO_CHIPS), [chat.messages, chat.pending]);
  // Kept while their inputs hold, so memoized turns see the same values.
  const offers = useMemo(() => newestOffers(chat), [chat.messages, chat.pending]);
  const inCase = state.messages.map((m) => m.id).join("|");
  const facts = useMemo(() => factsCards(imports, chat, new Set(inCase.split("|")), offers), [imports, chat.messages, chat.pending, inCase, offers]);

  const demo = nextDemoMessage(fixtures, state);
  const demoStarted = state.messages.some((m) => DEMO_IDS.includes(m.id));
  const openConflict = state.case.question === null && state.case.conflicts.some((c) => c.status === "open" && c.askable && c.archivedSlotKeys.length === 0);
  const nothingWaits = state.evidence.every((e) => e.status !== "pending") && state.case.question === null && state.case.reply.draft === null;
  // While the stored chat loads, the thread shows a quiet placeholder, not
  // the welcome, so a case with a chat never flashes it (0019, P15).
  const loading = chat.status === "loading";
  const empty = !loading && chat.messages.length === 0 && chat.pending === null;
  const suggestions: Array<{ label: string; act: () => void }> = [];
  if (demoStarted && demo && nothingWaits) suggestions.push({ label: `Next demo message: ${demo.from}`, act: () => fill(demo.text) });
  if (openConflict) suggestions.push({ label: "What should I do about the change?", act: () => void submit("What should I do about the change?") });
  if (state.case.slots.length > 0) suggestions.push({ label: "What is confirmed?", act: () => void submit("What is confirmed?") });
  if (state.case.reply.draft) suggestions.push({ label: "Show my reply draft", act: () => void submit("Show my reply draft") });

  return (
    <section className="chat" aria-label="Chat">
      <div
        className="thread"
        data-settled={settled || undefined}
        data-opening={opening || undefined}
        ref={threadRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.hasAttribute("data-opening")) {
            keepOpening.current = false;
            leaveOpening();
          }
          if (placed.current !== null && Math.abs(el.scrollTop - placed.current) < 2) return;
          placed.current = null;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (pinned.current) setUnseen(false);
        }}
      >
        <div className="thread-inner">
          {/* Card headings in the thread are h3, so the thread has its h2. */}
          {!empty && <h2 className="sr-only">Conversation</h2>}
          {loading && (
            <div className="thread-loading" aria-busy="true">
              <span className="skeleton-line w-60" />
              <span className="skeleton-line w-80" />
              <span className="skeleton-line w-40" />
            </div>
          )}
          {empty && (
            <Welcome
              unavailable={unavailable}
              onPaste={() => fill("")}
              onAsk={(q) => void submit(q)}
              onDemo={async () => {
                const first = await onLoadDemo();
                if (first) fill(first.text);
              }}
            />
          )}
          {imports.filter((x) => x.after === 0).map((x) => (
            <ImportedItem key={x.messageId} messageId={x.messageId} state={state} run={run} place={facts.get(`import:${x.messageId}`)} />
          ))}
          {chat.messages.map((m, i) => i < from ? null : (
            <div key={m.id} className={`msg-group${m.role === "user" ? " is-user" : ""}${needsPerson(m, state) || (shownChips.get(m.id) ?? NO_CHIPS).length > 0 || entriesById(activity, m.actions ?? []).some(canUndo) ? " has-action" : ""}`}>
              <MessageItem
                message={m}
                state={state}
                run={run}
                scripted={scripted}
                tools={chat.toolsByMessage[m.id]}
                onShowSlot={showSlot}
                importText={offersImport(m, userTextBefore(chat, i)) ? (m.declined ? declinedOriginal(chat, i) : userTextBefore(chat, i)) : null}
                chips={shownChips.get(m.id) ?? NO_CHIPS}
                openImport={openImport}
                facts={facts}
                offers={offers}
              />
              {imports
                .filter((x) => x.after === i + 1)
                .map((x) => (
                  <ImportedItem key={x.messageId} messageId={x.messageId} state={state} run={run} place={facts.get(`import:${x.messageId}`)} />
                ))}
            </div>
          ))}
          {chat.pending && <PendingItem chips={pendingChips} turn={chat.pending} state={state} run={run} scripted={scripted} onShowSlot={showSlot} onImport={() => openImport(chat.pending?.userText ?? "")} facts={facts} offers={offers} />}
        </div>
      </div>
      <div className="composer-wrap">
        <div className="composer-inner">
          {/* 0019, P8: one row of the composer's own area, on its solid
              ground, never over the transcript. It keeps its height while
              empty, so the composer does not move when chips come and go.
              The New messages pill takes the row while it shows. It is
              there on an empty case too, so the first message does not
              move the composer. */}
          {(
            <div className="followups">
              {unseen ? (
                <button type="button" className="new-pill" onClick={toBottom}>
                  <Icon name="arrowDown" size="sm" /> New messages
                </button>
              ) : (
                !empty &&
                suggestions.length > 0 &&
                !streaming && (
                  <div className="chips followup-chips" role="group" aria-label="Suggestions">
                    {suggestions.slice(0, 3).map((s) => (
                      <button key={s.label} type="button" className="chip chip-followup" onClick={s.act}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
          )}
          <DraftComposer
            drafts={drafts}
            onSend={(text) => void submit(text)}
            disabled={unavailable}
            busy={streaming}
            inputRef={inputRef}
            onLoadCalendar={onLoadCalendar}
            onAddOfficeMessage={() => {
              openImport(drafts.get());
            }}
            model={<ModelPicker fallback={modelLabel ?? "No model set"} scripted={scripted} />}
            onStop={onStop}
          />
          <p className="composer-hint">Enter sends. Shift+Enter adds a line. The assistant acts on your case, and every action has Undo.</p>
        </div>
      </div>
      {importing && (
        <>
          <ImportSheet
        request={importing}
        run={run}
        fixtures={fixtures}
        importedIds={new Set(state.messages.map((m) => m.id))}
        onClose={() => setImporting(null)}
        onImported={(messageId) => {
          // Fix round 1, R5: one entry per message, so its card keeps one place.
          setImports((all) => (all.some((x) => x.messageId === messageId) ? all : [...all, { messageId, after: chat.messages.length }]));
          if (importing && importing.text === drafts.get()) drafts.set("");
          setImporting(null);
          pinned.current = true;
        }}
          />
        </>
      )}
      <div className="sr-only" aria-live="polite">
        {chat.pending?.status === "streaming" ? (chat.pending.tools.findLast((t) => t.ok === null)?.label ?? "The assistant is checking its answer.") : chat.pending?.error ? chat.pending.error.message : ""}
      </div>
    </section>
  );
}

// The composer, subscribed to the draft store, so a key press renders it
// alone (0019, P19).
// 0019, round 3: the field keeps its own text, so a key press renders
// nothing here (Composer, `drafts`).
function DraftComposer({ drafts, onSend, ...rest }: { drafts: DraftStore; onSend: (text: string) => void } & Omit<Parameters<typeof Composer>[0], "value" | "onChange" | "onSend" | "drafts">) {
  return <Composer drafts={drafts} onSend={() => onSend(drafts.get())} {...rest} />;
}

export const STARTERS = ["What is confirmed?", "What should I bring?"];

// 0019, P9: the three ways in on an empty case.
export const GMAIL_ASK = "Check my Gmail for appointment changes";

function Welcome({ unavailable, onPaste, onAsk, onDemo }: { unavailable: boolean; onPaste: () => void; onAsk: (q: string) => void; onDemo: () => void }) {
  return (
    <div className="welcome">
      <span className="welcome-mark" aria-hidden="true">
        <Mark size={28} />
      </span>
      <h2 className="display">What changed with your appointments?</h2>
      <p className="welcome-lede">Paste a message from the office, or let the assistant check your email. It keeps your schedule up to date and shows each thing it did, with Undo.</p>
      {unavailable ? (
        <p className="notice">
          <Icon name="info" />
          <span>
            The chat is not available in this build yet. Your schedule works as usual, and the attach button below adds a message from the office.
            {/* Only a development build has the scripted chat (App.tsx). */}
            {import.meta.env.DEV && " To try the scripted chat, open this page with ?mockchat=1 at the end of the address."}
          </span>
        </p>
      ) : (
        <>
          <div className="starts" role="group" aria-label="Ways to start">
            <button type="button" className="start-card" onClick={() => onAsk(GMAIL_ASK)}>
              <span className="start-icon" aria-hidden="true">
                <Icon name="mail" />
              </span>
              <span className="start-text">
                <strong>{GMAIL_ASK}</strong>
                <small>The assistant searches Gmail for messages about appointments.</small>
              </span>
            </button>
            <button type="button" className="start-card" onClick={onPaste}>
              <span className="start-icon" aria-hidden="true">
                <Icon name="message" />
              </span>
              <span className="start-text">
                <strong>Paste a message from the office</strong>
                <small>A text or an email. It keeps its lines.</small>
              </span>
            </button>
            <button type="button" className="start-card" onClick={onDemo}>
              <span className="start-icon" aria-hidden="true">
                <Icon name="sparkle" />
              </span>
              <span className="start-text">
                <strong>Try the demo</strong>
                <small>Four made-up messages from Lantern Hill Clinic and a made-up calendar. The assistant is live: it reads them with the model you set up in Connections.</small>
              </span>
            </button>
          </div>
          <ConnectionStatus />
        </>
      )}
    </div>
  );
}

// 0019, P9: where the connections stand, in one quiet line, with the way to
// change them.
export function ConnectionStatus() {
  const { settings, settingsAvailable, google, openConnections } = useAgent();
  const model = settingsAvailable ? modelLabel(settings) : null;
  const ready = settingsAvailable && model !== null && !providerNeedsSetup(settings);
  const gmail = google?.connected && google.gmail;
  // 0021: on the hosted site, an account with no Google of its own uses
  // the shared demo Gmail and Calendar. Never its address.
  const demo = google?.demo ?? null;
  const on = demo ? demo.connected : gmail;
  const words = demo ? (demo.connected ? "Demo Gmail and Calendar" : "Demo Gmail needs reconnecting") : gmail ? `Gmail connected${google?.email ? ` as ${google.email}` : ""}` : "Google not connected";
  return (
    <p className="connection-status small">
      <span className={`status-dot${on ? " is-on" : ""}`} aria-hidden="true" />
      <span>{words}</span>
      <span className={`status-dot${ready ? " is-on" : ""}`} aria-hidden="true" />
      <span>{ready ? model : "No model set up"}</span>
      <button type="button" className="link-btn" onClick={openConnections}>
        Connections
      </button>
    </p>
  );
}

// 0019, P5: the turn's quiet line, once, under its words and actions: the
// steps it took (folded), what wrote the words, and the time. The time
// shows as a clock time, with the full date on hover and, for a keyboard,
// while focus is anywhere in the turn. Screen readers hear the full time.
function TurnMeta({ scripted, at, tools }: { scripted: boolean; at?: string; tools?: ToolLine[] }) {
  return (
    <div className="turn-meta">
      {tools && tools.length > 0 && <ToolSummary tools={tools} />}
      {/* Only the scripted chat says scripted. Its full words stay for
          screen readers and on hover. */}
      {scripted ? (
        <span className="model-tag" title="Scripted demo reply, not a model">
          Scripted<span className="sr-only"> demo reply, not a model</span>
        </span>
      ) : (
        <span className="model-tag">Model output</span>
      )}
      {at && (
        <time className="turn-time" dateTime={at} title={shortTime(at)} data-full={shortTime(at)}>
          <span aria-hidden="true">{clockTime(at)}</span>
          <span className="sr-only">{shortTime(at)}</span>
        </time>
      )}
    </div>
  );
}

function UserBubble({ text, at }: { text: string; at: string }) {
  return (
    <div className="msg msg-user">
      <div className="bubble">{text}</div>
      <div className="msg-meta">
        <span className="sr-only">You</span>
        <time dateTime={at}>{shortTime(at)}</time>
      </div>
    </div>
  );
}

function Declined({ text, onImport }: { text: string; onImport?: () => void }) {
  return (
    <div className="declined" role="note">
      <Icon name="shield" />
      <div className="stack-sm">
        <strong className="small">Outside this app's scope</strong>
        <p>{text}</p>
        <ImportOffer onImport={onImport} />
      </div>
    </div>
  );
}

// The words of the user message just before a declined answer, as this
// page kept them. Empty after a reload, because the server stores a fixed
// sentence in their place.
function userTextBefore(chat: ChatState, index: number): string {
  const before = chat.messages[index - 1];
  return before && before.role === "user" ? before.text : "";
}

function declinedOriginal(chat: ChatState, index: number): string {
  const before = chat.messages[index - 1];
  return before && before.role === "user" ? (chat.declinedText[before.id] ?? "") : "";
}

function ImportedItem({ messageId, state, run, place }: { messageId: string; state: AppState; run: Run; place?: FactsPlace }) {
  return (
    <article className="msg msg-assistant" aria-label="Office message you added">
      <div className="msg-meta">
        <span className="avatar avatar-you" aria-hidden="true">
          <Icon name="message" size="sm" />
        </span>
        <span className="msg-who">You added an office message</span>
      </div>
      <FactsCard messageId={messageId} evidenceIds={[]} state={state} run={run} place={place} />
    </article>
  );
}

// 0017, E3. A facts card renders the message's facts from the live case
// view, so a second card for the same message in the thread is the same
// card. The first keeps its place, and each later one is a short line that
// points to it.
export type FactsPlace = { anchor: string; repeat: boolean };

const factsKey = (chatMessageId: string, index: number) => `${chatMessageId}:${index}`;

// The facts cards of the thread, in the order it shows them: the imports
// before the first message, then each message and the imports after it,
// then the turn being streamed.
// Fix round 1, R4: the newest card offering each email, by its place in
// the thread. An older card for the same email shows nothing, so one email
// never has two "Add it" buttons, and an Undo of its import brings back
// only the newest.
export function newestOffers(chat: Pick<ChatState, "messages" | "pending">): Set<string> {
  const newest = new Map<string, string>();
  const scan = (id: string, cards: Card[]) => cards.forEach((c, j) => c.kind === "gmail_waiting" && newest.set(c.gmailId, factsKey(id, j)));
  chat.messages.forEach((m) => scan(m.id, m.cards));
  if (chat.pending) scan(PENDING_MESSAGE, chat.pending.cards);
  return new Set(newest.values());
}

// An email a turn offered with "Add it" has its facts card in the same place
// once it is in the case (`inCase`, 0018, H2).
export function factsCards(
  imports: Array<{ messageId: string; after: number }>,
  chat: Pick<ChatState, "messages" | "pending">,
  inCase: ReadonlySet<string> = new Set(),
  offers?: ReadonlySet<string>,
): Map<string, FactsPlace> {
  const out = new Map<string, FactsPlace>();
  const first = new Map<string, string>();
  const add = (key: string, messageId: string) => {
    // Fix round 1, R5: a later entry with the same key never takes the
    // first card's place, so a pointer always points at a rendered card.
    if (out.has(key)) return;
    const anchor = first.get(messageId);
    if (anchor) out.set(key, { anchor, repeat: true });
    else {
      const id = `facts-${first.size + 1}`;
      first.set(messageId, id);
      out.set(key, { anchor: id, repeat: false });
    }
  };
  const importsAfter = (n: number) => imports.filter((x) => x.after === n).forEach((x) => add(`import:${x.messageId}`, x.messageId));
  importsAfter(0);
  const cardFacts = (id: string, c: Card, j: number) => {
    if (c.kind === "claims") add(factsKey(id, j), c.messageId);
    else if (c.kind === "gmail_waiting" && inCase.has(c.messageId) && (!offers || offers.has(factsKey(id, j)))) add(factsKey(id, j), c.messageId);
  };
  chat.messages.forEach((m, i) => {
    m.cards.forEach((c, j) => cardFacts(m.id, c, j));
    importsAfter(i + 1);
  });
  chat.pending?.cards.forEach((c, j) => cardFacts(PENDING_MESSAGE, c, j));
  return out;
}

function FactsCard({ messageId, evidenceIds, state, run, fresh = false, place }: { messageId: string; evidenceIds: string[]; state: AppState; run: Run; fresh?: boolean; place?: FactsPlace }) {
  if (place?.repeat) return <FactsPointer messageId={messageId} anchor={place.anchor} state={state} />;
  // Fix round 1, R6: the card's heading carries the anchor, so "Show the
  // card" lands on words a screen reader reads.
  return <ClaimsCard messageId={messageId} evidenceIds={evidenceIds} state={state} run={run} fresh={fresh} headingId={place?.anchor} />;
}

function FactsPointer({ messageId, anchor, state }: { messageId: string; anchor: string; state: AppState }) {
  const view = state.messages.find((m) => m.id === messageId);
  const sender = view ? senderShown(view, state) : null;
  const waiting = view ? [...view.evidenceIds, ...view.manualEvidenceIds].filter((id) => state.evidence.find((e) => e.id === id)?.status === "pending").length : 0;
  const show = () => {
    const el = document.getElementById(anchor);
    if (!el) return;
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
  };
  // Fix round 2, F6: a message no longer in the case has no card to show,
  // so the line says so and offers no button.
  if (!view) {
    return (
      <p className="facts-pointer small">
        <Icon name="message" size="sm" />
        <span>This message is no longer in the case.</span>
      </p>
    );
  }
  return (
    <p className="facts-pointer small">
      <Icon name="message" size="sm" />
      <span>
        The facts from {sender} are in the card above.
        {waiting > 0 && ` ${waiting === 1 ? "1 waits" : `${waiting} wait`} for you there.`}
      </span>
      <button type="button" className="link-btn" onClick={show}>
        Show the card
      </button>
    </p>
  );
}

// The scroll position that follows the thread. While a turn streams, the
// end. Otherwise the end, but never past the start of the newest answer, so
// its first words stay in view.
export function followTop(el: HTMLElement, streaming: boolean): number {
  const end = Math.max(0, el.scrollHeight - el.clientHeight);
  if (streaming) return end;
  const answers = el.querySelectorAll("article.msg-assistant");
  const last = answers[answers.length - 1] as HTMLElement | undefined;
  if (!last) return end;
  const start = last.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12;
  return Math.max(0, Math.min(end, start));
}

const NO_CHIPS: FactChip[] = [];
export const WINDOW_STEP = 8;
export const WINDOW_PAUSE_MS = 16;

// Round 2, finding 5: a turn with a card the person must act on: a reply,
// Muse round 2, finding 4: so is a turn with slot chips or an action that
// can be undone (ChatView adds those).
// a question or its explanation, an Add it offer, a question about their
// own report, or facts that wait for them. Its turn is never skipped.
const ACTION_CARDS = new Set<Card["kind"]>(["reply", "question", "explanation", "gmail_waiting", "own_report"]);
export function needsPerson(m: Pick<ChatMessage, "cards">, state: Pick<AppState, "evidence">): boolean {
  return m.cards.some(
    (c) => ACTION_CARDS.has(c.kind) || (c.kind === "claims" && state.evidence.some((e) => e.messageId === c.messageId && e.status === "pending")),
  );
}

// 0019, P6: the chips each message shows. A chip shows when the thread has
// not shown its time yet, or showed it in another state. A later answer
// that names the same times in the same states shows none. The state is
// the one the chip carried when the answer was written, so the rule does
// not depend on the live case.
export function freshChips(messages: ReadonlyArray<Pick<ChatMessage, "id" | "chips">>): Map<string, FactChip[]> {
  const seen = new Map<string, string>();
  const out = new Map<string, FactChip[]>();
  for (const m of messages) {
    const shown = m.chips.filter((c) => seen.get(c.slotKey) !== c.stateLabel);
    for (const c of m.chips) seen.set(c.slotKey, c.stateLabel);
    out.set(m.id, shown.length === m.chips.length ? m.chips : shown);
  }
  return out;
}

// The message id a chip of the streamed turn carries until the stored
// message replaces it.
export const PENDING_MESSAGE = "pending";

// Each chip carries its message id and slot key, so focus can find the live
// chip again after the thread re-renders (review 2, B6). Keys use the
// position too, because one answer can name a slot twice (B2).
function Extras({
  messageId,
  fresh = false,
  cards,
  chips,
  actions,
  state,
  run,
  onShowSlot,
  facts,
  offers,
  shownText = null,
}: {
  messageId: string;
  fresh?: boolean;
  // The code-written sentence the answer already shows as its notice. A
  // stopped turn also stores it as a notice card, which is shown once
  // (0017, E6).
  shownText?: string | null;
  cards: Card[];
  chips: FactChip[];
  actions: ActivityEntry[];
  state: AppState;
  run: Run;
  onShowSlot: (k: string, from?: HTMLElement) => void;
  facts?: Map<string, FactsPlace>;
  // The waiting-email cards that are each email's newest offer (fix round
  // 1, R4). Without it, every one shows.
  offers?: ReadonlySet<string>;
}): ReactNode {
  // A claims card shows its own receipt, so its facts are not repeated
  // as a second one.
  const withCard = new Set(cards.flatMap((c) => (c.kind === "claims" ? [c.messageId] : [])));
  // 0018, H7: a notice that states an action the receipts above already
  // show, with its Undo, is not shown again.
  const receipted = new Set(actions.map((e) => e.id));
  const repeats = (c: Card) => c.kind === "notice" && c.activityId !== undefined && receipted.has(c.activityId);
  const waiting = cards.flatMap((c, i) =>
    c.kind === "gmail_waiting" && (!offers || offers.has(factsKey(messageId, i))) ? [{ card: c, place: facts?.get(factsKey(messageId, i)) }] : [],
  );
  return (
    <>
      <Receipts entries={actions} state={state} skipMessages={withCard} />
      {chips.length > 0 && (
        <div className="chips" aria-label="Facts from your schedule">
          {chips.map((c, i) => {
            const live = liveChip(c, state);
            return live.gone ? (
              <button key={`${c.slotKey}:${i}`} type="button" className="chip fact-chip" data-chip-message={messageId} data-chip-slot={c.slotKey} disabled>
                <span>{c.label}</span>
                <small>No longer on your schedule</small>
                <small className="muted">At the time: {c.stateLabel}</small>
              </button>
            ) : (
              <button key={`${c.slotKey}:${i}`} type="button" className="chip fact-chip" data-chip-message={messageId} data-chip-slot={c.slotKey} onClick={(e) => onShowSlot(c.slotKey, e.currentTarget)}>
                <span>{live.label}</span>
                <small>{live.stateLabel}</small>
                <span className="sr-only">Show in schedule.</span>
                {live.stateLabel !== c.stateLabel && <small className="muted">At the time: {c.stateLabel}</small>}
              </button>
            );
          })}
        </div>
      )}
      {cards.map((c, i) =>
        (c.kind === "notice" && shownText !== null && c.text.trim() === shownText) || repeats(c) || c.kind === "gmail_waiting" ? null : (
          <CardView key={i} card={c} state={state} run={run} fresh={fresh} actions={actions} place={facts?.get(factsKey(messageId, i))} />
        ),
      )}
      {waiting.length > 0 && <WaitingEmails emails={waiting} state={state} run={run} fresh={fresh} />}
    </>
  );
}

type WaitingEmail = { card: Extract<Card, { kind: "gmail_waiting" }>; place?: FactsPlace };

// 0018, H2: how the page names the sender of an email offered with "Add it":
// as it names a message in the case from the same sender, else by the name
// code gave when the turn ended, else "the office".
export function waitingSender(card: WaitingEmail["card"], state: Pick<AppState, "evidence" | "messages">): string {
  const same = card.sameSenderAs ? state.messages.find((m) => m.id === card.sameSenderAs) : undefined;
  return same ? senderShown(same, state) : (card.office ?? "the office");
}

// "1 more email from Lantern Hill Clinic, Oct 28, 6:43 PM, isn't in your
// case yet."
export function waitingText(emails: Array<{ sender: string; when: string }>): string {
  if (emails.length === 1) return `1 more email from ${emails[0]!.sender}, ${emails[0]!.when}, isn't in your case yet.`;
  const senders = new Set(emails.map((e) => e.sender));
  return `${emails.length} more emails${senders.size === 1 ? ` from ${emails[0]!.sender}` : ""} aren't in your case yet.`;
}

// 0018, H2: the emails a turn's Gmail search found and did not add, written
// by code. "Add it" is the person's import, with its Undo, and the page then
// reads the email as it reads a paste. An email in the case shows its facts
// card here instead.
function WaitingEmails({ emails, state, run, fresh }: { emails: WaitingEmail[]; state: AppState; run: Run; fresh: boolean }) {
  const inCase = (c: WaitingEmail["card"]) => state.messages.some((m) => m.id === c.messageId);
  const open = emails.filter((e) => !inCase(e.card)).map((e) => ({ ...e, sender: waitingSender(e.card, state), when: emailTime(e.card.receivedAt) }));
  // Fix round 1, R2: a read that fails after the add says so. The email is
  // in the case, and its facts card offers "Read this message".
  const add = (e: { card: WaitingEmail["card"]; sender: string; when: string }) => async () => {
    const message = await api.addGmail(e.card.gmailId);
    try {
      await api.extract(message.id, DEFAULT_EXTRACTION_EFFORT, message.version);
    } catch (err) {
      const reason = reasonOnly(err);
      throw new PartlyDoneError(`Added the email from ${e.sender}, ${e.when}, but it was not read.${reason ? ` ${reason}` : ""} Its card has Read this message.`, err);
    }
  };
  return (
    <>
      {emails
        .filter((e) => inCase(e.card))
        .map((e) => {
          const id = e.card.messageId;
          const m = state.messages.find((x) => x.id === id)!;
          return <FactsCard key={id} messageId={id} evidenceIds={[...m.evidenceIds, ...m.manualEvidenceIds]} state={state} run={run} fresh={fresh} place={e.place} />;
        })}
      {open.length > 0 && (
        <div className="notice waiting-emails" role="note">
          <Icon name="message" />
          <div className="stack-sm">
            <span className="model-tag">Written by code</span>
            <p>{waitingText(open)}</p>
            {open.length === 1 ? (
              <div>
                <ActionButton run={run} action={add(open[0]!)} size="sm" label={`Add the email from ${open[0]!.sender}, ${open[0]!.when}`}>
                  <Icon name="plus" size="sm" /> Add it
                </ActionButton>
              </div>
            ) : (
              <ul className="waiting-list">
                {open.map((e) => (
                  <li key={e.card.gmailId}>
                    <span>
                      {e.sender}, {e.when}
                    </span>
                    <ActionButton run={run} action={add(e)} size="sm" label={`Add the email from ${e.sender}, ${e.when}`}>
                      <Icon name="plus" size="sm" /> Add it
                    </ActionButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// 0019, P19: a finished turn renders again only when its own inputs change:
// the case, the activity, its message or the thread's facts cards. Typing
// in the composer or a new turn below it leaves it as it is.
const MessageItem = memo(function MessageItem({
  message: m,
  state,
  run,
  scripted,
  tools,
  onShowSlot,
  importText,
  openImport,
  facts,
  offers,
  chips,
}: {
  message: ChatMessage;
  state: AppState;
  run: Run;
  scripted: boolean;
  tools?: ToolLine[];
  onShowSlot: (k: string, from?: HTMLElement) => void;
  importText: string | null;
  openImport: (text: string) => void;
  facts?: Map<string, FactsPlace>;
  offers?: ReadonlySet<string>;
  // 0019, P6: the chips this answer shows, new or changed times only.
  chips: FactChip[];
}) {
  const { activity } = useAgent();
  const onImport = importText !== null ? () => openImport(importText) : undefined;
  if (m.role === "user") return <UserBubble text={m.text} at={m.createdAt} />;
  return (
    <article className="msg msg-assistant" aria-label="Assistant">
      {m.declined ? (
        <Declined text={m.text} onImport={onImport} />
      ) : usageStopText(m.text, PARTIAL_TEXT) ? (
        <UsageNotice text={m.text} credits={usageStopText(m.text, PARTIAL_TEXT) === "credits_exhausted"} />
      ) : isCodeSentence(m.text) ? (
        <CodeNotice text={m.text} at={m.createdAt} onImport={onImport} />
      ) : (
        m.text && <p className="assistant-text">{m.text}</p>
      )}
      <Extras
        messageId={m.id}
        shownText={!m.declined && isCodeSentence(m.text) ? m.text.trim() : null}
        cards={m.cards}
        chips={chips}
        actions={entriesById(activity, m.actions ?? [])}
        state={state}
        run={run}
        onShowSlot={onShowSlot}
        facts={facts}
        offers={offers}
      />
      {!m.declined && !usageStopText(m.text, PARTIAL_TEXT) && !isCodeSentence(m.text) && <TurnMeta scripted={scripted} at={m.createdAt} tools={tools} />}
    </article>
  );
});

function PendingItem({
  turn,
  state,
  run,
  scripted,
  onShowSlot,
  onImport,
  facts,
  offers,
  chips,
}: {
  turn: PendingTurn;
  state: AppState;
  run: Run;
  scripted: boolean;
  onShowSlot: (k: string, from?: HTMLElement) => void;
  onImport: () => void;
  facts?: Map<string, FactsPlace>;
  offers?: ReadonlySet<string>;
  chips: FactChip[];
}) {
  const err = turn.error;
  // ungrounded and model_unavailable: the streamed text is a fixed
  // sentence written by code. It is shown once, as a notice.
  const fixed = err !== null && (err.code === "ungrounded" || err.code === "model_unavailable");
  const codeText = fixed ? turn.text.trim() || turnErrorText(err) : isCodeSentence(turn.text) ? turn.text.trim() : null;
  // The chat could not answer. A pasted office message can still go in
  // through the import sheet.
  const offerImport = err !== null && err.code !== "ungrounded" && err.code !== "stale_edit" && looksPasted(turn.userText);
  return (
    <>
      <UserBubble text={turn.userText} at={turn.createdAt} />
      <article className="msg msg-assistant" aria-label="Assistant" aria-busy={turn.status === "streaming"}>
        {err?.code === "out_of_scope" ? (
          <Declined text={turn.text.trim() || err.message} onImport={onImport} />
        ) : err?.code === "provider_not_ready" ? (
          // J12: refused before it started. Code wrote the sentence, and no
          // model ran.
          <SetupNotice text={turnErrorText(err)} />
        ) : err?.code === "credits_exhausted" || err?.code === "usage_paused" ? (
          // 0014: the hosted site's usage stopped the turn. Code wrote the
          // sentence.
          <>
            {turn.status === "streaming" ? <ToolLines tools={turn.tools} /> : <ToolSummary tools={turn.tools} />}
            <UsageNotice text={turnErrorText(err)} credits={err.code === "credits_exhausted"} />
          </>
        ) : (
          <>
            {turn.status === "streaming" && <ToolLines tools={turn.tools} live />}
            {codeText !== null ? (
              <CodeNotice text={codeText} onImport={offerImport ? onImport : undefined} />
            ) : turn.text ? (
              <p className="assistant-text">{turn.text}</p>
            ) : (
              turn.status === "streaming" && (
                <span className="typing" aria-label="The assistant is typing">
                  <span />
                  <span />
                  <span />
                </span>
              )
            )}
          </>
        )}
        <Extras
          messageId={PENDING_MESSAGE}
          fresh
          shownText={codeText}
          cards={turn.cards}
          chips={chips}
          actions={turn.actions}
          state={state}
          run={run}
          onShowSlot={onShowSlot}
          facts={facts}
          offers={offers}
        />
        {codeText !== null && turn.status !== "streaming" && <ToolSummary tools={turn.tools} />}
        {codeText === null && turn.status !== "streaming" && err?.code !== "out_of_scope" && err?.code !== "provider_not_ready" && err?.code !== "credits_exhausted" && err?.code !== "usage_paused" && (
          <TurnMeta scripted={scripted} tools={turn.tools} />
        )}
        {err?.code === "stopped" && (
          <p className="notice" role="status">
            <Icon name="stop" />
            <span>{turnErrorText(err)}</span>
          </p>
        )}
        {err && err.code !== "out_of_scope" && err.code !== "stopped" && err.code !== "provider_not_ready" && err.code !== "credits_exhausted" && err.code !== "usage_paused" && !fixed && (
          <div className="turn-error" role="alert">
            <Icon name="alert" />
            <div className="stack-sm">
              <p>{turnErrorText(err)}</p>
              {offerImport && <ImportOffer onImport={onImport} />}
            </div>
          </div>
        )}
      </article>
    </>
  );
}

// J12: the setup sentence, written by code, with a link to Connections.
export function SetupNotice({ text }: { text: string }) {
  const { openConnections } = useAgent();
  return (
    <div className="notice" role="alert">
      <Icon name="info" />
      <div className="stack-sm">
        <div className="msg-meta">
          <span className="msg-who">Assistant</span>
          <span className="model-tag">Written by code</span>
        </div>
        <p>{text}</p>
        <button type="button" className="btn btn-sm" onClick={openConnections}>
          <Icon name="google" size="sm" /> Open Connections
        </button>
      </div>
    </div>
  );
}

// 0014: a hosted site usage stop, written by code. Credits that ran out
// link to Usage.
export function UsageNotice({ text, credits }: { text: string; credits: boolean }) {
  const { openUsage } = useAgent();
  return (
    <div className="notice" role="alert">
      <Icon name="info" />
      <div className="stack-sm">
        <div className="msg-meta">
          <span className="msg-who">Assistant</span>
          <span className="model-tag">Written by code</span>
        </div>
        <p>{text}</p>
        {credits && (
          <button type="button" className="btn btn-sm" onClick={openUsage}>
            <Icon name="activity" size="sm" /> Open Usage
          </button>
        )}
      </div>
    </div>
  );
}

// 0019, P7: while a turn runs, its steps are a calm live list, with a soft
// shimmer on the step that is running.
function ToolLines({ tools, live = false }: { tools: ToolLine[]; live?: boolean }) {
  if (tools.length === 0) return null;
  return (
    <ul className={`tool-lines${live ? " is-live" : ""}`}>
      {tools.map((t) => (
        <li key={t.callId} className={`tool-line${t.ok === false && !t.declined ? " is-failed" : ""}${t.ok === null ? " is-running" : ""}`}>
          {t.ok === null ? <span className="spinner" aria-hidden="true" /> : t.ok ? <Icon name="check" size="sm" /> : <Icon name={t.declined ? "info" : "alert"} size="sm" />}
          <span>
            {t.label}
            {t.ok === false && (t.declined ? ". It chose not to act." : ". It did not finish.")}
          </span>
        </li>
      ))}
    </ul>
  );
}

// A finished turn's tool lines, folded into one line that opens them.
// A step that chose not to act by a rule is not one that did not finish
// (0018, H6).
export function toolSummaryText(tools: ToolLine[]): string {
  const failed = tools.filter((t) => t.ok === false && !t.declined).length;
  const declined = tools.filter((t) => t.ok === false && t.declined).length;
  const steps = `${tools.length} step${tools.length === 1 ? "" : "s"}`;
  const parts = [failed > 0 ? `${failed} did not finish` : null, declined > 0 ? `${declined} chose not to act` : null].filter(Boolean);
  return [`Worked through ${steps}`, ...parts].join(", ");
}

function ToolSummary({ tools }: { tools: ToolLine[] }) {
  if (tools.length === 0) return null;
  return (
    <details className="tool-summary">
      <summary className="small">{toolSummaryText(tools)}</summary>
      <ToolLines tools={tools} />
    </details>
  );
}

// The fixed sentences the chat's code writes in place of an answer (0007).
// They show as notices written by code, not as model output.
// The paste-turn notice of 0009, D2 is written by code too: an action that
// came with a pasted message waits for the person (`waits_for_person`).
const CODE_SENTENCES = new Set([UNGROUNDED_TEXT, MODEL_UNAVAILABLE_TEXT, TOOL_LIMIT_TEXT, MALFORMED_TEXT, TOKEN_LIMIT_TEXT, PARTIAL_TEXT, PASTE_TURN_NOTICE]);
export const isCodeSentence = (text: string) => CODE_SENTENCES.has(text.trim());

// Text that reads as a pasted message, not a question: more than one line,
// or a long one.
export const looksPasted = (text: string) => text.includes("\n") || text.trim().length >= 60;

// Answers after which a pasted office message can go in through the import
// sheet: the scope decline always (W9), and a failed or unavailable answer
// when the person's text reads as a pasted message.
export const offersImport = (m: ChatMessage, userText: string) => m.declined === true || (m.text.trim() === MODEL_UNAVAILABLE_TEXT && looksPasted(userText));

function ImportOffer({ onImport }: { onImport?: () => void }) {
  if (!onImport) return null;
  return (
    <>
      <p className="small muted">If you pasted a message from the office, add it as an office message instead. The app reads it without the chat.</p>
      <div>
        <button type="button" className="btn" onClick={onImport}>
          <Icon name="message" size="sm" /> Add this as an office message
        </button>
      </div>
    </>
  );
}

function CodeNotice({ text, at, onImport }: { text: string; at?: string; onImport?: () => void }) {
  return (
    <div className="notice" role="note">
      <Icon name="info" />
      <div className="stack-sm">
        <div className="msg-meta">
          <span className="msg-who">Assistant</span>
          <span className="model-tag">Written by code</span>
          {at && <time dateTime={at}>{shortTime(at)}</time>}
        </div>
        <p>{text}</p>
        <ImportOffer onImport={onImport} />
      </div>
    </div>
  );
}

// A fact chip as the case stands now. The chip only names the slot. Its
// label and state come from the live case view, so a chip made when a slot
// was confirmed does not still say so after the slot changed. A slot that
// is gone or archived is no longer on the schedule.
export function liveChip(chip: FactChip, state: Pick<AppState, "case" | "records">): { gone: true } | { gone: false; label: string; stateLabel: string } {
  const slot = state.case.slots.find((x) => x.key === chip.slotKey);
  const archived = state.records.some((r) => r.id === chip.slotKey && r.archived);
  return !slot || archived ? { gone: true } : { gone: false, label: slot.label, stateLabel: slot.stateLabel };
}

// The words for a turn that ended with an error. The server's message is a
// plain sentence. A code with no message gets one here.
export function turnErrorText(err: { code: string; message: string }): string {
  const base = err.message.trim();
  // A stopped turn may still be saved by the server, so it does not say
  // that nothing was.
  if (err.code === "stopped") return base;
  // J12: the setup sentence already says nothing changed. So do the
  // hosted site's usage sentences (0014).
  if ((err.code === "provider_not_ready" || err.code === "credits_exhausted" || err.code === "usage_paused") && base !== "") return base;
  if (base !== "") return err.code === "ungrounded" || base.includes("Nothing was saved") ? base : `${base} Nothing was saved.`;
  switch (err.code) {
    case "case_deleted":
      return "The case was deleted. Nothing was saved.";
    case "busy":
      return "The app is busy. Nothing was saved. Try again in a moment.";
    case "model_unavailable":
      return "The model did not answer. Nothing was saved. Try again in a moment.";
    case "stale_edit":
      return "The chat changed in another tab. It is reloaded. Nothing was saved.";
    case "waits_for_person":
      return PASTE_TURN_NOTICE;
    case "server_error":
      return "The app could not finish that answer. Nothing was saved.";
    default:
      return "The assistant could not answer. Nothing was saved.";
  }
}

// `actions` are the turn's activity entries. A notice that states one of
// them shows when it was undone (0016, L1).
// `place` says where a facts card sits among the thread's (0017, E3).
export function CardView({ card, state, run, fresh = false, actions = [], place }: { card: Card; state: AppState; run: Run; fresh?: boolean; actions?: ActivityEntry[]; place?: FactsPlace }) {
  switch (card.kind) {
    case "claims":
      return <FactsCard messageId={card.messageId} evidenceIds={card.evidenceIds} state={state} run={run} fresh={fresh} place={place} />;
    case "question":
      return <QuestionCard conflictId={card.conflictId} state={state} run={run} />;
    case "explanation":
      return <ExplanationCard conflictId={card.conflictId} state={state} run={run} />;
    case "reply":
      return <ReplyCard draftId={card.draftId} state={state} run={run} />;
    case "own_report":
      return <OwnReportCard messageId={card.messageId} state={state} run={run} />;
    case "gmail_waiting":
      // Shown together by WaitingEmails.
      return null;
    case "notice": {
      // Matched by the activity id. A notice stored before ids were carried
      // falls back to its words.
      const undone = actions.some((e) => e.undone && (card.activityId ? e.id === card.activityId : e.summary === card.text));
      return (
        <div className={`notice${undone ? " is-undone" : ""}`} role="note">
          <Icon name={undone ? "undo" : "info"} />
          <div className="stack-sm">
            <span className="model-tag">Written by code</span>
            <p>
              {undone ? <s>{card.text}</s> : card.text}
              {undone && <span className="sr-only"> (undone)</span>}
            </p>
            {undone && <p className="small">Undone. The activity list shows the undo.</p>}
          </div>
        </div>
      );
    }
  }
}
