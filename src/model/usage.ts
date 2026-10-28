// Refusals of a model call on the server key in hosted mode (0014, design
// item 4), and the scope that says what a call was for. A refusal is not a
// ModelCallError: no call was made, so extraction and the conflict calls
// do not record a failed attempt, and nothing else is written. The route
// answers it, and the chat ends the turn with its sentence.
import { AsyncLocalStorage } from "node:async_hooks";

export type UsageRefusal = "credits_exhausted" | "daily_cap" | "server_key_off";

// Fixed sentences, written by code. The `reason` part is the first
// sentence alone, for a turn that already changed something.
export const USAGE_TEXT: Record<UsageRefusal, { reason: string; text: string }> = {
  credits_exhausted: {
    reason: "Your usage credit has run out, so the assistant did not run this step. To get more, open Settings and then Usage, where you can enter a judge code. Plans to buy credit are coming soon.",
    text: "Your usage credit has run out, so the assistant did not run this step. To get more, open Settings and then Usage, where you can enter a judge code. Plans to buy credit are coming soon. Nothing in your case changed.",
  },
  daily_cap: {
    reason: "This site reached its daily limit for Meta usage, so the assistant did not run this step. Try again tomorrow. Your credit was not charged.",
    text: "This site reached its daily limit for Meta usage, so the assistant did not run this step. Try again tomorrow. Your credit was not charged. Nothing in your case changed.",
  },
  server_key_off: {
    reason: "Meta usage is paused on this site just now, so the assistant did not run this step. Your credit was not charged.",
    text: "Meta usage is paused on this site just now, so the assistant did not run this step. Your credit was not charged. Nothing in your case changed.",
  },
};

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
