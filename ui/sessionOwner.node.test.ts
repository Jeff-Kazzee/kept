import { describe, expect, it } from "vitest";
import { sessionOwner } from "./App.tsx";

type Session = Parameters<typeof sessionOwner>[0];

describe("final review: a hosted session without an owner never becomes a shared identity", () => {
  it("names hosted accounts only by their owner", () => {
    const judge = (owner?: string) => ({ mode: "hosted", signedIn: true, account: { kind: "judge", email: null, name: null, ...(owner ? { owner } : {}) } }) as unknown as Session;
    expect(sessionOwner(judge("o1"))).toBe("hosted:o1");
    expect(sessionOwner(judge("o2"))).toBe("hosted:o2");
    expect(sessionOwner(judge())).toBe("signed-out");
    expect(sessionOwner(null)).toBe("none");
  });
});
