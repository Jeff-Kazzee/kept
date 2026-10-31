// The chat hook: loads the stored chat, sends a message and follows its
// stream, then reads the stored chat again.
import { useCallback, useEffect, useReducer, useRef } from "react";

// Shown when the user stops following a turn. The server may still finish
// and save it, and the chat is read again either way.
export const STOPPED_TEXT = "You stopped this answer. The app may still save what it finished.";
import { errorSentence } from "../format.ts";
import { chatReducer, initialChat } from "./state.ts";
import type { ChatLog, ChatTransport } from "./types.ts";

// `onCard` runs when a card arrives during a turn. A card names something a
// tool just wrote, such as an imported message, so the page reads the case
// again to render it live instead of as missing.
// `initial`: the stored chat, when the shell already read it with the case
// (0019, P17). The first render then shows it, and the hook does not read
// it again until the case changes.
export function useChat(transport: ChatTransport, reloadKey: string, onTurnEnd: () => void, onCard: () => void = onTurnEnd, initial?: ChatLog | null) {
  const [chat, dispatch] = useReducer(chatReducer, initial, (log) => (log === undefined ? initialChat : chatReducer(initialChat, { type: "loaded", log })));
  const skipFirst = useRef(initial !== undefined);
  const streaming = chat.pending?.status === "streaming";
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const versionRef = useRef(0);
  versionRef.current = chat.chatVersion;

  const load = useCallback(async () => {
    try {
      dispatch({ type: "loaded", log: await transport.load() });
    } catch {
      // The chat stays as it was. The next change reads it again.
    }
  }, [transport]);

  // The case changed (another tab, an agent, Delete case): read the chat
  // again, unless a turn is streaming.
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    if (!streamingRef.current) void load();
  }, [load, reloadKey]);

  const controller = useRef<AbortController | null>(null);
  const send = useCallback(
    async (text: string): Promise<void> => {
      dispatch({ type: "start", text, at: new Date().toISOString() });
      const abort = new AbortController();
      controller.current = abort;
      try {
        await transport.send(text, versionRef.current, (event) => {
          if (abort.signal.aborted) return;
          dispatch({ type: "event", event });
          // A card or an action names something a tool just wrote.
          if (event.event === "card" || event.event === "action") onCard();
        }, abort.signal);
      } catch (e) {
        if (abort.signal.aborted) dispatch({ type: "failed", code: "stopped", message: STOPPED_TEXT });
        else dispatch({ type: "failed", code: "request_failed", message: errorSentence(e) });
      }
      controller.current = null;
      let log = null;
      try {
        log = await transport.load();
      } catch {
        // The turn stays on screen as it streamed.
      }
      dispatch({ type: "settled", log });
      onTurnEnd();
    },
    [transport, onTurnEnd, onCard],
  );

  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);
  // Stops following the running turn. The page then reads the chat again.
  const stop = useCallback(() => controller.current?.abort(), []);
  return { chat, send, streaming, dismiss, stop };
}
