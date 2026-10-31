// The schedule panel's tabs and what the shell needs to know of the panel
// without loading it: the count of what waits, the rail's labels and the
// id of an appointment's row (0019, P18).
import type { AppState } from "../api.ts";
import { openOwnReports } from "../case/ownReports.ts";
import type { IconName } from "../components/Icon.tsx";
import { slotIdPart } from "../../src/slots/labels.ts";

// The id of an appointment's row, so a fact chip can open it.
export const slotElementId = (key: string) => `slot-${slotIdPart(key)}`;

export type PanelTab = "schedule" | "checklist" | "activity";

export const TABS: Array<{ id: PanelTab; label: string; icon: IconName }> = [
  { id: "schedule", label: "Schedule", icon: "calendar" },
  { id: "checklist", label: "Checklist", icon: "checklist" },
  { id: "activity", label: "Activity", icon: "activity" },
];

// The name of a tab's button on the laptop's folded rail. The Schedule
// button says how many things wait, as its badge shows (review R4).
export const railLabel = (t: { id: PanelTab; label: string }, waiting: number) => `Open ${t.label}${t.id === "schedule" && waiting > 0 ? `, ${waiting} waiting for you` : ""}`;

// A conflict that waits to be asked about, when no question is open. The
// chat usually asks it. Without the chat, or when the chat cannot answer,
// the Schedule tab offers it (0008, B19).
export function unaskedConflict(state: AppState) {
  if (state.case.question) return undefined;
  return state.case.conflicts.find((c) => c.status === "open" && c.askable && c.archivedSlotKeys.length === 0);
}

// How many things wait for the user: an own-report question, facts no one
// has decided, the open question or a conflict waiting for one, and the
// open reply draft.
export function waitingCount(state: AppState): number {
  return (
    openOwnReports(state).length +
    state.evidence.filter((e) => e.status === "pending").length +
    (state.case.question || unaskedConflict(state) ? 1 : 0) +
    (state.case.reply.draft ? 1 : 0)
  );
}

