// Until this browser is paired, every /api route answers not_paired, and
// the app shows only this screen. The code is the one the app printed in
// its terminal at start. An agent cannot see it. The session the server
// sets is an HttpOnly cookie that this page cannot read.
import { useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { Icon } from "./components/Icon.tsx";

export function PairingScreen({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setBusy(true);
    try {
      await api.pair(code);
      setCode("");
      onPaired();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The app could not be reached. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="pair-page">
      <form className="card pair-card" onSubmit={(e) => void submit(e)}>
        <div className="brand-mark">
          <Icon name="calendar" />
        </div>
        <h1>Pair this browser with the app</h1>
        <p className="muted">
          Enter the pairing code the app printed in its terminal when it started. The browser stays paired until the app restarts. An agent cannot see that terminal.
        </p>
        <label className="field" htmlFor="pairing-code">
          <span>Pairing code</span>
          <input
            id="pairing-code"
            name="pairing-code"
            className="input pair-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            maxLength={20}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            aria-describedby={message ? "pairing-error" : undefined}
          />
        </label>
        {message && (
          <p id="pairing-error" className="form-error" role="alert">
            <Icon name="alert" size="sm" /> {message}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          Pair
        </button>
      </form>
    </main>
  );
}
