// The undo route's answers for Google refusals (0012). Before this, a
// GoogleBusyError or GoogleError from undoEntry answered 500 server_error,
// and the page showed a generic sentence instead of the reason.
import { describe, expect, it } from "vitest";
import { toErrorResponse } from "../server/api.ts";
import { GoogleError } from "../src/google/http.ts";
import { GoogleBusyError } from "../src/google/intents.ts";

describe("Google refusals on the case routes", () => {
  it("answers 409 google_busy with the plain sentence", () => {
    const busy = "A Google Calendar change for Thursday 11/12 10:30 AM is still in progress. Try again in a moment.";
    expect(toErrorResponse(new GoogleBusyError(busy))).toEqual({ status: 409, body: { error: "google_busy", message: busy } });
  });

  it("answers Google's own refusals with their code and fixed sentence", () => {
    const unavailable = new GoogleError("google_unavailable");
    expect(toErrorResponse(unavailable)).toEqual({ status: 503, body: { error: "google_unavailable", message: unavailable.message } });
    const changed = new GoogleError("google_changed", 412);
    expect(toErrorResponse(changed)).toEqual({ status: 502, body: { error: "google_changed", message: changed.message } });
  });
});
