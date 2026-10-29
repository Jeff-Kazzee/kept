// Sprint 13D fix round 2 (0017): F1, a turn that never ends does not block
// Delete case for good.
import { describe, expect, it } from "vitest";
import { TURN_STALE_MS } from "../src/agent/agent.ts";
import { DeleteBlockedError } from "../src/case/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { CLOCK, agentFor, services } from "./agent-helpers.ts";

describe("sprint 13D fix round 2, F1: a hung turn holds Delete case back for at most five minutes", () => {
  it("counts as running until TURN_STALE_MS after it started, then Delete case runs", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    let now = Date.parse(CLOCK());
    // A model that never answers.
    const hung = { label: "hung", respond: () => new Promise<never>(() => {}) };
    const agent = agentFor(app, hung, { now: () => new Date(now).toISOString() });
    void agent.turn({ text: "What is confirmed?", expectedVersion: agent.chat().chatVersion, generation: app.kase.generation() }, () => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(agent.busy).toBe(true);
    const del = () => app.kase.deleteCase(app.kase.caseVersion(), "DELETE", { turnRunning: () => agent.busy });
    expect(del).toThrow(DeleteBlockedError);
    now += TURN_STALE_MS - 1000;
    expect(del).toThrow(DeleteBlockedError);
    now += 2000;
    expect(agent.busy).toBe(false);
    expect(del().erased).toBeGreaterThan(0);
    expect(TURN_STALE_MS).toBe(5 * 60_000);
  });
});
