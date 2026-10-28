// The activity log contract shared with the web app (0009, design 3). Runs
// in the browser and in Node, so it must not import Node modules.

// "agent" is the in-app assistant, "mcp" an external agent over MCP and
// "you" the person in the app.
export type ActivityActor = "agent" | "you" | "mcp";

export type ActivityTarget = { type: "message" | "claim" | "slot" | "question" | "draft" | "note"; id: string } | null;

export type ActivityEntry = {
  id: string;
  at: string; // ISO with the case time zone's offset
  actor: ActivityActor;
  kind: string; // such as "claim_accepted" or "question_answered"
  summary: string; // a plain sentence code writes
  target: ActivityTarget;
  undoable: boolean;
  undone: boolean;
  undoneAt?: string;
};

export type ActivityView = { activityVersion: number; entries: ActivityEntry[] };

// Why an undo was refused, in a plain sentence code writes. The API answers
// 409 with error "undo_blocked" and this message.
export const UNDO_BLOCKED = "undo_blocked";
