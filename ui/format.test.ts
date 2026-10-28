// Times in the case time zone with its short name, and errors as plain
// sentences. The zone is America/Denver until settings set another.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api.ts";
import { clockTime, errorSentence, getCaseZone, setCaseZone, shortTime, signInErrorSentence, stampTime, wallNow, wallSkipped, wallToIso, zoneShortName } from "./format.ts";

// The demo's zone. The app's own default is UTC, as the server's.
setCaseZone("America/Denver");

describe("format", () => {
  it("defaults to UTC, the server's zone, until settings name another", async () => {
    vi.resetModules();
    const fresh = await import("./format.ts");
    expect(fresh.getCaseZone()).toBe("UTC");
    expect(fresh.stampTime("2026-11-01T08:30:00.000Z")).toBe("2026-11-01 08:30 UTC");
  });

  it("times show in America/Denver across the 2026-11-01 change", () => {
    expect(stampTime("2026-11-01T07:30:00.000Z")).toBe("2026-11-01 01:30 MDT");
    expect(stampTime("2026-11-01T08:30:00.000Z")).toBe("2026-11-01 01:30 MST");
    expect(shortTime("2026-11-01T07:30:00.000Z")).toBe("Sun, Nov 1, 1:30 AM MDT");
    expect(shortTime("2026-11-01T08:30:00.000Z")).toBe("Sun, Nov 1, 1:30 AM MST");
  });

  it("reads a received time typed for America/Denver with its offset, across the change", () => {
    expect(wallToIso("2026-10-31T09:12")).toBe("2026-10-31T09:12:00-06:00");
    expect(wallToIso("2026-11-04T11:40")).toBe("2026-11-04T11:40:00-07:00");
    // 01:30 on 2026-11-01 happens twice. The first one, MDT, is used.
    expect(wallToIso("2026-11-01T01:30")).toBe("2026-11-01T01:30:00-06:00");
    expect(wallToIso("2026-11-01T03:00")).toBe("2026-11-01T03:00:00-07:00");
    expect(wallToIso("not a time")).toBeNull();
    expect(wallNow(Date.parse("2026-11-01T08:30:00Z"))).toBe("2026-11-01T01:30");
  });

  it("follows the case time zone the settings name, with its short name", () => {
    expect(getCaseZone()).toBe("America/Denver");
    setCaseZone("Europe/Berlin");
    try {
      expect(stampTime("2026-11-01T08:30:00.000Z")).toBe("2026-11-01 09:30 GMT+1");
      expect(shortTime("2026-10-25T00:30:00.000Z")).toBe("Sun, Oct 25, 2:30 AM GMT+2");
      expect(clockTime("2026-11-01T08:30:00.000Z")).toBe("9:30 AM");
      expect(zoneShortName(undefined, Date.parse("2026-12-01T00:00:00Z"))).toBe("GMT+1");
      // 02:30 on 2026-10-25 happens twice in Berlin. The first one is used.
      expect(wallToIso("2026-10-25T02:30")).toBe("2026-10-25T02:30:00+02:00");
      expect(wallToIso("2026-10-26T09:00")).toBe("2026-10-26T09:00:00+01:00");
    } finally {
      setCaseZone("America/Denver");
    }
    expect(zoneShortName("America/Denver", Date.parse("2026-12-01T00:00:00Z"))).toBe("MST");
    // An explicit zone wins over the case zone.
    expect(stampTime("2026-11-01T08:30:00.000Z", "UTC")).toBe("2026-11-01 08:30 UTC");
  });

  it("Muse round 1, finding 13: refuses a time the clocks skip, and keeps the times on either side", () => {
    expect(wallToIso("2026-03-08T02:30", "America/Denver")).toBeNull();
    expect(wallToIso("2026-03-08T02:00", "America/Denver")).toBeNull();
    expect(wallToIso("2026-03-08T01:59", "America/Denver")).toBe("2026-03-08T01:59:00-07:00");
    expect(wallToIso("2026-03-08T03:00", "America/Denver")).toBe("2026-03-08T03:00:00-06:00");
    expect(wallToIso("2026-03-29T02:30", "Europe/Berlin")).toBeNull();
    expect(wallToIso("2026-03-29T03:30", "Europe/Berlin")).toBe("2026-03-29T03:30:00+02:00");
    expect(wallSkipped("2026-03-08T02:30", "America/Denver")).toBe(true);
    expect(wallSkipped("2026-03-08T03:30", "America/Denver")).toBe(false);
    expect(wallSkipped("not a time", "America/Denver")).toBe(false);
  });

  it("sprint 10: shows the server's own sentence for settings refusals, and a plain one for a failed sign-in", () => {
    const sentence = (status: number, error: string, message: string) => errorSentence(new ApiError(status, { error, message }));
    expect(sentence(422, "provider_not_ready", "Add a Meta Model API key first, then choose Meta. Nothing was changed.")).toBe("Add a Meta Model API key first, then choose Meta. Nothing was changed.");
    expect(sentence(422, "unknown_model", "That model is not in the list for the current provider. Pick one from the list. Nothing was changed.")).toContain("Pick one from the list.");
    expect(sentence(400, "invalid_key", "That does not look like a Meta Model API key. Paste the key on its own, with no spaces. Nothing was saved.")).not.toMatch(/Nothing was saved\. Nothing was saved/);
    expect(errorSentence(new ApiError(503, { error: "settings_busy", retryable: true, message: "The app's settings are busy in another window or process. Try again in a moment. Nothing was changed." }))).toContain("busy in another window");
    expect(errorSentence(new ApiError(400, { error: "invalid_body", issues: [{ path: "expectedVersion", message: "Send the settingsVersion" }] }))).toBe("The page sent a request the app could not read. Nothing was saved.");
    expect(signInErrorSentence("access_denied")).toBe("ChatGPT sign-in was canceled. Nothing changed. You can try again in Settings.");
    expect(signInErrorSentence("something_new")).toBe("The ChatGPT sign-in did not finish. Nothing changed. Try again in Settings.");
  });

  it("an undo the server refused shows the server's reason as it is", () => {
    const blocked = new ApiError(409, { error: "undo_blocked", message: "A reply you approved depends on this fact. Undo that first." });
    expect(errorSentence(blocked)).toBe("A reply you approved depends on this fact. Undo that first.");
    expect(errorSentence(new ApiError(409, { error: "undo_blocked" }))).toContain("Nothing was saved.");
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
