// The message box: a large rounded field that floats at the bottom. Enter
// sends and Shift+Enter adds a line. A pasted message keeps its lines. The
// attach button offers a calendar file (the existing calendar route) or an
// office message (the import sheet). The pill names what powers the
// assistant and opens Settings.
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "../components/Icon.tsx";
import { useMenu } from "../components/Menu.tsx";

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
  model = null,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  busy: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onLoadCalendar: (file: File) => Promise<void>;
  onAddOfficeMessage: () => void;
  // The model and provider indicator with its picker.
  model?: ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const attach = useMenu();
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
        placeholder={disabled ? "The chat is not available" : "Ask about your appointments, or paste a message from the office"}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!busy) onSend();
          }
        }}
      />
      <div className="composer-bar">
        <div className="attach">
          <button
            ref={attach.buttonRef}
            type="button"
            className="btn btn-ghost btn-icon btn-round"
            aria-label="Attach a calendar file or an office message"
            title="Attach"
            aria-expanded={attach.open}
            aria-controls={menuId}
            onClick={() => attach.setOpen((m) => !m)}
          >
            <Icon name="plus" />
          </button>
          <div ref={attach.menuRef} id={menuId} className="menu" hidden={!attach.open}>
            <button type="button" className="menu-item" onClick={() => attach.choose(() => fileRef.current?.click())} aria-label="Load a calendar file (.ics)">
              <Icon name="calendarPlus" />
              <span>
                Calendar file
                <small>An .ics file. Clashes are checked against it.</small>
              </span>
            </button>
            <button type="button" className="menu-item" onClick={() => attach.choose(onAddOfficeMessage)} aria-label="Add an office message">
              <Icon name="messagePlus" />
              <span>
                Office message
                <small>Added as a message from the office, outside the chat.</small>
              </span>
            </button>
          </div>
        </div>
        {model}
        <button type="submit" className="send-btn" disabled={disabled || busy || value.trim() === ""} aria-label="Send">
          {busy ? <span className="spinner spinner-on-accent" aria-hidden="true" /> : <Icon name="send" />}
        </button>
      </div>
    </form>
  );
}
