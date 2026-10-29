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
import { usageStopText } from "../../src/model/usage-text.ts";
import { api, type AppState, type FixtureScenario } from "../api.ts";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { entriesById, useAgent } from "../agent/AgentContext.tsx";
import { ModelPicker } from "../agent/ModelPicker.tsx";
import { Receipts } from "../agent/Receipts.tsx";
import { DEFAULT_EXTRACTION_EFFORT, PartlyDoneError, emailTime, reasonOnly, shortTime } from "../format.ts";
import { ClaimsCard } from "../case/ClaimsCard.tsx";
import { senderShown } from "../case/Source.tsx";
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

  // Follow the newest content while the user has not scrolled away.
  // Scrolled up, new content shows a "New messages" pill instead. Once a
  // turn ends, the view stops where the newest answer starts, so a long
  // card after it never pushes its words out of view (0017, E3).
  const content = `${chat.messages.length}:${chat.pending?.text.length ?? 0}:${chat.pending?.cards.length ?? 0}:${chat.pending?.tools.length ?? 0}:${chat.pending?.actions.length ?? 0}:${chat.pending?.status ?? ""}`;
  const [unseen, setUnseen] = useState(false);
  // Where the app last scrolled to, so its own scroll is not read as the
  // person scrolling away.
  const placed = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (!pinned.current) {
      setUnseen(true);
      return;
    }
    el.scrollTop = followTop(el, chat.pending?.status === "streaming");
    placed.current = el.scrollTop;
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

  // 0017, E3: one full facts card per office message in the thread.
  const offers = newestOffers(chat);
  const facts = factsCards(imports, chat, new Set(state.messages.map((m) => m.id)), offers);

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
          if (placed.current !== null && Math.abs(el.scrollTop - placed.current) < 2) return;
          placed.current = null;
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
            <ImportedItem key={x.messageId} messageId={x.messageId} state={state} run={run} place={facts.get(`import:${x.messageId}`)} />
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
          {chat.pending && <PendingItem turn={chat.pending} state={state} run={run} scripted={scripted} onShowSlot={onShowSlot} onImport={() => openImport(chat.pending?.userText ?? "")} facts={facts} offers={offers} />}
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
          // Fix round 1, R5: one entry per message, so its card keeps one place.
          setImports((all) => (all.some((x) => x.messageId === messageId) ? all : [...all, { messageId, after: chat.messages.length }]));
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
                Connections.
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

function MessageItem({
  message: m,
  state,
  run,
  scripted,
  tools,
  onShowSlot,
  onImport,
  facts,
  offers,
}: {
  message: ChatMessage;
  state: AppState;
  run: Run;
  scripted: boolean;
  tools?: ToolLine[];
  onShowSlot: (k: string, from?: HTMLElement) => void;
  onImport?: () => void;
  facts?: Map<string, FactsPlace>;
  offers?: ReadonlySet<string>;
}) {
  const { activity } = useAgent();
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
        <>
          <AssistantHead scripted={scripted} at={m.createdAt} />
          {tools && <ToolSummary tools={tools} />}
          {m.text && <p className="assistant-text">{m.text}</p>}
        </>
      )}
      <Extras
        messageId={m.id}
        shownText={!m.declined && isCodeSentence(m.text) ? m.text.trim() : null}
        cards={m.cards}
        chips={m.chips}
        actions={entriesById(activity, m.actions ?? [])}
        state={state}
        run={run}
        onShowSlot={onShowSlot}
        facts={facts}
        offers={offers}
      />
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
  facts,
  offers,
}: {
  turn: PendingTurn;
  state: AppState;
  run: Run;
  scripted: boolean;
  onShowSlot: (k: string, from?: HTMLElement) => void;
  onImport: () => void;
  facts?: Map<string, FactsPlace>;
  offers?: ReadonlySet<string>;
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
        <Extras
          messageId={PENDING_MESSAGE}
          fresh
          shownText={codeText}
          cards={turn.cards}
          chips={turn.chips}
          actions={turn.actions}
          state={state}
          run={run}
          onShowSlot={onShowSlot}
          facts={facts}
          offers={offers}
        />
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

function ToolLines({ tools }: { tools: ToolLine[] }) {
  if (tools.length === 0) return null;
  return (
    <ul className="tool-lines">
      {tools.map((t) => (
        <li key={t.callId} className={`tool-line${t.ok === false && !t.declined ? " is-failed" : ""}`}>
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
