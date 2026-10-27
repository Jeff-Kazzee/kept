// Tests run with no network. Any call to fetch fails the test that made it.
import { beforeEach, vi } from "vitest";

export const NETWORK_BLOCKED = "Network access is blocked in tests.";

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error(NETWORK_BLOCKED);
  });
});
