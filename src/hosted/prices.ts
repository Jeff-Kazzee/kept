// The price table and the cost math for usage credits (0014, design item
// 4). Every amount is an integer in micro-dollars, and every product is
// taken in BigInt, so no float ever touches money. A cost is rounded up to
// the next micro-dollar, so rounding never sells usage below its cost.
import type { TokenUsage } from "../model/request.ts";

// Dollars per million tokens, written as micro-dollars per million tokens
// (1.25 USD is 1_250_000).
export type ModelPrice = { model: string; input: number; cachedInput: number; output: number; source: string };

export const PRICES: readonly ModelPrice[] = [
  {
    model: "muse-spark-1.3",
    input: 1_250_000,
    cachedInput: 150_000,
    output: 4_250_000,
    source: "PRICES_PER_MILLION in src/eval/eval.ts, the eval's standard prices, 2026-10-28.",
  },
  {
    model: "muse-wonder-1.0",
    input: 4_000_000,
    cachedInput: 200_000,
    output: 20_000_000,
    source: "Jeff's sprint 13 decision, 2026-10-28. The eval has no Wonder price yet.",
  },
];

export function priceOf(model: string): ModelPrice | null {
  return PRICES.find((p) => p.model === model) ?? null;
}

// Every call on the server key sets max_output_tokens, so its hold has an
// upper bound. Reasoning tokens count toward it.
export const MAX_OUTPUT_TOKENS = { json: 4_096, tool: 8_192 } as const;

const MILLION = 1_000_000n;
const HUNDRED = 100n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// The tokens a usage report bills as output. The Responses API counts
// reasoning tokens inside output_tokens. A report whose reasoning count is
// above its output count is read as counting them apart, and both are
// billed.
export function billedOutput(usage: TokenUsage): number {
  return usage.reasoning > usage.output ? usage.output + usage.reasoning : usage.output;
}

// The model's own cost of a call in micro-dollars: what Jeff pays Meta.
// Cached input is billed at the cached price, the rest of the input at the
// input price.
export function modelCostMicros(price: ModelPrice, usage: TokenUsage): number {
  const cached = BigInt(Math.min(usage.cachedInput, usage.input));
  const fresh = BigInt(usage.input) - cached;
  const scaled = fresh * BigInt(price.input) + cached * BigInt(price.cachedInput) + BigInt(billedOutput(usage)) * BigInt(price.output);
  return Number(ceilDiv(scaled, MILLION));
}

// What the person pays for a call: the model's cost times the markup,
// rounded up once over the whole product.
export function chargeMicros(price: ModelPrice, usage: TokenUsage, markupHundredths: number): number {
  const cached = BigInt(Math.min(usage.cachedInput, usage.input));
  const fresh = BigInt(usage.input) - cached;
  const scaled = fresh * BigInt(price.input) + cached * BigInt(price.cachedInput) + BigInt(billedOutput(usage)) * BigInt(price.output);
  return Number(ceilDiv(scaled * BigInt(markupHundredths), MILLION * HUNDRED));
}

// An upper bound on the input tokens of a request: its UTF-8 bytes. A
// token stands for at least one byte, so a request never has more tokens
// than bytes.
export function inputTokenBound(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

// The hold before a call: the input bound at the input price plus the
// call's max output tokens at the output price, as the model's cost and as
// the person's charge.
export function holdFor(price: ModelPrice, inputTokens: number, maxOutputTokens: number, markupHundredths: number): { costMicros: number; amountMicros: number } {
  const usage = { input: inputTokens, cachedInput: 0, output: maxOutputTokens, reasoning: 0 };
  return { costMicros: modelCostMicros(price, usage), amountMicros: chargeMicros(price, usage, markupHundredths) };
}

// A rough cost of one chat turn at the person's price, for the model
// picker: three model calls of 6,000 input and 600 output tokens each, a
// turn that reads the case, runs a tool and answers. Shown as "about".
export const TYPICAL_TURN: TokenUsage = { input: 18_000, cachedInput: 0, output: 1_800, reasoning: 0 };

export function turnCostMicros(model: string, markupHundredths: number): number | null {
  const price = priceOf(model);
  return price ? chargeMicros(price, TYPICAL_TURN, markupHundredths) : null;
}
