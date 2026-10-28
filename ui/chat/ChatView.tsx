// The chat column: the thread, the streamed turn and the composer.
// Assistant text is model output and is labeled so, quietly and the same way
// every time. The scripted chat (?mockchat=1) labels its text as scripted.
// Every card renders from the live case view.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AppState, FixtureScenario } from "../api.ts";
import type { Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { denverShort } from "../format.ts";
import { ClaimsCard } from "../case/ClaimsCard.tsx";
import { ExplanationCard, QuestionCard } from "../case/ConflictCards.tsx";
import { ProposalCard } from "../case/ProposalCard.tsx";
import { ReplyCard } from "../case/ReplyCard.tsx";
import { Composer } from "./Composer.tsx";
import { DEMO_IDS, nextDemoMessage } from "./demo.ts";
import { ImportSheet, type ImportRequest } from "./ImportSheet.tsx";
import { turnLost, type ChatState, type PendingTurn } from "./state.ts";
import type { Card, ChatMessage, FactChip } from "./types.ts";

export type ChatViewProps = {
  state: AppState;
  run: Run;
  chat: ChatState;
  streaming: boolean;
  scripted: boolean;
  send: (text: string) => Promise<void>;
  onShowSlot: (slotKey: string) => void;
  onLoadCalendar: (file: File) => Promise<void>;
  onLoadDemo: () => Promise<FixtureScenario["messages"][number] | null>;
  fixtures: FixtureScenario["messages"];
};

export function ChatView(props: ChatViewProps) {
  const { state, run, chat, streaming, scripted, send, onShowSlot, onLoadCalendar, onLoadDemo, fixtures } = props;
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
  const content = `${chat.messages.length}:${chat.pending?.text.length ?? 0}:${chat.pending?.cards.length ?? 0}:${chat.pending?.tools.length ?? 0}:${chat.pending?.status ?? ""}`;
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [content]);

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
        }}
      >
        <div className="thread-inner">
          {empty && (
            <Welcome
              unavailable={unavailable}
              onPaste={() => fill("")}
              onAsk={() => void submit("What is confirmed?")}
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
                onShowSlot={onShowSlot}
                onImport={m.declined ? () => openImport(declinedOriginal(chat, i)) : undefined}
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
          />
          <p className="composer-hint">Enter sends. Shift+Enter adds a line. Pasted messages keep their lines.</p>
        </div>
      </div>
      <ImportSheet
        request={importing}
        run={run}
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

function Welcome({ unavailable, onPaste, onAsk, onDemo }: { unavailable: boolean; onPaste: () => void; onAsk: () => void; onDemo: () => void }) {
  return (
    <div className="welcome">
      <h2>Keep track of appointment changes</h2>
      <p>
        Paste a message from the office. The assistant reads the times, places and requests in it, and you accept each fact before it counts. Your schedule stays beside the chat, or one tap away on a phone.
      </p>
      {unavailable ? (
        <p className="notice">
          <Icon name="info" />
          <span>The chat is not available in this build yet. Your schedule works as usual. To try the scripted chat, open this page with ?mockchat=1 at the end of the address.</span>
        </p>
      ) : (
        <div className="chips" aria-label="Ways to start">
          <button type="button" className="chip" onClick={onPaste}>
            <Icon name="message" size="sm" /> Paste a message from the office
          </button>
          <button type="button" className="chip" onClick={onAsk}>
            <Icon name="check" size="sm" /> What is confirmed?
          </button>
          <button type="button" className="chip" onClick={onDemo}>
            <Icon name="sparkle" size="sm" /> Load the demo
          </button>
        </div>
      )}
    </div>
  );
}

function AssistantHead({ scripted, at }: { scripted: boolean; at?: string }) {
  return (
    <div className="msg-meta">
      <Icon name="sparkle" size="sm" />
      <span>Assistant</span>
      <span className="model-tag">{scripted ? "Scripted demo reply, not a model" : "Model output"}</span>
      {at && <time dateTime={at}>{denverShort(at)}</time>}
    </div>
  );
}

function UserBubble({ text, at }: { text: string; at: string }) {
  return (
    <div className="msg msg-user">
      <div className="bubble">{text}</div>
      <div className="msg-meta">
        <span>You</span>
        <time dateTime={at}>{denverShort(at)}</time>
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
        {onImport && (
          <>
            <p className="small muted">If you pasted a message from the office, add it as an office message instead. The app then reads only its appointment facts.</p>
            <div>
              <button type="button" className="btn" onClick={onImport}>
                <Icon name="message" size="sm" /> Add this as an office message
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// The words of the user message just before a declined answer, as this
// page kept them. Empty after a reload, because the server stores a fixed
// sentence in their place.
function declinedOriginal(chat: ChatState, index: number): string {
  const before = chat.messages[index - 1];
  return before && before.role === "user" ? (chat.declinedText[before.id] ?? "") : "";
}

function ImportedItem({ messageId, state, run }: { messageId: string; state: AppState; run: Run }) {
  return (
    <article className="msg msg-assistant" aria-label="Office message you added">
      <div className="msg-meta">
        <Icon name="message" size="sm" />
        <span>You added an office message</span>
      </div>
      <ClaimsCard messageId={messageId} evidenceIds={[]} state={state} run={run} />
    </article>
  );
}

function Extras({ cards, chips, state, run, onShowSlot }: { cards: Card[]; chips: FactChip[]; state: AppState; run: Run; onShowSlot: (k: string) => void }): ReactNode {
  return (
    <>
      {chips.length > 0 && (
        <div className="chips" aria-label="Facts from your schedule">
          {chips.map((c) => (
            <button key={c.slotKey} type="button" className="chip fact-chip" onClick={() => onShowSlot(c.slotKey)} aria-label={`${c.label}: ${c.stateLabel}. Show in schedule.`}>
              <span>{c.label}</span>
              <small>{c.stateLabel}</small>
            </button>
          ))}
        </div>
      )}
      {cards.map((c, i) => (
        <CardView key={i} card={c} state={state} run={run} />
      ))}
    </>
  );
}

function MessageItem({
  message: m,
  state,
  run,
  scripted,
  onShowSlot,
  onImport,
}: {
  message: ChatMessage;
  state: AppState;
  run: Run;
  scripted: boolean;
  onShowSlot: (k: string) => void;
  onImport?: () => void;
}) {
  if (m.role === "user") return <UserBubble text={m.text} at={m.createdAt} />;
  return (
    <article className="msg msg-assistant" aria-label="Assistant">
      {m.declined ? (
        <Declined text={m.text} onImport={onImport} />
      ) : (
        <>
          <AssistantHead scripted={scripted} at={m.createdAt} />
          {m.text && <p className="assistant-text">{m.text}</p>}
        </>
      )}
      <Extras cards={m.cards} chips={m.chips} state={state} run={run} onShowSlot={onShowSlot} />
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
  onShowSlot: (k: string) => void;
  onImport: () => void;
}) {
  const err = turn.error;
  // ungrounded and model_unavailable: the streamed text is a fixed
  // sentence written by code. It is shown once, as a notice.
  const fixed = err !== null && (err.code === "ungrounded" || err.code === "model_unavailable");
  return (
    <>
      <UserBubble text={turn.userText} at={turn.createdAt} />
      <article className="msg msg-assistant" aria-label="Assistant" aria-busy={turn.status === "streaming"}>
        {err?.code === "out_of_scope" ? (
          <Declined text={turn.text.trim() || err.message} onImport={onImport} />
        ) : fixed ? (
          <div className="notice" role="note">
            <Icon name="info" />
            <p>{turn.text.trim() || turnErrorText(err)}</p>
          </div>
        ) : (
          <>
            <AssistantHead scripted={scripted} />
            {turn.tools.map((t) => (
              <div key={t.callId} className="tool-line">
                {t.ok === null ? <span className="spinner" aria-hidden="true" /> : t.ok ? <Icon name="check" size="sm" /> : <Icon name="alert" size="sm" />}
                <span>
                  {t.label}
                  {t.ok === false && ". It did not finish."}
                </span>
              </div>
            ))}
            {turn.text ? (
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
        <Extras cards={turn.cards} chips={turn.chips} state={state} run={run} onShowSlot={onShowSlot} />
        {err && err.code !== "out_of_scope" && !fixed && (
          <div className="turn-error" role="alert">
            <Icon name="alert" />
            <p>{turnErrorText(err)}</p>
          </div>
        )}
      </article>
    </>
  );
}

// The words for a turn that ended with an error. The server's message is a
// plain sentence. A code with no message gets one here.
export function turnErrorText(err: { code: string; message: string }): string {
  const base = err.message.trim();
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
    case "server_error":
      return "The app could not finish that answer. Nothing was saved.";
    default:
      return "The assistant could not answer. Nothing was saved.";
  }
}

export function CardView({ card, state, run }: { card: Card; state: AppState; run: Run }) {
  switch (card.kind) {
    case "claims":
      return <ClaimsCard messageId={card.messageId} evidenceIds={card.evidenceIds} state={state} run={run} />;
    case "question":
      return <QuestionCard conflictId={card.conflictId} state={state} run={run} />;
    case "explanation":
      return <ExplanationCard conflictId={card.conflictId} state={state} run={run} />;
    case "reply":
      return <ReplyCard draftId={card.draftId} state={state} run={run} />;
    case "proposal": {
      const p = state.proposals.find((x) => x.id === card.proposalId);
      return p ? (
        <ProposalCard proposal={p} records={state.records} run={run} />
      ) : (
        <div className="card">
          <p className="small muted">This proposal is no longer in the case.</p>
        </div>
      );
    }
    case "notice":
      return (
        <div className="notice" role="note">
          <Icon name="info" />
          <p>{card.text}</p>
        </div>
      );
  }
}
