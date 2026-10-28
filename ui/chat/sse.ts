// Reads a text/event-stream body into chat events. Each event is an
// `event: <name>` line and one or more `data:` lines, ended by a blank
// line. Unknown event names, comments and data that is not JSON are
// skipped, so a newer server cannot break the page.
import { CHAT_EVENTS, type ChatEvent } from "./types.ts";

export function createSseParser(onEvent: (e: ChatEvent) => void) {
  let buffer = "";
  let name = "message";
  let data: string[] = [];
  const dispatch = () => {
    if (data.length > 0 && CHAT_EVENTS.has(name as ChatEvent["event"])) {
      try {
        onEvent({ event: name, data: JSON.parse(data.join("\n")) } as ChatEvent);
      } catch {
        // Not JSON. Skipped.
      }
    }
    name = "message";
    data = [];
  };
  const line = (l: string) => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return;
    const colon = l.indexOf(":");
    const field = colon === -1 ? l : l.slice(0, colon);
    let value = colon === -1 ? "" : l.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      for (const l of lines) line(l);
    },
    end() {
      if (buffer !== "") line(buffer);
      buffer = "";
      dispatch();
    },
  };
}
