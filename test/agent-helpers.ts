// Shared helpers for the case agent tests: services on one store, model
// replies built by hand, a scripted model that answers by rules, and a
// fingerprint of everything only the person may change.
import { CaseAgent, type AgentOptions, type TurnReport } from "../src/agent/agent.ts";
import { RecordedChatClient, fixtureMessageIds, type ChatReply } from "../src/agent/recorded.ts";
import { defaultMessageId } from "../src/agent/tools.ts";
import type { ChatEvent } from "../src/agent/types.ts";
import { CaseService } from "../src/case/service.ts";
import { userOnlyState } from "../src/eval/chat-eval.ts";
import { loadCaseProfile } from "../src/fixtures/load.ts";
import { IntakeService } from "../src/intake/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import type { InputItem, OutputItem, ToolCall, ToolModelClient, ToolReply } from "../src/model/responses.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import type { EventStore } from "../src/store/event-log.ts";
import { fixtureMessage } from "./helpers.ts";

export const CLOCK = () => "2026-11-05T17:00:00.000Z";

export function services(store: EventStore, now: () => string = CLOCK) {
  const client = RecordedModelClient.fromDirectory();
  const intake = new IntakeService(store, client, { now });
  const kase = new CaseService(store, intake, client, { now, userName: loadCaseProfile().user_name });
  const reply = new ReplyService(store, kase, client, { now });
  const records = new RecordsService(store, intake, kase, { newId: (() => { let n = 0; return () => `p-${++n}`; })() });
  return { store, intake, kase, reply, records };
}

export type App = ReturnType<typeof services>;

export function agentFor(app: App, client: ToolModelClient, options: AgentOptions = {}) {
  let n = 0;
  return new CaseAgent(app.store, app, client, {
    now: CLOCK,
    newTurnId: () => `t${++n}`,
    messageIdFor: fixtureMessageIds(defaultMessageId),
    ...options,
  });
}

type EventData = { [E in ChatEvent as E["event"]]: E["data"] };

// Runs one turn the way the page does: at the current chat version and
// case generation. Returns the events and the report.
export async function say(agent: CaseAgent, app: App, text: string, override: { expectedVersion?: number; generation?: number } = {}) {
  const events: ChatEvent[] = [];
  const report: TurnReport = await agent.turn(
    { text, expectedVersion: override.expectedVersion ?? agent.chat().chatVersion, generation: override.generation ?? app.kase.generation() },
    (e) => events.push(e),
  );
  const of = <K extends keyof EventData>(name: K): Array<EventData[K]> => events.filter((e) => e.event === name).map((e) => e.data as EventData[K]);
  return { events, report, of, text: of("text.delta").map((d) => d.text).join("") };
}

// Model output items, as the Responses API returns them.
let seq = 0;
export const reasoning = (): OutputItem => ({ type: "reasoning", id: `rs_${++seq}`, summary: [], encrypted_content: `enc-${seq}` });
export const fnCall = (name: string, args: unknown, id = `${++seq}`): OutputItem => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
  status: "completed",
});
export const message = (text: string): OutputItem => ({
  type: "message",
  id: `msg_${++seq}`,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

export const USAGE = { input: 1200, cached_input: 0, output: 60, reasoning: 20 };

export function reply(...items: OutputItem[]): ChatReply {
  return { output: [reasoning(), ...items], usage: USAGE, latency_ms: 900, first_byte_ms: 300 };
}

export const sequence = (...replies: ChatReply[]) => RecordedChatClient.sequence(replies);

// The person's current message in a request: the last user item that is not
// an app check.
export function currentUserText(input: InputItem[]): string {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as { role?: string; content?: unknown };
    if (item.role === "user" && typeof item.content === "string" && !item.content.startsWith("App check")) return item.content;
  }
  return "";
}

// Function call outputs since the person's current message, by tool name.
export function turnOutputs(input: InputItem[]): Array<{ name: string; output: any }> {
  const start = input.findLastIndex((i) => (i as { role?: string }).role === "user" && !String((i as { content?: unknown }).content).startsWith("App check"));
  const names = new Map<string, string>();
  const out: Array<{ name: string; output: any }> = [];
  for (const item of input.slice(start)) {
    const it = item as Record<string, any>;
    if (it.type === "function_call") names.set(it.call_id, it.name);
    if (it.type === "function_call_output") out.push({ name: names.get(it.call_id) ?? "?", output: JSON.parse(it.output) });
  }
  return out;
}

// A stand-in model that decides by rules: each rule sees the request and
// returns output items, or undefined to pass. For tests and the eval smoke
// test. Never used by the app.
export class RuleModel implements ToolModelClient {
  readonly label = "rule-model";
  readonly calls: ToolCall[] = [];
  readonly #rules: Array<(input: InputItem[], call: ToolCall) => OutputItem[] | undefined>;

  constructor(rules: Array<(input: InputItem[], call: ToolCall) => OutputItem[] | undefined>) {
    this.#rules = rules;
  }

  async respond(request: ToolCall): Promise<ToolReply> {
    this.calls.push(structuredClone(request));
    for (const rule of this.#rules) {
      const items = rule(request.body.input, request);
      if (items) return { output: [reasoning(), ...items], usage: { input: 1200, cachedInput: 0, output: 60, reasoning: 20 }, latencyMs: 900, firstByteMs: 300 };
    }
    return { output: [reasoning(), message("I can help with your appointments.")], usage: { input: 1000, cachedInput: 0, output: 20, reasoning: 5 }, latencyMs: 500, firstByteMs: 200 };
  }
}

// Everything only the person may change. The eval uses the same check.
export const fingerprint = userOnlyState;

export const pasted = (id: string, lead = "Got this from the clinic:") => `${lead}\n\n${fixtureMessage(id).text}`;
export { fixtureMessage };
