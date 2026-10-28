// Slot keys and the words the UI shows for slots, states and sources. Runs
// in the browser and in Node, so it must not import Node modules.
import { weekdayOf } from "../domain/datetime.ts";
import type { SlotState, SourceType } from "../domain/claim.ts";

// Slot identity is date plus time. A slot with no known time is keyed by
// its date alone.
export function slotKey(date: string, time: string | null): string {
  return time === null ? date : `${date}T${time}`;
}

// A form of the slot key that is safe in ids and file names:
// 2026-11-12T10:30 becomes 20261112-1030.
export function slotIdPart(key: string): string {
  return key.replace(/-/g, "").replace("T", "-").replace(":", "");
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function dateLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${WEEKDAY_NAMES[weekdayOf(date)]} ${m}/${d}`;
}

export function timeLabel(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// "Thursday 11/12 10:30 AM", or "Monday 11/16, no time".
export function slotLabel(date: string, time: string | null): string {
  return time === null ? `${dateLabel(date)}, no time` : `${dateLabel(date)} ${timeLabel(time)}`;
}

export function sourceLabel(source: SourceType, agentName: string | null = null): string {
  switch (source) {
    case "office_message":
      return "office message";
    case "reported_by_user":
      return "reported by you";
    case "reported_by_user_via_agent":
      return `reported by you through ${agentName ?? "an agent"}`;
  }
}

const STATE_WORDS: Record<SlotState, string> = {
  offered: "Offered",
  requested: "Requested",
  confirmed: "Confirmed",
  change_proposed: "Confirmed",
  canceled: "Canceled",
  declined: "Declined",
};

// "Confirmed · office message", or for a change proposal
// "Confirmed · office message, change proposed". The source is the source of
// the evidence that set the state.
export function stateLabel(state: SlotState, source: string): string {
  const base = `${STATE_WORDS[state]} · ${source}`;
  return state === "change_proposed" ? `${base}, change proposed` : base;
}

// What a state means for the user, in words code chooses. The MCP server
// returns it so an agent need not guess, for example, that a requested
// slot is not booked yet.
const STATE_MEANINGS: Record<SlotState, string> = {
  offered: "The office offered this time. You have not accepted it.",
  requested: "You asked the office for this time. The office has not confirmed it yet.",
  confirmed: "This time is confirmed.",
  change_proposed: "This time is confirmed, but a change to it is proposed and not settled.",
  canceled: "This time is canceled.",
  declined: "You declined this time.",
};

export const stateMeaning = (state: SlotState): string => STATE_MEANINGS[state];
