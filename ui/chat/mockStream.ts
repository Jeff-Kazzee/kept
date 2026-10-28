// A scripted chat for UI work and tests until the case agent's chat route
// lands (sprint 7A). It follows the chat contract: the same events in the
// same order (0007, C4), the same cards and the same stored messages. It calls no model. Its replies are
// written by code from the live case, and it changes the case only through
// the existing routes (import and read a message, explain, ask), as the
// agent's tools would. Turn it on in the browser with ?mockchat=1.
//
// The chat is kept in this tab's sessionStorage, so a reload keeps it.
// Closing the tab or Delete case clears it.
import { WITHHELD_USER_TEXT } from "../../src/agent/types.ts";
import { SCOPE_DECLINE, hasClinicalContent } from "../../src/domain/scope.ts";
import type { AppState, FixtureScenario, MessageView } from "../api.ts";
import type { Card, ChatErrorCode, ChatEvent, ChatLog, ChatMessage, ChatTransport, FactChip } from "./types.ts";

// The parts of the page's API the mock uses.
export type MockApi = {
  state(): Promise<AppState>;
  fixtures(): Promise<FixtureScenario[]>;
  addMessage(m: { id?: string; channel: string; from: string; received_at: string; text: string }): Promise<MessageView>;
  extract(id: string, effort: "minimal" | "low", expectedVersion: number): Promise<unknown>;
  explain(conflictId: string, expectedVersion: number): Promise<unknown>;
  nextQuestion(expectedVersion: number): Promise<unknown>;
};

export type MockOptions = { api: MockApi; now?: () => string; delayMs?: number; storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null };

// Also the marker test/bundle.test.ts looks for: it must not be in the
// production bundle.
export const MOCK_MARKER = "appointments-mock-chat";
const STORE_KEY = MOCK_MARKER;



const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// Which script a message runs. Exported for tests.
export function intentOf(text: string): "message" | "status" | "conflict" | "reply" | "checklist" | "help" {
  const t = text.trim();
  if (t.includes("\n") || t.length >= 90) return "message";
  if (/\b(bring|checklist|to do)\b/i.test(t)) return "checklist";
  if (/\b(reply|draft|answer the office)\b/i.test(t)) return "reply";
  if (/\b(conflict|change|should i|next step|decide|question|move[ds]?)\b/i.test(t)) return "conflict";
  if (/\b(confirm(ed)?|schedule|status|appointments?|where do)\b/i.test(t)) return "status";
  return "help";
}

export function createMockTransport({ api, now = () => new Date().toISOString(), delayMs = 18, storage = null }: MockOptions): ChatTransport & { reset(): void } {
  type Saved = { log: ChatLog; generation: number | null; seq: number };
  let saved: Saved | null = null;
  try {
    saved = JSON.parse(storage?.getItem(STORE_KEY) ?? "null") as Saved | null;
  } catch {
    saved = null;
  }
  let log: ChatLog = saved?.log ?? { chatVersion: 0, messages: [] };
  let generation: number | null = saved?.generation ?? null;
  let seq = saved?.seq ?? 0;
  const persist = () => {
    try {
      storage?.setItem(STORE_KEY, JSON.stringify({ log, generation, seq } satisfies Saved));
    } catch {
      // Storage full or off. The chat stays in memory.
    }
  };
  let fixtures: FixtureScenario["messages"] | null = null;
  const nextId = (kind: string) => `mock-${kind}-${++seq}`;

  return {
    kind: "mock",
    reset() {
      log = { chatVersion: 0, messages: [] };
      storage?.removeItem(STORE_KEY);
    },
    async load() {
      // Delete case moves the generation and erases the chat.
      const g = (await api.state()).generation;
      if (generation !== null && g !== generation) log = { chatVersion: 0, messages: [] };
      generation = g;
      persist();
      return structuredClone(log);
    },
    async send(text, expectedVersion, onEvent) {
      const turnId = nextId("turn");
      const emit = (e: ChatEvent) => onEvent(e);
      // A turn refused before it starts sends only turn.error (0007, C4).
      if (expectedVersion !== log.chatVersion) {
        emit({ event: "turn.error", data: { turnId, code: "stale_edit", message: "The chat changed in another tab. It is reloaded. Your message was not sent. Nothing was saved." } });
        return;
      }
      const userMessageId = nextId("msg");
      emit({ event: "turn.started", data: { turnId, userMessageId } });
      // The answer's text is held until the end, then sent in pieces of
      // about 80 characters, as the agent sends checked text (0007, C1).
      const finish = async (answer: ChatMessage, userText: string, code?: { code: ChatErrorCode; message: string }) => {
        if (answer.chips.length > 0) emit({ event: "facts", data: { turnId, chips: answer.chips } });
        for (const piece of answer.text.match(/[\s\S]{1,80}(\s|$)|[\s\S]{1,80}/g) ?? []) {
          emit({ event: "text.delta", data: { turnId, text: piece } });
          await sleep(delayMs);
        }
        if (code) emit({ event: "turn.error", data: { turnId, ...code } });
        const user: ChatMessage = { id: userMessageId, role: "user", text: userText, createdAt: now(), cards: [], chips: [] };
        log = { chatVersion: log.chatVersion + 1, messages: [...log.messages, user, answer] };
        persist();
        emit({ event: "turn.done", data: { turnId, assistantMessageId: answer.id, chatVersion: log.chatVersion } });
      };
      // The fixed decline. No script runs, and the person's words are not
      // kept: the stored message is a fixed sentence (0007, C2).
      if (hasClinicalContent(text)) {
        const decline: ChatMessage = { id: nextId("msg"), role: "assistant", text: SCOPE_DECLINE, createdAt: now(), cards: [], chips: [], declined: true };
        await finish(decline, WITHHELD_USER_TEXT, { code: "out_of_scope", message: SCOPE_DECLINE });
        return;
      }
      const cards: Card[] = [];
      const chips: FactChip[] = [];
      let said = "";
      const say = (words: string) => {
        said += said === "" ? words : ` ${words}`;
      };
      // Cards are sent as soon as the tool that made them returns.
      const card = (c: Card) => {
        cards.push(c);
        emit({ event: "card", data: { turnId, card: c } });
      };
      let calls = 0;
      const tool = async <T>(name: string, label: string, run: () => Promise<T>): Promise<T | null> => {
        const callId = `${turnId}-call-${++calls}`;
        emit({ event: "tool.started", data: { turnId, callId, tool: name, label } });
        await sleep(delayMs * 8);
        try {
          const out = await run();
          emit({ event: "tool.finished", data: { turnId, callId, ok: true } });
          return out;
        } catch {
          emit({ event: "tool.finished", data: { turnId, callId, ok: false } });
          return null;
        }
      };

      switch (intentOf(text)) {
        case "message": {
          fixtures ??= (await api.fixtures()).flatMap((s) => s.messages);
          const match = fixtures.find((m) => m.text.trim() === text.trim());
          const before = await api.state();
          const already = match !== undefined && before.messages.some((m) => m.id === match.id);
          const view = await tool("read_message", "Reading the message", async () => {
            let id = match?.id ?? null;
            if (!already) {
              const imported = await api.addMessage(match ?? { channel: "sms", from: "Pasted message", received_at: now(), text });
              await api.extract(imported.id, "minimal", imported.version).catch(() => undefined);
              id = imported.id;
            }
            const found = (await api.state()).messages.find((m) => m.id === id);
            if (!found) throw new Error("not imported");
            card({ kind: "claims", messageId: found.id, evidenceIds: found.evidenceIds });
            return found;
          });
          if (!view) {
            say("I could not add that message to your case. Nothing was saved.");
            break;
          }
          const n = view.evidenceIds.length;
          say(
            already
              ? `This message from ${view.message.from} is already in your case. Its facts are below.`
              : n === 0
                ? view.status === "manual_entry_needed"
                  ? "I could not read facts from this message. You can enter them by hand below."
                  : "I read the message. It has no appointment facts."
                : `I read the message from ${view.message.from} and found ${n} fact${n === 1 ? "" : "s"}. Review each one below. Nothing counts until you accept it.`,
          );
          break;
        }
        case "status": {
          const st = await tool("list_appointments", "Reading your schedule", async () => {
            const s = await api.state();
            for (const p of s.proposals.filter((x) => x.status === "pending")) card({ kind: "proposal", proposalId: p.id });
            return s;
          });
          if (!st) {
            say("I could not read your schedule. Nothing was saved.");
            break;
          }
          const archived = new Set(st.records.filter((r) => r.archived).map((r) => r.id));
          const slots = st.case.slots.filter((s) => !archived.has(s.key));
          if (slots.length === 0) {
            say("Your schedule has no appointments yet. Paste a message from the office and accept the facts it finds.");
            break;
          }
          const held = slots.filter((s) => s.state === "confirmed" || s.state === "change_proposed");
          say(
            held.length === 0
              ? "Nothing is confirmed yet. Each time the office mentioned is below with its state."
              : `Confirmed: ${held.map((s) => s.label).join(" and ")}. Each time is below with its state and source. Tap one to see it in your schedule.`,
          );
          if (cards.length > 0) say(`An agent proposed ${cards.length === 1 ? "a change" : `${cards.length} changes`}. ${cards.length === 1 ? "It waits" : "They wait"} for you below.`);
          chips.push(...slots.map((s) => ({ slotKey: s.key, label: s.label, stateLabel: s.stateLabel, evidenceIds: s.evidenceIds })));
          break;
        }
        case "conflict": {
          const st = await api.state();
          const conflict = st.case.conflicts.find((c) => c.status !== "answered" && c.askable && c.archivedSlotKeys.length === 0);
          if (!conflict) {
            say("There is no open question about your schedule right now.");
            break;
          }
          await tool("explain_conflict", "Checking the change against your messages", async () => {
            if (!conflict.explanation) await api.explain(conflict.id, conflict.version);
            card({ kind: "explanation", conflictId: conflict.id });
          });
          await tool("ask_next_question", "Preparing a question", async () => {
            if (!st.case.question) await api.nextQuestion(st.case.questionsVersion);
            const after = await api.state();
            card({ kind: "question", conflictId: after.case.question?.conflictId ?? conflict.id });
          });
          say("Here is what changed and the question it raises. The explanation cites the messages it relies on.");
          break;
        }
        case "reply": {
          const reply = await tool("get_reply_draft", "Reading your reply draft", async () => {
            const r = (await api.state()).case.reply;
            const id = r.draft?.id ?? r.sent.at(-1)?.draftId;
            if (id) card({ kind: "reply", draftId: id });
            return r;
          });
          if (reply?.draft) say("Your reply draft is below. Read back each field, then approve it.");
          else if (reply?.sent.length) say("Your last reply is approved. Sending is simulated, so nothing left this app.");
          else say("No reply draft is open. Answer the question about the change first, or pick a template in Schedule.");
          break;
        }
        case "checklist": {
          const st = await tool("get_checklist", "Reading the checklist", async () => {
            const s = await api.state();
            if (s.case.checklist.length > 0) card({ kind: "notice", text: "Each item is in the Checklist tab with its quote and source." });
            return s;
          });
          const n = st?.case.checklist.length ?? 0;
          say(n === 0 ? "The office has not asked you to bring or do anything yet." : `The office asked you for ${n} thing${n === 1 ? "" : "s"}.`);
          break;
        }
        case "help":
          say(
            "I can read a message you paste from the office, tell you what is confirmed, and walk you through a change the office proposed. This is the scripted chat, so I only follow those paths.",
          );
          break;
      }

      await finish({ id: nextId("msg"), role: "assistant", text: said, createdAt: now(), cards, chips }, text);
    },
  };
}
