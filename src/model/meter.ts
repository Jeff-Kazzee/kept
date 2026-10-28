// A usage meter for one unit of work, such as one chat turn (0007, finding
// 10). Every model call made inside `withMeter` checks the meter before it
// starts and adds its tokens after, the agent's own calls and the nested
// extraction, explanation, question and template calls alike. Calls made
// outside a meter, such as a page's own explain request, are not counted.
import { AsyncLocalStorage } from "node:async_hooks";
import type { TokenUsage } from "./request.ts";

// The meter's limit was reached. No call was made.
export class BudgetError extends Error {
  override name = "BudgetError";
  constructor() {
    super("The token limit for this unit of work was reached.");
  }
}

export class UsageMeter {
  readonly limit: number;
  tokens = 0;
  calls = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  get exhausted(): boolean {
    return this.tokens >= this.limit;
  }

  check(): void {
    if (this.exhausted) throw new BudgetError();
  }

  add(usage: TokenUsage): void {
    this.calls++;
    this.tokens += usage.input + usage.output;
  }
}

const scope = new AsyncLocalStorage<UsageMeter>();

export function withMeter<T>(meter: UsageMeter, fn: () => T): T {
  return scope.run(meter, fn);
}

// For model clients: call before a model call.
export function meterCheck(): void {
  scope.getStore()?.check();
}

// For model clients: call with the usage of a finished call.
export function meterAdd(usage: TokenUsage): void {
  scope.getStore()?.add(usage);
}
