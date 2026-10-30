// 0019, P18: a part of the UI in its own chunk. `ensure` starts the load
// (once). Until the chunk is in, a part renders through Suspense with a
// placeholder that holds its space. Once it is in, every part renders at
// once, with no Suspense pass, so a part that shows later never flashes its
// placeholder.
import { Suspense, lazy, type ComponentType, type ReactNode } from "react";

export function onDemand<M>(load: () => Promise<M>) {
  let loaded: M | null = null;
  let pending: Promise<M> | null = null;
  const ensure = (): Promise<M> => {
    pending ??= load().then(
      (m) => (loaded = m),
      (e: unknown) => {
        pending = null;
        throw e;
      },
    );
    return pending;
  };
  function part<P extends object>(pick: (m: M) => ComponentType<P>, name: string, fallback: ReactNode) {
    const Lazy = lazy(async () => ({ default: pick(await ensure()) }));
    function Part(props: P) {
      if (loaded) {
        const Ready = pick(loaded);
        return <Ready {...props} />;
      }
      return (
        <Suspense fallback={fallback}>
          <Lazy {...props} />
        </Suspense>
      );
    }
    Part.displayName = `OnDemand(${name})`;
    return Part;
  }
  return { ensure, part, isLoaded: () => loaded !== null };
}
