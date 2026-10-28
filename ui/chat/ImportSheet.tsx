// "Add an office message": imports a message through the existing
// /api/messages route, outside the chat, then reads it through the
// existing extract route. The chat checks a whole message for clinical
// words and declines it, so an office message that says "bring your lab
// results" cannot go through the chat. This sheet is the way through. The
// facts it finds wait for review like any other, and the page shows their
// claims card in the thread.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, type FixtureScenario } from "../api.ts";
import type { Run } from "../components/ActionButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { DEFAULT_EXTRACTION_EFFORT, getCaseZone, wallNow, wallToIso } from "../format.ts";
import { MAX_MESSAGE } from "./Composer.tsx";

const CHANNELS: Array<{ value: string; label: string }> = [
  { value: "sms", label: "Text message" },
  { value: "email", label: "Email" },
  { value: "portal", label: "Portal message" },
  { value: "voicemail_transcript", label: "Voicemail transcript" },
];

export type ImportRequest = { text: string };

type Fixture = FixtureScenario["messages"][number];

// A synthetic demo message whose text the sheet holds exactly. It keeps the
// fixture's id, so its recorded extraction applies, as the chat does for a
// pasted fixture message in recorded mode (0007).
export function fixtureFor(text: string, fixtures: Fixture[]): Fixture | null {
  const t = text.trim();
  return t === "" ? null : (fixtures.find((m) => m.text.trim() === t) ?? null);
}

// Imports the message and reads it. A failed read leaves the message in the
// case for manual entry, so the claims card can still show it.
export async function importOfficeMessage(input: { id?: string; channel: string; from: string; receivedAt: string; text: string }): Promise<string> {
  const message = await api.addMessage({ ...(input.id ? { id: input.id } : {}), channel: input.channel as never, from: input.from.trim(), received_at: input.receivedAt, text: input.text });
  try {
    await api.extract(message.id, DEFAULT_EXTRACTION_EFFORT, message.version);
  } catch {
    // The claims card offers manual entry for a message that was not read.
  }
  return message.id;
}

export function ImportSheet({
  request,
  run,
  onClose,
  onImported,
  fixtures = [],
  importedIds = new Set(),
}: {
  request: ImportRequest | null;
  run: Run;
  onClose: () => void;
  onImported: (messageId: string) => void;
  fixtures?: Fixture[];
  importedIds?: ReadonlySet<string>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const [channel, setChannel] = useState("sms");
  const [from, setFrom] = useState("");
  const [received, setReceived] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (request) {
      setText(request.text);
      const demo = fixtureFor(request.text, fixtures);
      if (demo) {
        setChannel(demo.channel);
        setFrom(demo.from);
        setReceived(wallNow(Date.parse(demo.received_at)));
      } else setReceived(wallNow());
      if (!dialog.open) dialog.showModal();
      // The sender is the one field never prefilled.
      fromRef.current?.focus();
    } else if (dialog.open) dialog.close();
    // Runs when the sheet opens. The fixtures are read at that moment.
  }, [request]);

  const receivedAt = wallToIso(received);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!receivedAt) return;
    setBusy(true);
    const out: { id: string | null } = { id: null };
    const demo = fixtureFor(text, fixtures);
    if (demo && importedIds.has(demo.id)) {
      // Already in the case: show its card instead of importing it twice.
      out.id = demo.id;
    } else {
      await run(async () => {
        out.id = await importOfficeMessage({ id: demo?.id, channel, from, receivedAt, text });
      });
    }
    setBusy(false);
    if (out.id) {
      setFrom("");
      onImported(out.id);
    }
  };

  return (
    <dialog ref={ref} className="sheet" aria-labelledby={`${uid}-title`} onClose={onClose} onCancel={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <div className="section-head">
          <h2 id={`${uid}-title`}>Add an office message</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <p className="small muted">
          The message goes into your case as a message from the office, not through the chat. The app reads it and lists the facts it finds, each with Undo.
        </p>
        <label className="field" htmlFor={`${uid}-channel`}>
          <span>How it came</span>
          <select id={`${uid}-channel`} name="import-channel" className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor={`${uid}-from`}>
          <span>Sender</span>
          <input ref={fromRef} id={`${uid}-from`} name="import-from" className="input" value={from} onChange={(e) => setFrom(e.target.value)} required maxLength={200} placeholder="For example, Lantern Hill Clinic" />
        </label>
        <label className="field" htmlFor={`${uid}-received`}>
          <span>{`Received (${getCaseZone()} time)`}</span>
          <input id={`${uid}-received`} name="import-received" className="input" type="datetime-local" value={received} onChange={(e) => setReceived(e.target.value)} required />
        </label>
        <label className="field" htmlFor={`${uid}-text`}>
          <span>Message text</span>
          <textarea id={`${uid}-text`} name="import-text" className="textarea" value={text} onChange={(e) => setText(e.target.value)} required rows={6} maxLength={MAX_MESSAGE} />
        </label>
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={busy || !receivedAt || text.trim() === "" || from.trim() === ""} aria-busy={busy || undefined}>
            Add and read the message
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
