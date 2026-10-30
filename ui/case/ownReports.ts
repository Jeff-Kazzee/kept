import type { AppState } from "../api.ts";

// The messages whose question waits for the person. Apart from the card, so
// the schedule counts them without loading it (0019, P18).
export const openOwnReports = (state: Pick<AppState, "messages">) => state.messages.filter((m) => m.ownReport === "offered");
