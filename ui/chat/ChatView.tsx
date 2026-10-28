// The chat column: a centered thread, the streamed turn and the floating
// composer. Assistant text is plain text on the page, labeled as model
// output quietly and the same way every time. The scripted chat
// (?mockchat=1) labels its text as scripted. Tool activity shows as quiet
// lines while a turn runs and folds into one line when it ends. What the
// agent did shows as receipts with Undo. Every card renders from the live
// case view.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Mark, RidgeScene } from "../components/Art.tsx";
import { MALFORMED_TEXT, MODEL_UNAVAILABLE_TEXT, PARTIAL_TEXT, PASTE_TURN_NOTICE, TOKEN_LIMIT_TEXT, TOOL_LIMIT_TEXT, UNGROUNDED_TEXT } from "../../src/agent/types.ts";
import type { AppState, FixtureScenario } from "../api.ts";
import type { Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { entriesById, useAgent } from "../agent/AgentContext.tsx";
import { ModelPicker } from "../agent/ModelPicker.tsx";
import { Receipts } from "../agent/Receipts.tsx";
import { shortTime } from "../format.ts";
import { ClaimsCard } from "../case/ClaimsCard.tsx";
import { ExplanationCard, QuestionCard } from "../case/ConflictCards.tsx";
import { OwnReportCard } from "../case/OwnReportCard.tsx";
import { ReplyCard } from "../case/ReplyCard.tsx";
import type { ActivityEntry } from "../contract.ts";
import { Composer } from "./Composer.tsx";
import { DEMO_IDS, nextDemoMessage } from "./demo.ts";
import { ImportSheet, type ImportRequest } from "./ImportSheet.tsx";
import { turnLost, type ChatState, type PendingTurn, type ToolLine } from "./state.ts";
import type { Card, ChatMessage, FactChip } from "./types.ts";

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
  // What the composer says when no provider is set, such as "No model set".
  modelLabel?: string | null;
};

export function ChatView(props: ChatViewProps) {
  const { state, run, chat, streaming, scripted, send, onStop, onShowSlot, onLoadCalendar, onLoadDemo, fixtures, modelLabel = null } = props;
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const unavailable = chat.status === "unavailable";

  // Office messages added through the import sheet, each shown as a claims
  // card after the chat message that was last when it was added.
  const [imports, setImports] = useState<Array<{ messageId: string; after: number }>>([]);
  const [importing, setImporting] = useState<ImportRequest | null>(null);
  const openImport = (text: string) => setImporting({ text });

  // A turn the server did not store gives its text back to the composer.
  const lostTurn = turnLost(chat.pending) ? chat.pending : null;
  const restored = useRef<PendingTurn | null>(null);
  useEffect(() => {
    if (lostTurn && restored.current !== lostTurn) {
      restored.current = lostTurn;
      setDraft((d) => (d.trim() === "" ? lostTurn.userText : d));
    }
  }, [lostTurn]);

  // Follow the newest content while the user is at the bottom.
  // Scrolled up, new content shows a "New messages" pill instead.
  const content = `${chat.messages.length}:${chat.pending?.text.length ?? 0}:${chat.pending?.cards.length ?? 0}:${chat.pending?.tools.length ?? 0}:${chat.pending?.actions.length ?? 0}:${chat.pending?.status ?? ""}`;
  const [unseen, setUnseen] = useState(false);
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else setUnseen(true);
  }, [content]);
  const toBottom = () => {
    const el = threadRef.current;
    if (!el) return;
    pinned.current = true;
    setUnseen(false);
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: still ? "auto" : "smooth" });
  };

  const submit = async (text: string) => {
    if (text.trim() === "" || streaming || unavailable) return;
    setDraft("");
    pinned.current = true;
    await send(text);
  };

  const fill = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const demo = nextDemoMessage(fixtures, state);
  const demoStarted = state.messages.some((m) => DEMO_IDS.includes(m.id));
  const openConflict = state.case.question === null && state.case.conflicts.some((c) => c.status === "open" && c.askable && c.archivedSlotKeys.length === 0);
  const nothingWaits = state.evidence.every((e) => e.status !== "pending") && state.case.question === null && state.case.reply.draft === null;
  const empty = chat.messages.length === 0 && chat.pending === null;
  const suggestions: Array<{ label: string; act: () => void }> = [];
  if (demoStarted && demo && nothingWaits) suggestions.push({ label: `Next demo message: ${demo.from}`, act: () => fill(demo.text) });
  if (openConflict) suggestions.push({ label: "What should I do about the change?", act: () => void submit("What should I do about the change?") });
  if (state.case.slots.length > 0) suggestions.push({ label: "What is confirmed?", act: () => void submit("What is confirmed?") });
  if (state.case.reply.draft) suggestions.push({ label: "Show my reply draft", act: () => void submit("Show my reply draft") });

  return (
    <section className="chat" aria-label="Chat">
      <div
        className="thread"
        ref={threadRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (pinned.current) setUnseen(false);
        }}
      >
        <div className="thread-inner">
          {/* Card headings in the thread are h3, so the thread has its h2. */}
          {!empty && <h2 className="sr-only">Conversation</h2>}
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
            <ImportedItem key={x.messageId} messageId={x.messageId} state={state} run={run} />
          ))}
          {chat.messages.map((m, i) => (
            <div key={m.id} className="msg-group">
              <MessageItem
                message={m}
                state={state}
                run={run}
                scripted={scripted}
                tools={chat.toolsByMessage[m.id]}
                onShowSlot={onShowSlot}
                onImport={offersImport(m, userTextBefore(chat, i)) ? () => openImport(m.declined ? declinedOriginal(chat, i) : userTextBefore(chat, i)) : undefined}
              />
              {imports
                .filter((x) => x.after === i + 1)
                .map((x) => (
                  <ImportedItem key={x.messageId} messageId={x.messageId} state={state} run={run} />
                ))}
            </div>
          ))}
          {chat.pending && <PendingItem turn={chat.pending} state={state} run={run} scripted={scripted} onShowSlot={onShowSlot} onImport={() => openImport(chat.pending?.userText ?? "")} />}
        </div>
      </div>
      <div className="composer-wrap">
        <div className="composer-inner">
          {unseen && (
            <button type="button" className="new-pill" onClick={toBottom}>
              <Icon name="arrowDown" size="sm" /> New messages
            </button>
          )}
          {!empty && suggestions.length > 0 && !streaming && (
            <div className="chips" aria-label="Suggestions">
              {suggestions.slice(0, 3).map((s) => (
                <button key={s.label} type="button" className="chip" onClick={s.act}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => void submit(draft)}
            disabled={unavailable}
            busy={streaming}
            inputRef={inputRef}
            onLoadCalendar={onLoadCalendar}
            onAddOfficeMessage={() => {
              openImport(draft);
            }}
            model={<ModelPicker fallback={modelLabel ?? "No model set"} scripted={scripted} />}
            onStop={onStop}
          />
          <p className="composer-hint">Enter sends. Shift+Enter adds a line. The assistant acts on your case, and every action has Undo.</p>
        </div>
      </div>
      <ImportSheet
        request={importing}
        run={run}
        fixtures={fixtures}
        importedIds={new Set(state.messages.map((m) => m.id))}
        onClose={() => setImporting(null)}
        onImported={(messageId) => {
          setImports((all) => [...all, { messageId, after: chat.messages.length }]);
          if (importing && importing.text === draft) setDraft("");
          setImporting(null);
          pinned.current = true;
        }}
      />
      <div className="sr-only" aria-live="polite">
        {chat.pending?.status === "streaming" ? (chat.pending.tools.findLast((t) => t.ok === null)?.label ?? "The assistant is checking its answer.") : chat.pending?.error ? chat.pending.error.message : ""}
      </div>
    </section>
  );
}

export const STARTERS = ["What is confirmed?", "What should I bring?"];

function Welcome({ unavailable, onPaste, onAsk, onDemo }: { unavailable: boolean; onPaste: () => void; onAsk: (q: string) => void; onDemo: () => void }) {
  return (
    <div className="welcome">
      <RidgeScene />
      <span className="welcome-mark" aria-hidden="true">
        <Mark size={24} />
      </span>
      <h2>What changed with your appointments?</h2>
      <p>Paste a message from the office. The assistant keeps your schedule up to date and shows each thing it did, with Undo.</p>
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
          <div className="chips chips-center" aria-label="Ways to start">
            <button type="button" className="chip" onClick={onPaste}>
              <Icon name="message" size="sm" /> Paste a message from the office
            </button>
            {STARTERS.map((q) => (
              <button key={q} type="button" className="chip" onClick={() => onAsk(q)}>
                <Icon name={q.includes("bring") ? "checklist" : "check"} size="sm" /> {q}
              </button>
            ))}
          </div>
          <div className="demo-offer">
            <div className="stack-xs">
              <strong>New here?</strong>
              <span className="small muted">
                Try the demo: four made-up messages from Lantern Hill Clinic and a made-up calendar. The assistant is live: it reads them with the model you set up in
                Settings.
              </span>
            </div>
            <button type="button" className="btn btn-primary" onClick={onDemo}>
              <Icon name="sparkle" size="sm" /> Try the demo
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AssistantHead({ scripted, at }: { scripted: boolean; at?: string }) {
  return (
    <div className="msg-meta">
      <span className="avatar" aria-hidden="true">
        <Icon name="sparkle" size="sm" />
      </span>
      <span className="msg-who">Assistant</span>
      {/* Only the scripted chat says scripted. Its full words stay for
          screen readers and on hover. */}
      {scripted ? (
        <span className="model-tag" title="Scripted demo reply, not a model">
          Scripted<span className="sr-only"> demo reply, not a model</span>
        </span>
      ) : (
        <span className="model-tag">Model output</span>
      )}
      {at && <time dateTime={at}>{shortTime(at)}</time>}
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

function ImportedItem({ messageId, state, run }: { messageId: string; state: AppState; run: Run }) {
  return (
    <article className="msg msg-assistant" aria-label="Office message you added">
      <div className="msg-meta">
        <span className="avatar avatar-you" aria-hidden="true">
          <Icon name="message" size="sm" />
        </span>
        <span className="msg-who">You added an office message</span>
      </div>
      <ClaimsCard messageId={messageId} evidenceIds={[]} state={state} run={run} />
    </article>
  );
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
}: {
  messageId: string;
  fresh?: boolean;
  cards: Card[];
  chips: FactChip[];
  actions: ActivityEntry[];
  state: AppState;
  run: Run;
  onShowSlot: (k: string, from?: HTMLElement) => void;
}): ReactNode {
  // A claims card shows its own receipt, so its facts are not repeated
  // as a second one.
  const withCard = new Set(cards.flatMap((c) => (c.kind === "claims" ? [c.messageId] : [])));
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
      {cards.map((c, i) => (
        <CardView key={i} card={c} state={state} run={run} fresh={fresh} />
      ))}
    </>
  );
}

function MessageItem({
  message: m,
  state,
  run,
  scripted,
  tools,
  onShowSlot,
  onImport,
}: {
  message: ChatMessage;
  state: AppState;
  run: Run;
  scripted: boolean;
  tools?: ToolLine[];
  onShowSlot: (k: string, from?: HTMLElement) => void;
  onImport?: () => void;
}) {
  const { activity } = useAgent();
  if (m.role === "user") return <UserBubble text={m.text} at={m.createdAt} />;
  return (
    <article className="msg msg-assistant" aria-label="Assistant">
      {m.declined ? (
        <Declined text={m.text} onImport={onImport} />
      ) : isCodeSentence(m.text) ? (
        <CodeNotice text={m.text} at={m.createdAt} onImport={onImport} />
      ) : (
        <>
          <AssistantHead scripted={scripted} at={m.createdAt} />
          {tools && <ToolSummary tools={tools} />}
          {m.text && <p className="assistant-text">{m.text}</p>}
        </>
      )}
      <Extras messageId={m.id} cards={m.cards} chips={m.chips} actions={entriesById(activity, m.actions ?? [])} state={state} run={run} onShowSlot={onShowSlot} />
    </article>
  );
}

function PendingItem({
  turn,
  state,
  run,
  scripted,
  onShowSlot,
  onImport,
}: {
  turn: PendingTurn;
  state: AppState;
  run: Run;
  scripted: boolean;
  onShowSlot: (k: string, from?: HTMLElement) => void;
  onImport: () => void;
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
        ) : (
          <>
            {codeText === null && <AssistantHead scripted={scripted} />}
            {turn.status === "streaming" ? <ToolLines tools={turn.tools} /> : <ToolSummary tools={turn.tools} />}
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
        <Extras messageId={PENDING_MESSAGE} fresh cards={turn.cards} chips={turn.chips} actions={turn.actions} state={state} run={run} onShowSlot={onShowSlot} />
        {err?.code === "stopped" && (
          <p className="notice" role="status">
            <Icon name="stop" />
            <span>{turnErrorText(err)}</span>
          </p>
        )}
        {err && err.code !== "out_of_scope" && err.code !== "stopped" && !fixed && (
          <div className="turn-error" role="alert">
            <Icon name="alert" />
            <div className="stack-sm">
              <p>{turnErrorText(err)}</p>
              {err.code === "provider_not_ready" && <SettingsLink />}
              {offerImport && <ImportOffer onImport={onImport} />}
            </div>
          </div>
        )}
      </article>
    </>
  );
}

// J12: the setup sentence links to Settings.
export function SettingsLink() {
  const { openSettings } = useAgent();
  return (
    <button type="button" className="btn btn-sm" onClick={openSettings}>
      <Icon name="settings" size="sm" /> Open Settings
    </button>
  );
}

function ToolLines({ tools }: { tools: ToolLine[] }) {
  if (tools.length === 0) return null;
  return (
    <ul className="tool-lines">
      {tools.map((t) => (
        <li key={t.callId} className={`tool-line${t.ok === false ? " is-failed" : ""}`}>
          {t.ok === null ? <span className="spinner" aria-hidden="true" /> : t.ok ? <Icon name="check" size="sm" /> : <Icon name="alert" size="sm" />}
          <span>
            {t.label}
            {t.ok === false && ". It did not finish."}
          </span>
        </li>
      ))}
    </ul>
  );
}

// A finished turn's tool lines, folded into one line that opens them.
export function toolSummaryText(tools: ToolLine[]): string {
  const failed = tools.filter((t) => t.ok === false).length;
  const steps = `${tools.length} step${tools.length === 1 ? "" : "s"}`;
  return failed > 0 ? `Worked through ${steps}, ${failed} did not finish` : `Worked through ${steps}`;
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
  // J12: the setup sentence already says nothing changed.
  if (err.code === "provider_not_ready" && base !== "") return base;
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

export function CardView({ card, state, run, fresh = false }: { card: Card; state: AppState; run: Run; fresh?: boolean }) {
  switch (card.kind) {
    case "claims":
      return <ClaimsCard messageId={card.messageId} evidenceIds={card.evidenceIds} state={state} run={run} fresh={fresh} />;
    case "question":
      return <QuestionCard conflictId={card.conflictId} state={state} run={run} />;
    case "explanation":
      return <ExplanationCard conflictId={card.conflictId} state={state} run={run} />;
    case "reply":
      return <ReplyCard draftId={card.draftId} state={state} run={run} />;
    case "own_report":
      return <OwnReportCard messageId={card.messageId} state={state} run={run} />;
    case "notice":
      return (
        <div className="notice" role="note">
          <Icon name="info" />
          <div className="stack-sm">
            <span className="model-tag">Written by code</span>
            <p>{card.text}</p>
          </div>
        </div>
      );
  }
}
