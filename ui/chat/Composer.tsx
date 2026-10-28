// The message box. Enter sends and Shift+Enter adds a line. A pasted
// message keeps its lines. The calendar button loads a .ics file through
// the existing calendar route.
import { useRef, type RefObject } from "react";
import { Icon } from "../components/Icon.tsx";

export const MAX_MESSAGE = 20000;
export const MAX_ROWS = 8;

// The number of rows for the box: one per line of text, at most MAX_ROWS.
// The box grows by this attribute and by CSS (field-sizing: content where
// the browser has it), never by a style written from script, which the
// production Content-Security-Policy may refuse. Past MAX_ROWS it scrolls.
export const composerRows = (value: string) => Math.min(MAX_ROWS, Math.max(1, value.split("\n").length));

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
        rows={composerRows(value)}
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
