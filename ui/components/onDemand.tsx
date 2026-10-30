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
// Muse round 2, finding 7: a part that loaded but could not draw says so,
// not that the connection failed.
export const PART_BROKEN = "This part of the page could not be shown.";

export function onDemand<M>(load: () => Promise<M>) {
  let pending: Tracked<M> | null = null;
  // Boundaries that wait for this chunk: told when a load succeeds, so a
  // Try again in one part also brings back its siblings.
  const loaded = new Set<() => void>();
  const ensure = (): Tracked<M> => {
    if (!pending || pending.status === "rejected") {
      const p = load() as Tracked<M>;
      p.status = "pending";
      p.then(
        (m) => {
          p.status = "fulfilled";
          p.value = m;
          for (const f of loaded) f();
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
        <PartBoundary
          onRetry={() => void ensure().then(undefined, () => {})}
          isLoadFailure={(e) => pending?.status === "rejected" && pending.reason === e}
          onLoaded={(f) => {
            loaded.add(f);
            return () => void loaded.delete(f);
          }}
        >
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

// The part's own space when it failed. A failed load says to check the
// connection, and Try again loads the chunk again. A part that loaded but
// threw while drawing says it could not be shown, and Try again draws it
// again. A load that succeeds anywhere clears every load failure of its
// chunk, so siblings come back together.
type BoundaryProps = {
  children: ReactNode;
  onRetry?: () => void;
  isLoadFailure?: (error: unknown) => boolean;
  onLoaded?: (f: () => void) => () => void;
};

type Failure = { value: unknown; load?: boolean };

export class PartBoundary extends Component<BoundaryProps, { error: Failure | null }> {
  override state: { error: Failure | null } = { error: null };
  #off: (() => void) | null = null;
  static getDerivedStateFromError(value: unknown) {
    return { error: { value } };
  }
  // Whether it was the load that failed, judged when it happened.
  override componentDidCatch(value: unknown) {
    this.setState({ error: { value, load: this.props.isLoadFailure ? this.props.isLoadFailure(value) : true } });
  }
  override componentDidMount() {
    this.#off =
      this.props.onLoaded?.(() => {
        if (this.state.error?.load) this.setState({ error: null });
      }) ?? null;
  }
  override componentWillUnmount() {
    this.#off?.();
  }
  override render() {
    if (!this.state.error) return this.props.children;
    const load = this.state.error.load ?? (this.props.isLoadFailure ? this.props.isLoadFailure(this.state.error.value) : true);
    return (
      <div className="part-error" role="alert">
        <p className="small">{load ? `${PART_FAILED} Check the connection, then try again.` : PART_BROKEN}</p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            if (load) this.props.onRetry?.();
            this.setState({ error: null });
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
