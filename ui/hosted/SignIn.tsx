// The hosted site's sign-in screen (0014, design item 6, and 0020, B9):
// sign in or sign up with an email and password, use a passkey, or use a
// judge code. /judge opens the code form at once. A password or a code
// goes to the server once, and its field is cleared whatever the answer.
// Built with the app's existing classes only.
import { useId, useRef, useState, type FormEvent } from "react";
import { Mark } from "../components/Art.tsx";
import { Icon } from "../components/Icon.tsx";
import { errorSentence } from "../format.ts";
import { AuthError, accountAuth, hostedApi, type SessionInfo } from "./session.ts";

export const judgePath = (pathname: string) => /^\/judge\/?$/.test(pathname);

type Mode = "signin" | "signup" | "judge";
type Busy = "password" | "passkey" | "code" | null;

const sentence = (e: unknown) => (e instanceof AuthError ? e.message : errorSentence(e).replace(/ Nothing was saved\.$/, ""));

export function SignIn({ passwordMin = 10, dashboard = false, notice, onSignedIn }: { passwordMin?: number; dashboard?: boolean; notice: string | null; onSignedIn: (s: SessionInfo, problem?: string | null) => void }) {
  const uid = useId();
  const [mode, setMode] = useState<Mode>(() => (typeof window !== "undefined" && judgePath(window.location.pathname) ? "judge" : "signin"));
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(notice);
  const first = useRef<HTMLInputElement>(null);

  const switchTo = (m: Mode) => {
    setMode(m);
    setError(null);
    setPassword("");
    setCode("");
    requestAnimationFrame(() => first.current?.focus());
  };

  // `problem` is shown in the app once it opens.
  const finish = async (problem: string | null = null) => {
    if (judgePath(window.location.pathname)) window.history.replaceState(null, "", "/");
    onSignedIn(await hostedApi.session(), problem);
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (email.trim() === "" || password === "") return;
    const pw = password;
    const c = code.trim();
    // The page never keeps the password or the code.
    setPassword("");
    setCode("");
    setBusy("password");
    setError(null);
    try {
      if (mode === "signup") await accountAuth.signUp(email.trim(), pw, name.trim());
      else await accountAuth.signIn(email.trim(), pw);
    } catch (err) {
      setError(sentence(err));
      setBusy(null);
      requestAnimationFrame(() => first.current?.focus());
      return;
    }
    // A judge code given at sign-up is added once the account is made.
    let problem: string | null = null;
    if (mode === "signup" && c !== "") {
      try {
        await hostedApi.addJudgeCode(c);
      } catch (err) {
        problem = `Your account is made, but the judge code was not added. ${sentence(err)} You can add a code from Usage.`;
      }
    }
    try {
      await finish(problem);
    } catch (err) {
      setError(sentence(err));
      setBusy(null);
    }
  };

  const usePasskey = async () => {
    setBusy("passkey");
    setError(null);
    try {
      await accountAuth.passkeySignIn();
      await finish();
    } catch (err) {
      setError(sentence(err));
      setBusy(null);
    }
  };

  const submitCode = async (e: FormEvent) => {
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
      setError(sentence(err));
      requestAnimationFrame(() => first.current?.focus());
    } finally {
      setCode("");
      setBusy(null);
    }
  };

  const codeField = (optional: boolean) => (
    <label className="field" htmlFor={`${uid}-code`}>
      <span>{optional ? "Judge code (optional)" : "Judge code"}</span>
      <input
        ref={optional ? undefined : first}
        id={`${uid}-code`}
        name="judge-code"
        className="input"
        type="password"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-describedby={`${uid}-code-hint`}
      />
    </label>
  );

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
        {mode !== "judge" ? (
          <>
            <form className="stack-sm" onSubmit={(e) => void submitPassword(e)} aria-label={mode === "signup" ? "Make an account" : "Sign in"}>
              <label className="field" htmlFor={`${uid}-email`}>
                <span>Email</span>
                <input
                  ref={first}
                  id={`${uid}-email`}
                  name="email"
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete={mode === "signup" ? "email" : "username webauthn"}
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </label>
              {mode === "signup" && (
                <label className="field" htmlFor={`${uid}-name`}>
                  <span>Your name (optional)</span>
                  <input id={`${uid}-name`} name="name" className="input" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} />
                </label>
              )}
              <label className="field" htmlFor={`${uid}-password`}>
                <span>Password</span>
                <input
                  id={`${uid}-password`}
                  name="password"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  minLength={mode === "signup" ? passwordMin : undefined}
                  maxLength={128}
                  required
                  aria-describedby={mode === "signup" ? `${uid}-password-hint` : undefined}
                />
              </label>
              {mode === "signup" && (
                <p id={`${uid}-password-hint`} className="small muted">
                  At least {passwordMin} characters. This site cannot send email, so keep your password somewhere safe.
                </p>
              )}
              {mode === "signup" && codeField(true)}
              {mode === "signup" && (
                <p id={`${uid}-code-hint`} className="small muted">
                  If you were given a code that starts with judge_, add it here for usage credit.
                </p>
              )}
              <button type="submit" className="btn btn-primary btn-block" disabled={busy !== null} aria-busy={busy === "password" || undefined}>
                {mode === "signup" ? "Make my account" : "Sign in"}
              </button>
            </form>
            <p className="small muted">
              {mode === "signup" ? "Already have an account? " : "New here? "}
              <button type="button" className="link-btn" onClick={() => switchTo(mode === "signup" ? "signin" : "signup")}>
                {mode === "signup" ? "Sign in" : "Make an account"}
              </button>
            </p>
            <p className="signin-or" aria-hidden="true">
              <span>or</span>
            </p>
            <button type="button" className="btn btn-block" onClick={() => void usePasskey()} disabled={busy !== null} aria-busy={busy === "passkey" || undefined}>
              <Icon name="key" size="sm" /> Use a passkey
            </button>
            <button type="button" className="btn btn-block" onClick={() => switchTo("judge")} disabled={busy !== null}>
              <Icon name="key" size="sm" /> I have a judge code
            </button>
          </>
        ) : (
          <>
            <form className="stack-sm" onSubmit={(e) => void submitCode(e)} aria-label="Sign in with a judge code">
              {codeField(false)}
              <p id={`${uid}-code-hint`} className="small muted">
                The code you were given starts with judge_. It signs you in to your own account, with usage credit for the Meta models.
              </p>
              <button type="submit" className="btn btn-primary btn-block" disabled={code.trim() === "" || busy !== null} aria-busy={busy === "code" || undefined}>
                Continue
              </button>
            </form>
            <button type="button" className="btn btn-block" onClick={() => switchTo("signin")} disabled={busy !== null}>
              Use an email and password instead
            </button>
          </>
        )}
        <p className="small muted signin-foot">
          Your case is private to your account. All data in the demo is made up. Your password is stored only as a hash.
          {dashboard && " Sign-in events, with your email and network address, also go to Better Auth, the service this site uses for sign-in."}
        </p>
      </div>
    </main>
  );
}
