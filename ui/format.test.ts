// Times in America/Denver with the zone, and errors as plain sentences.
import { describe, expect, it } from "vitest";
import { ApiError } from "./api.ts";
import { denverShort, denverTime, denverWallNow, denverWallToIso, errorSentence } from "./format.ts";

describe("format", () => {
  it("times show in America/Denver across the 2026-11-01 change", () => {
    expect(denverTime("2026-11-01T07:30:00.000Z")).toBe("2026-11-01 01:30 MDT");
    expect(denverTime("2026-11-01T08:30:00.000Z")).toBe("2026-11-01 01:30 MST");
    expect(denverShort("2026-11-01T07:30:00.000Z")).toBe("Sun, Nov 1, 1:30 AM MDT");
    expect(denverShort("2026-11-01T08:30:00.000Z")).toBe("Sun, Nov 1, 1:30 AM MST");
  });

  it("reads a received time typed for America/Denver with its offset, across the change", () => {
    expect(denverWallToIso("2026-10-31T09:12")).toBe("2026-10-31T09:12:00-06:00");
    expect(denverWallToIso("2026-11-04T11:40")).toBe("2026-11-04T11:40:00-07:00");
    // 01:30 on 2026-11-01 happens twice. The first one, MDT, is used.
    expect(denverWallToIso("2026-11-01T01:30")).toBe("2026-11-01T01:30:00-06:00");
    expect(denverWallToIso("2026-11-01T03:00")).toBe("2026-11-01T03:00:00-07:00");
    expect(denverWallToIso("not a time")).toBeNull();
    expect(denverWallNow(Date.parse("2026-11-01T08:30:00Z"))).toBe("2026-11-01T01:30");
  });

  it("every error reads as a sentence that says nothing was saved, never a raw body", () => {
    const cases = [
      new ApiError(409, { error: "stale_edit", message: "Stale." }),
      new ApiError(409, { error: "case_deleted" }),
      new ApiError(503, { error: "busy" }),
      new ApiError(400, { error: "invalid_body", issues: [{ path: "expectedVersion", message: "Expected number" }] }),
      new ApiError(404, { error: "not_found" }),
      new ApiError(422, { error: "invalid_request", message: "Message m1 was already extracted." }),
      new ApiError(500, {}),
      new TypeError("Failed to fetch"),
      new Error("x"),
    ];
    for (const e of cases) {
      const s = errorSentence(e);
      expect(s).toContain("Nothing was saved.");
      expect(s).not.toMatch(/[{}]|expectedVersion/);
    }
    expect(errorSentence(cases[5])).toBe("Message m1 was already extracted. Nothing was saved.");
  });
});
