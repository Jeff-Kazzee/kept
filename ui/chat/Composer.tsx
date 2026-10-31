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

// 0019, round 3: the composer's text can live in the field itself, with a
// small store beside it (`drafts`). Then a key press re-renders nothing,
// and the composer renders again only when the text turns empty or
// non-empty or its row count changes. A text set from outside (a demo
// message, a lost turn, a clear after sending) is written to the field.
export type Drafts = { get(): string; set(next: string): void; subscribe(f: () => void): () => void };

export function Composer({
  value: controlledValue,
  onChange,
  drafts,
  onSend,
  disabled,
  busy,
  inputRef,
  onLoadCalendar,
  onAddOfficeMessage,
  model = null,
  onStop,
}: {
  // Controlled: the text and its setter. Or `drafts`, for a field that
  // keeps its own text.
  value?: string;
  onChange?: (v: string) => void;
  drafts?: Drafts;
  onSend: () => void;
  disabled: boolean;
  busy: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onLoadCalendar: (file: File) => Promise<void>;
  onAddOfficeMessage: () => void;
  // The model and provider indicator with its picker.
  model?: ReactNode;
  // While a turn runs, the send button becomes Stop.
  onStop?: () => void;
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

  // The field's text, from the store when it keeps its own.
  // With a store, the send button's disabled state follows the text on the
  // element itself, so turning non-empty renders nothing either. A render
  // reads the same emptiness, so React and the element agree.
  const empty = drafts ? drafts.get().trim() === "" : (controlledValue ?? "").trim() === "";
  const sendRef = useRef<HTMLButtonElement>(null);
  const blockedRef = useRef(false);
  const blocked = disabled || busy;
  blockedRef.current = blocked;
  const [ownRows, setOwnRows] = useState(() => (drafts ? composerRows(drafts.get(), perLine) : 1));
  // Compared here first: a same-value setState can still cost a render.
  const rowsNow = useRef(ownRows);
  rowsNow.current = ownRows;
  const rows = drafts ? ownRows : composerRows(controlledValue ?? "", perLine);
  useEffect(() => {
    if (!drafts) return;
    const sync = () => {
      const el = inputRef.current;
      const v = drafts.get();
      if (el && el.value !== v) el.value = v;
      if (sendRef.current) sendRef.current.disabled = blockedRef.current || v.trim() === "";
      const r = composerRows(v, perLine);
      if (r !== rowsNow.current) {
        rowsNow.current = r;
        setOwnRows(r);
      }
    };
    sync();
    return drafts.subscribe(sync);
  }, [drafts, perLine, inputRef]);

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
        rows={rows}
        {...(drafts ? { defaultValue: drafts.get() } : { value: controlledValue ?? "" })}
        maxLength={MAX_MESSAGE}
        disabled={disabled}
        placeholder={disabled ? "The chat is not available" : "Ask about your appointments, or paste a message from the office"}
        onChange={(e) => (drafts ? drafts.set(e.target.value) : onChange?.(e.target.value))}
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
        {busy && onStop ? (
          <button type="button" className="send-btn is-stop" onClick={onStop} aria-label="Stop the answer" title="Stop">
            <Icon name="stop" />
          </button>
        ) : (
          <button ref={sendRef} type="submit" className="send-btn" disabled={blocked || empty} aria-label="Send">
            <Icon name="send" />
          </button>
        )}
      </div>
    </form>
  );
}
