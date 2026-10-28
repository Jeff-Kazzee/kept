// The screen when the case cannot be read: the mark, the reason in a plain
// sentence, and Try again, which reads the case again. Any refusal lands
// here, an unexpected 401 included, never an inert page (Muse round 1,
// findings 1 and 2).
import { Mark } from "./Art.tsx";

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="loading">
      <span className="welcome-mark" aria-hidden="true">
        <Mark size={24} />
      </span>
      <h1 className="loading-title">The app did not answer</h1>
      <p role="alert">{message}</p>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Try again
      </button>
    </main>
  );
}
