// The hosted site's sign-in screen (0014, design item 6): Sign in with
// Google, or a judge code. /judge opens the code form at once. A code goes
// to the server once, and the field is cleared whatever the answer.
import { useId, useRef, useState, type FormEvent } from "react";
import { safeAuthorizeUrl } from "../agentApi.ts";
import { Mark } from "../components/Art.tsx";
import { Icon } from "../components/Icon.tsx";
import { errorSentence } from "../format.ts";
import { hostedApi, type SessionInfo } from "./session.ts";

export const judgePath = (pathname: string) => /^\/judge\/?$/.test(pathname);

export function SignIn({ googleSignIn, notice, onSignedIn }: { googleSignIn: boolean; notice: string | null; onSignedIn: (s: SessionInfo) => void }) {
  const uid = useId();
  const [codeOpen, setCodeOpen] = useState(() => typeof window !== "undefined" && judgePath(window.location.pathname));
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"google" | "code" | null>(null);
  const [error, setError] = useState<string | null>(notice);
  const field = useRef<HTMLInputElement>(null);

  const google = async () => {
    setBusy("google");
    setError(null);
    try {
      const { authorizeUrl } = await hostedApi.googleStart();
      const url = safeAuthorizeUrl(authorizeUrl, window.location.origin);
      if (!url) throw new Error("The sign-in address was not one this site opens.");
      window.location.assign(url);
    } catch (e) {
      setError(errorSentence(e).replace(/ Nothing was saved\.$/, ""));
      setBusy(null);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (c === "") return;
    setBusy("code");
    setError(null);
    try {
      const s = await hostedApi.judgeSignIn(c);
      if (judgePath(window.location.pathname)) window.history.replaceState(null, "", "/");
      onSignedIn(s);
    } catch (err) {
      setError(errorSentence(err).replace(/ Nothing was saved\.$/, ""));
      requestAnimationFrame(() => field.current?.focus());
    } finally {
      // The page never keeps the code.
      setCode("");
      setBusy(null);
    }
  };

  return (
    <main className="signin">
      <div className="signin-card card">
        <span className="welcome-mark" aria-hidden="true">
          <Mark size={24} />
        </span>
        <h1 className="signin-title">Appointment assistant</h1>
        <p className="muted">Keep track of changes to your appointments. Paste a message from the office, and the assistant reads it, checks it and keeps your schedule.</p>
        {error && (
          <p className="warn-box" role="alert">
            {error}
          </p>
        )}
        {googleSignIn && (
          <button type="button" className="btn btn-primary btn-block" onClick={() => void google()} disabled={busy !== null} aria-busy={busy === "google" || undefined}>
            <Icon name="google" size="sm" /> Sign in with Google
          </button>
        )}
        {googleSignIn && (
          <p className="signin-or" aria-hidden="true">
            <span>or</span>
          </p>
        )}
        {!codeOpen ? (
          <button
            type="button"
            className="btn btn-block"
            onClick={() => {
              setCodeOpen(true);
              requestAnimationFrame(() => field.current?.focus());
            }}
          >
            <Icon name="key" size="sm" /> I have a judge code
          </button>
        ) : (
          <form className="stack-sm" onSubmit={(e) => void submit(e)} aria-label="Sign in with a judge code">
            <label className="field" htmlFor={`${uid}-code`}>
              <span>Judge code</span>
              <input
                ref={field}
                id={`${uid}-code`}
                name="judge-code"
                className="input"
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby={`${uid}-hint`}
              />
            </label>
            <p id={`${uid}-hint`} className="small muted">
              The code you were given starts with judge_. It signs you in to your own account, with usage credit for the Meta models.
            </p>
            <button type="submit" className="btn btn-primary btn-block" disabled={code.trim() === "" || busy !== null} aria-busy={busy === "code" || undefined}>
              Continue
            </button>
          </form>
        )}
        <p className="small muted signin-foot">Your case is private to your account. All data in the demo is made up. Sign in with Google shares only your name and email with this site.</p>
      </div>
    </main>
  );
}
