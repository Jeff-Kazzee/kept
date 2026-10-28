// The chat hook: loads the stored chat, sends a message and follows its
// stream, then reads the stored chat again.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { isNotPaired } from "../api.ts";
import { errorSentence } from "../format.ts";
import { chatReducer, initialChat } from "./state.ts";
import type { ChatTransport } from "./types.ts";

// `onCard` runs when a card arrives during a turn. A card names something a
// tool just wrote, such as an imported message, so the page reads the case
// again to render it live instead of as missing.
export function useChat(transport: ChatTransport, reloadKey: string, onNotPaired: () => void, onTurnEnd: () => void, onCard: () => void = onTurnEnd) {
  const [chat, dispatch] = useReducer(chatReducer, initialChat);
  const streaming = chat.pending?.status === "streaming";
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const versionRef = useRef(0);
  versionRef.current = chat.chatVersion;

  const load = useCallback(async () => {
    try {
      dispatch({ type: "loaded", log: await transport.load() });
    } catch (e) {
      if (isNotPaired(e)) onNotPaired();
    }
  }, [transport, onNotPaired]);

  // The case changed (another tab, an agent, Delete case): read the chat
  // again, unless a turn is streaming.
  useEffect(() => {
    if (!streamingRef.current) void load();
  }, [load, reloadKey]);

  const send = useCallback(
    async (text: string): Promise<void> => {
      dispatch({ type: "start", text, at: new Date().toISOString() });
      try {
        await transport.send(text, versionRef.current, (event) => {
          dispatch({ type: "event", event });
          if (event.event === "card") onCard();
        });
      } catch (e) {
        if (isNotPaired(e)) onNotPaired();
        dispatch({ type: "failed", code: "request_failed", message: errorSentence(e) });
      }
      let log = null;
      try {
        log = await transport.load();
      } catch {
        // The turn stays on screen as it streamed.
      }
      dispatch({ type: "settled", log });
      onTurnEnd();
    },
    [transport, onNotPaired, onTurnEnd, onCard],
  );

  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);
  return { chat, send, streaming, dismiss };
}
