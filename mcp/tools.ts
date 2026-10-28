// The MCP tools: the case tools of the in-app agent (src/agent/tools.ts),
// with the same rules, offered over MCP (0009, J2). No grant or tier: the
// person who can start this server can already open the database file.
// An external agent acts as "mcp" in the activity log, and the person can
// undo each action in the app. No tool approves or sends a reply, edits a
// draft's text, enters a fact by hand or deletes the case.
import { CaseActions } from "../src/actions/service.ts";
import type { ActivityEntry } from "../src/activity/types.ts";
import { AGENT_TOOLS, DEFAULT_TOOL_CONTEXT, type ToolContext, type ToolServices, type ToolSpec } from "../src/agent/tools.ts";
import { zonedIso } from "../src/domain/zone.ts";
import type { EventStore } from "../src/store/event-log.ts";

export type McpToolDef = ToolSpec<unknown>;

export const TOOLS: McpToolDef[] = AGENT_TOOLS;

export const toolByName = (name: string): McpToolDef | null => TOOLS.find((t) => t.name === name) ?? null;

// The entry tools/list returns for a tool.
export function toolEntry(t: McpToolDef) {
  return {
    name: t.name,
    title: t.label,
    description: t.description,
    inputSchema: t.parameters as { type: "object"; [key: string]: unknown },
    annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false },
  };
}

// The context a tool call runs in over MCP: no chat message, so
// import_message takes the text it is given, and the actor is "mcp".
export function mcpContext(store: EventStore, services: ToolServices, now: string, onEntry?: (entry: ActivityEntry) => void): ToolContext {
  const zone = services.kase.timeZone();
  return {
    ...services,
    ...DEFAULT_TOOL_CONTEXT,
    store,
    actions: new CaseActions(store, services),
    by: { actor: "mcp", onEntry },
    userText: null,
    sentAt: now,
    zone,
    today: zonedIso(now, zone).slice(0, 10),
    recordImport: (_lines, write) => write(),
  };
}
