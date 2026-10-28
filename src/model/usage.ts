// Refusals of a model call on the server key in hosted mode (0014, design
// item 4), and the scope that says what a call was for. A refusal is not a
// ModelCallError: no call was made, so extraction and the conflict calls
// do not record a failed attempt, and nothing else is written. The route
// answers it, and the chat ends the turn with its sentence.
import { AsyncLocalStorage } from "node:async_hooks";
import { USAGE_TEXT, type UsageRefusal } from "./usage-text.ts";

export { USAGE_TEXT, type UsageRefusal };

export class UsageRefusedError extends Error {
  override name = "UsageRefusedError";
  readonly code: UsageRefusal;
  readonly userText: string;
  readonly reason: string;
  constructor(code: UsageRefusal) {
    super(USAGE_TEXT[code].text);
    this.code = code;
    this.userText = USAGE_TEXT[code].text;
    this.reason = USAGE_TEXT[code].reason;
  }
}

// What a call was for: the route that made it, and the chat turn once its
// first call names it, so the turn's nested calls carry it too.
export type UsageScope = { route: string; turn: string | null };

const scope = new AsyncLocalStorage<UsageScope>();

export function withUsageScope<T>(s: UsageScope, fn: () => T): T {
  return scope.run(s, fn);
}

export function usageScope(): UsageScope | undefined {
  return scope.getStore();
}
