// The metered model client for hosted mode (0014, design item 4). Every
// call on the server's Meta key goes through it, and only through it:
//
// 1. The guards first, whatever the balances say: the off switch
//    (APP_SERVER_KEY=off, or no key at all), then a price for the model.
// 2. The call gets max_output_tokens, so its cost has an upper bound.
// 3. A hold of that bound, at the person's price, in one transaction with
//    the balance check and the daily ceiling on Jeff's real cost. A hold
//    the balance or the ceiling cannot cover refuses the call with a fixed
//    sentence, and nothing is written.
// 4. After the call, a charge from the usage the API reported, and a
//    release of the rest. A call that failed after it may have run, with
//    no usage reported, is charged the whole hold. A call that was never
//    sent, or that the API refused with a 4xx answer before it ran, is
//    released.
import { MetaResponsesClient, ModelCallError, assertAllowedModel, type ModelCall, type ModelReply } from "../model/client.ts";
import { BudgetError } from "../model/meter.ts";
import type { LiveClient } from "../model/providers/factory.ts";
import type { TokenUsage } from "../model/request.ts";
import type { ToolCall, ToolReply } from "../model/responses.ts";
import { UsageRefusedError, usageScope } from "../model/usage.ts";
import type { HostedConfig } from "./config.ts";
import { MAX_OUTPUT_TOKENS, chargeMicros, holdFor, inputTokenBound, modelCostMicros, priceOf } from "./prices.ts";
import type { AccountsStore } from "./store.ts";

export type MeteredOptions = {
  store: AccountsStore;
  accountId: string;
  workspace: string;
  config: HostedConfig;
  // The server's Meta key, or null when it has none.
  serverKey: string | null;
  // The Muse model the person chose (models.ts).
  model: () => string;
  metaUrl?: string;
  // For tests: the client the calls go to.
  inner?: LiveClient;
};

// A 4xx answer means the API refused the request before it ran. 408 is a
// timeout, which may have run.
const refusedBeforeRun = (err: unknown) =>
  err instanceof BudgetError || (err instanceof ModelCallError && err.status !== null && err.status >= 400 && err.status < 500 && err.status !== 408);

const turnOf = (key: string) => /^chat-(.+)-\d+$/.exec(key)?.[1] ?? null;

export class MeteredClient implements LiveClient {
  readonly label = "meta-responses";
  readonly #o: MeteredOptions;
  #inner: LiveClient | null;

  constructor(options: MeteredOptions) {
    this.#o = options;
    this.#inner = options.serverKey ? (options.inner ?? new MetaResponsesClient({ apiKey: options.serverKey, url: options.metaUrl })) : null;
  }

  call(request: ModelCall): Promise<ModelReply> {
    return this.#run(request.key, request.body, MAX_OUTPUT_TOKENS.json, (inner, body) => inner.call({ ...request, body: body as ModelCall["body"] }));
  }

  respond(request: ToolCall): Promise<ToolReply> {
    return this.#run(request.key, request.body, MAX_OUTPUT_TOKENS.tool, (inner, body) => inner.respond({ ...request, body: body as ToolCall["body"] }));
  }

  async #run<T extends { usage: TokenUsage }>(key: string, body: object, maxOutput: number, send: (inner: LiveClient, body: object) => Promise<T>): Promise<T> {
    const { store, config } = this.#o;
    const inner = this.#inner;
    if (!config.serverKeyOn || inner === null) throw new UsageRefusedError("server_key_off");
    const model = this.#o.model();
    assertAllowedModel(model);
    const price = priceOf(model);
    // A model with no price is never called on the server key.
    if (!price) throw new UsageRefusedError("server_key_off");
    const asked = (body as { max_output_tokens?: unknown }).max_output_tokens;
    const max = typeof asked === "number" && Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, maxOutput) : maxOutput;
    const sent = { ...body, model, max_output_tokens: max };
    const hold = holdFor(price, inputTokenBound(sent), max, config.markupHundredths);
    const scope = usageScope();
    const turn = turnOf(key);
    if (scope && turn) scope.turn = turn;
    const result = store.hold(
      { accountId: this.#o.accountId, workspace: this.#o.workspace, route: scope?.route ?? "other", turn: turn ?? scope?.turn ?? null, model },
      hold.amountMicros,
      hold.costMicros,
      config.dailyCapMicros,
    );
    if (!result.ok) throw new UsageRefusedError(result.reason === "credits" ? "credits_exhausted" : "daily_cap");
    let reply: T;
    try {
      reply = await send(inner, sent);
    } catch (err) {
      // A settle that fails leaves the hold open, and the stale hold sweep
      // charges it in full.
      try {
        const usage = err instanceof ModelCallError ? err.usage : null;
        if (usage) store.settle(result.holdId, { usage, amountMicros: chargeMicros(price, usage, config.markupHundredths), costMicros: modelCostMicros(price, usage) });
        else if (refusedBeforeRun(err)) store.release(result.holdId);
        else store.settle(result.holdId, null);
      } catch {
        // See above.
      }
      throw err;
    }
    try {
      // A reply with no input tokens reported cannot be a real count, so the
      // whole hold is charged.
      if (reply.usage.input <= 0) store.settle(result.holdId, null);
      else store.settle(result.holdId, { usage: reply.usage, amountMicros: chargeMicros(price, reply.usage, config.markupHundredths), costMicros: modelCostMicros(price, reply.usage) });
    } catch {
      // See above.
    }
    return reply;
  }
}
