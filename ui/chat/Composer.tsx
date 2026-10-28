// The message box. Enter sends and Shift+Enter adds a line. A pasted
// message keeps its lines. The calendar button loads a .ics file through
// the existing calendar route.
import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "../components/Icon.tsx";

export const MAX_MESSAGE = 20000;
export const MAX_ROWS = 8;

// The number of rows for the box: one per line of text, at most MAX_ROWS.
// The box grows by this attribute and by CSS (field-sizing: content where
// the browser has it), never by a style written from script, which the
// production Content-Security-Policy may refuse. Past MAX_ROWS it scrolls.
// Where the browser lacks field-sizing, a long line wraps without a newline,
// so each line counts as many rows as it wraps to at `charsPerLine`
// (review 2, B5).
export function composerRows(value: string, charsPerLine = Number.POSITIVE_INFINITY): number {
  const per = Math.max(1, Math.floor(charsPerLine));
  const rows = value.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / per)), 0);
  return Math.min(MAX_ROWS, Math.max(1, rows));
}

// About how many characters fit on one line of the box: its inner width
// over an average character width at the 16 px body font.
export const AVERAGE_CHAR_PX = 8.4;
export const charsPerLine = (innerWidthPx: number) => Math.max(8, Math.floor(innerWidthPx / AVERAGE_CHAR_PX));

export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  busy,
  inputRef,
  onLoadCalendar,
  onAddOfficeMessage,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  busy: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onLoadCalendar: (file: File) => Promise<void>;
  onAddOfficeMessage: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  // The box's width, read (never written) when it changes size.
  const [perLine, setPerLine] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const el = inputRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setPerLine(charsPerLine(el.clientWidth - 16));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [inputRef]);

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <input
        ref={fileRef}
        id="calendar-file"
        name="calendar-file"
        type="file"
        accept=".ics,text/calendar"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) await onLoadCalendar(file);
        }}
      />
      <button type="button" className="btn btn-ghost btn-icon" onClick={() => fileRef.current?.click()} aria-label="Load a calendar file (.ics)" title="Load a calendar file (.ics)">
        <Icon name="calendarPlus" />
      </button>
      <button type="button" className="btn btn-ghost btn-icon" onClick={onAddOfficeMessage} aria-label="Add an office message" title="Add an office message">
        <Icon name="messagePlus" />
      </button>
      <label htmlFor="chat-input" className="sr-only">
        Message
      </label>
      <textarea
        ref={inputRef}
        id="chat-input"
        name="message"
        rows={composerRows(value, perLine)}
        value={value}
        maxLength={MAX_MESSAGE}
        disabled={disabled}
        placeholder={disabled ? "The chat is not available" : "Ask or paste a message"}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!busy) onSend();
          }
        }}
      />
      <button type="submit" className="btn btn-primary btn-icon" disabled={disabled || busy || value.trim() === ""} aria-label="Send">
        <Icon name="send" />
      </button>
    </form>
  );
}
