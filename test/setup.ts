// Tests run with no network. Any call to fetch fails the test that made it.
import { beforeAll, beforeEach, vi } from "vitest";

export const NETWORK_BLOCKED = "Network access is blocked in tests.";

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error(NETWORK_BLOCKED);
  });
});

// 0019, P18: the UI loads some cards on demand. Tests render them at once,
// as the page does once their chunk is in.
beforeAll(async () => {
  const cards = "../ui/case/lazyCards.tsx";
  const panel = "../ui/schedule/lazyPanel.tsx";
  const { loadCaseCards } = (await import(cards)) as { loadCaseCards: () => Promise<unknown> };
  const { loadPanel } = (await import(panel)) as { loadPanel: () => Promise<unknown> };
  await Promise.all([loadCaseCards(), loadPanel()]);
});
