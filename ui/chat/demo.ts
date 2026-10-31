// The demo for judges: the synthetic messages m1 to m4 from the fixtures,
// in the order the office sent them, and the demo calendar. "Load the demo"
// loads the calendar and puts the first message in the composer. Each next
// message is one tap away.
import type { AppState, FixtureScenario } from "../api.ts";

export const DEMO_IDS = ["m1", "m2", "m3", "m4"];

export type FixtureMessage = FixtureScenario["messages"][number];

// The first demo message not yet in the case, or null.
export function nextDemoMessage(fixtures: FixtureMessage[], state: Pick<AppState, "messages">): FixtureMessage | null {
  const imported = new Set(state.messages.map((m) => m.id));
  for (const id of DEMO_IDS) {
    if (imported.has(id)) continue;
    return fixtures.find((m) => m.id === id) ?? null;
  }
  return null;
}

// 0019, P17: the fixtures load on demand, once. A failed load is tried
// again at the next call. `onLoad` gets the messages, each id once.
export function createFixturesLoader(read: () => Promise<FixtureScenario[]>, onLoad: (list: FixtureMessage[]) => void = () => {}) {
  let pending: Promise<FixtureMessage[]> | null = null;
  return () => {
    pending ??= read().then(
      (s) => {
        const list = s.flatMap((x) => x.messages).filter((m, i, all) => all.findIndex((y) => y.id === m.id) === i);
        onLoad(list);
        return list;
      },
      () => {
        pending = null;
        return [];
      },
    );
    return pending;
  };
}
