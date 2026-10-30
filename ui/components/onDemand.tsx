// 0019, P18: a part of the UI in its own chunk. `ensure` starts the load
// (once). A part always renders as the same three layers: an error
// boundary, a Suspense boundary and the part, so a server render and the
// page's hydration see one structure (0019, P29).
//
// The load is a tracked promise (React's `status` and `value` fields), so
// once the chunk is in, `use` reads it at once and the placeholder never
// flashes. Until then the placeholder holds the part's space.
//
// Round 2, finding 1: a chunk that fails to load never takes the shell
// down. The part's own space says so and offers Try again, which starts a
// fresh load. A failed load is not kept: the next `ensure` loads again.
import { Component, Suspense, use, type ComponentType, type ReactNode } from "react";

type Tracked<M> = Promise<M> & { status?: "pending" | "fulfilled" | "rejected"; value?: M; reason?: unknown };

export const PART_FAILED = "This part of the page did not load.";

export function onDemand<M>(load: () => Promise<M>) {
  let pending: Tracked<M> | null = null;
  const ensure = (): Tracked<M> => {
    if (!pending || pending.status === "rejected") {
      const p = load() as Tracked<M>;
      p.status = "pending";
      p.then(
        (m) => {
          p.status = "fulfilled";
          p.value = m;
        },
        (e: unknown) => {
          p.status = "rejected";
          p.reason = e;
        },
      );
      pending = p;
    }
    return pending;
  };
  function part<P extends object>(pick: (m: M) => ComponentType<P>, name: string, fallback: ReactNode) {
    // In a render the load is read as it stands, a failure included, so a
    // chunk that keeps failing is not fetched again on every render. Only
    // Try again and the callers of `ensure` start a new load.
    function Ready(props: P) {
      const Loaded = pick(use((pending ?? ensure()) as Promise<M>));
      return <Loaded {...props} />;
    }
    function Part(props: P) {
      return (
        <PartBoundary onRetry={() => void ensure().then(undefined, () => {})}>
          <Suspense fallback={fallback}>
            <Ready {...props} />
          </Suspense>
        </PartBoundary>
      );
    }
    Part.displayName = `OnDemand(${name})`;
    return Part;
  }
  return {
    // A plain promise for callers, which may ignore a failure.
    ensure: (): Promise<M> => ensure().then((m) => m),
    part,
    isLoaded: () => pending?.status === "fulfilled",
  };
}

// The part's own space when its chunk failed: a sentence and Try again.
// Try again renders the part anew, which loads the chunk again.
export class PartBoundary extends Component<{ children: ReactNode; onRetry?: () => void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="part-error" role="alert">
        <p className="small">{PART_FAILED} Check the connection, then try again.</p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            this.props.onRetry?.();
            this.setState({ failed: false });
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
