// Times in the case time zone with its short name, and errors as plain
// sentences. The zone is America/Denver until settings set another.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api.ts";
import { clockTime, errorSentence, getCaseZone, googleErrorSentence, setCaseZone, shortTime, signInErrorSentence, signInReturn, stampTime, wallNow, wallSkipped, wallToIso, zoneShortName } from "./format.ts";

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
    expect(signInErrorSentence("access_denied")).toBe("ChatGPT sign-in was canceled. Nothing changed. You can try again in Connections.");
    expect(signInErrorSentence("something_new")).toBe("The ChatGPT sign-in did not finish. Nothing changed. Try again in Connections.");
  });

  it("sprint 11: each Google callback code has its own plain sentence, and an unknown code the general one", () => {
    const codes = ["invalid_state", "stale_flow", "access_denied", "no_permission_granted", "code_exchange_failed", "google_unavailable", "no_id_token", "no_refresh_token", "id_token_audience", "id_token_issuer", "id_token_expired", "id_token_nonce", "email_unverified"];
    const general = googleErrorSentence("something_new");
    expect(general).toBe("The Google sign-in did not finish. Nothing changed. Try again in Connections.");
    const sentences = codes.map(googleErrorSentence);
    expect(new Set(sentences).size).toBe(codes.length);
    for (const [i, text] of sentences.entries()) {
      expect(text, codes[i]).not.toBe(general);
      expect(text, codes[i]).toMatch(/^[A-Z].*\.$/);
      expect(text, codes[i]).not.toMatch(/[;\u2014]/);
      expect(text, codes[i]).not.toContain(codes[i]);
    }
    expect(googleErrorSentence("access_denied")).toBe("Google sign-in was canceled. Nothing changed. You can connect again in Connections.");
  });

  it("a sign-in return says what happened and leaves the rest of the address", () => {
    expect(signInReturn(new URLSearchParams("connected=google"))).toEqual({ kind: "info", text: "Connected Google. Settings lists what the assistant may use.", rest: "" });
    expect(signInReturn(new URLSearchParams("google_error=email_unverified&mockchat=1"))).toEqual({ kind: "error", text: googleErrorSentence("email_unverified"), rest: "mockchat=1" });
    expect(signInReturn(new URLSearchParams("signedIn=chatgpt"))?.kind).toBe("info");
    expect(signInReturn(new URLSearchParams("signInError=expired"))).toEqual({ kind: "error", text: signInErrorSentence("expired"), rest: "" });
    expect(signInReturn(new URLSearchParams("mockchat=1"))).toBeNull();
    expect(signInReturn(new URLSearchParams(""))).toBeNull();
  });

  it("sprint 11: a Google refusal reads as the server wrote it, and a stale connection as the page's sentence", () => {
    const redirect = "Google can return only to this app on 127.0.0.1, localhost or an HTTPS address in APP_ALLOWED_HOSTS. Open the app at one of those and try again.";
    expect(errorSentence(new ApiError(422, { error: "redirect_unavailable", message: redirect }))).toBe(redirect);
    expect(errorSentence(new ApiError(503, { error: "google_unavailable", message: "Google did not answer. Nothing changed. Try again in a moment." }))).toBe("Google did not answer. Nothing changed. Try again in a moment.");
    expect(errorSentence(new ApiError(503, { error: "google_not_configured", message: "Google is not set up on this server yet." }))).toBe("Google is not set up on this server yet.");
    const busy = "A Google Calendar change for Thursday 11/12 10:30 AM is still in progress. Try again in a moment.";
    expect(errorSentence(new ApiError(409, { error: "google_busy", message: busy }))).toBe(busy);
    expect(errorSentence(new ApiError(409, { error: "google_stale", message: "The Google connection changed since the page read it. Reload and try again." }))).toBe(
      "The Google connection changed since it was shown. Nothing changed. Settings now shows the current connection.",
    );
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
