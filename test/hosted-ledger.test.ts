// Usage credits, design item 4 (0014): the price math, the hold before a
// call, the charge after it, and the ledger's rules under random and
// concurrent use. Money is integers in micro-dollars throughout.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, formatBalance, formatCharge, formatUsd, parseUsd, readHostedConfig } from "../src/hosted/config.ts";
import { MeteredClient } from "../src/hosted/metered.ts";
import { MAX_OUTPUT_TOKENS, PRICES, billedOutput, chargeMicros, holdFor, inputTokenBound, modelCostMicros, priceOf, turnCostMicros } from "../src/hosted/prices.ts";
import { AccountsStore, STALE_HOLD_MS } from "../src/hosted/store.ts";
import { ModelCallError } from "../src/model/client.ts";
import type { LiveClient } from "../src/model/providers/factory.ts";
import type { TokenUsage } from "../src/model/request.ts";
import { UsageRefusedError, withUsageScope } from "../src/model/usage.ts";

const dirs: string[] = [];
const stores: AccountsStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  dirs.push(dir);
  return path.join(dir, "hosted", "accounts.sqlite");
}

function newStore(file = tempFile(), now?: () => number) {
  const s = new AccountsStore(file, now ? { now } : {});
  stores.push(s);
  return s;
}

const account = (s: AccountsStore, sub = `sub-${Math.random()}`) => s.googleAccount({ sub, email: `${sub}@example.com`, name: null }).id;

// A small seeded generator, so a failing run can be repeated.
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

const spark = priceOf("muse-spark-1.3")!;
const wonder = priceOf("muse-wonder-1.0")!;
const usage = (input: number, cachedInput: number, output: number, reasoning = 0): TokenUsage => ({ input, cachedInput, output, reasoning });
// J19: both caps must be set for the server key to be on.
const config = (over: Record<string, string> = {}) => readHostedConfig({ APP_MODE: "hosted", APP_DAILY_COST_CAP_USD: "20", APP_JUDGE_TOTAL_CAP_USD: "100", ...over });

describe("prices and config", () => {
  it("has the handoff's prices, per million tokens, in micro-dollars", () => {
    expect(PRICES.map((p) => [p.model, p.input, p.cachedInput, p.output])).toEqual([
      ["muse-spark-1.3", 1_250_000, 150_000, 4_250_000],
      ["muse-wonder-1.0", 4_000_000, 200_000, 20_000_000],
    ]);
    for (const p of PRICES) expect(p.source.length).toBeGreaterThan(10);
  });

  it("prices cached input apart, counts reasoning as output, and rounds up once", () => {
    // 1,000,000 fresh input tokens of Spark cost exactly $1.25.
    expect(modelCostMicros(spark, usage(1_000_000, 0, 0))).toBe(1_250_000);
    expect(modelCostMicros(spark, usage(1_000_000, 1_000_000, 0))).toBe(150_000);
    expect(modelCostMicros(spark, usage(0, 0, 1_000_000))).toBe(4_250_000);
    // Reasoning inside output is not counted twice.
    expect(billedOutput(usage(0, 0, 100, 40))).toBe(100);
    // Review round 1, finding 1: output_tokens alone. A report with more
    // reasoning than output is charged the whole hold (metered.ts).
    expect(billedOutput(usage(0, 0, 10, 40))).toBe(10);
    // One input token of Spark is 1.25 micro-dollars: 2 after rounding up.
    expect(modelCostMicros(spark, usage(1, 0, 0))).toBe(2);
    // Times 3: 3.75 rounds up to 4, once over the whole product.
    expect(chargeMicros(spark, usage(1, 0, 0), 300)).toBe(4);
    // (800 x 4.00 + 200 x 0.20 + 100 x 20.00) x 3 = 15,720 micro-dollars.
    expect(chargeMicros(wonder, usage(1_000, 200, 100), 300)).toBe(15_720);
  });

  it("the charge is never below markup times cost, and at most one micro-dollar above", () => {
    const r = rng(7);
    for (let i = 0; i < 2_000; i++) {
      const input = Math.floor(r() * 200_000);
      const u = usage(input, Math.floor(r() * input), Math.floor(r() * 20_000), Math.floor(r() * 5_000));
      for (const p of PRICES) {
        for (const m of [100, 250, 300]) {
          // Exact cost in micro-dollars times 10^6, as BigInt.
          const exact = (BigInt(u.input - u.cachedInput) * BigInt(p.input) + BigInt(u.cachedInput) * BigInt(p.cachedInput) + BigInt(billedOutput(u)) * BigInt(p.output)) * BigInt(m);
          const c = BigInt(chargeMicros(p, u, m)) * 100_000_000n;
          expect(c >= exact).toBe(true);
          expect(c - exact < 100_000_000n).toBe(true);
        }
      }
    }
  });

  it("holds the input bound and the max output at the person's price", () => {
    const body = { input: "héllo", instructions: "x".repeat(100) };
    const bound = inputTokenBound(body);
    expect(bound).toBe(Buffer.byteLength(JSON.stringify(body)));
    const h = holdFor(spark, bound, MAX_OUTPUT_TOKENS.tool, 300);
    expect(h.amountMicros).toBe(chargeMicros(spark, usage(bound, 0, MAX_OUTPUT_TOKENS.tool), 300));
    expect(h.costMicros).toBe(modelCostMicros(spark, usage(bound, 0, MAX_OUTPUT_TOKENS.tool)));
    expect(turnCostMicros("muse-spark-1.3", 300)).toBeGreaterThan(0);
    expect(turnCostMicros("unknown", 300)).toBeNull();
  });

  it("reads the config with its defaults, and refuses a bad value", () => {
    expect(config()).toEqual({ mode: "hosted", markupHundredths: 300, dailyCapMicros: 20_000_000, judgeTotalCapMicros: 100_000_000, serverKeyOn: true, trustedProxy: "none", missing: [] });
    expect(readHostedConfig({})).toMatchObject({ mode: "local" });
    expect(config({ APP_MARKUP: "2.5", APP_DAILY_COST_CAP_USD: "7.25", APP_SERVER_KEY: "off" })).toMatchObject({ markupHundredths: 250, dailyCapMicros: 7_250_000, serverKeyOn: false });
    expect(() => readHostedConfig({ APP_MODE: "cloud" })).toThrow(ConfigError);
    for (const env of [{ APP_MARKUP: "0.5" }, { APP_MARKUP: "3.001" }, { APP_MARKUP: "1e3" }, { APP_DAILY_COST_CAP_USD: "-1" }, { APP_SERVER_KEY: "maybe" }, { APP_JUDGE_TOTAL_CAP_USD: "lots" }]) {
      expect(() => config(env), JSON.stringify(env)).toThrow(ConfigError);
    }
    expect(parseUsd("0.000001")).toBe(1);
    expect(parseUsd("0.0000001")).toBeNull();
    // The page shows a balance rounded down to cents and a charge rounded
    // up to four decimals.
    expect([formatBalance(4_982_675), formatBalance(9_999), formatBalance(-5)]).toEqual(["$4.98", "$0.00", "$0.00"]);
    expect([formatCharge(17_325), formatCharge(1), formatCharge(1_250_000)]).toEqual(["$0.0174", "$0.0001", "$1.25"]);
    expect([formatUsd(0), formatUsd(1), formatUsd(1_250_000), formatUsd(20_000_000), formatUsd(12_345)]).toEqual(["$0.00", "$0.000001", "$1.25", "$20.00", "$0.012345"]);
  });
});

describe("the ledger", () => {
  const ctx = (accountId: string) => ({ accountId, workspace: accountId, route: "chat", turn: "t1", model: "muse-spark-1.3" });
  const CAP = 1_000_000_000;

  it("the balance is grants minus charges minus open holds, and a charge releases the rest", () => {
    const s = newStore();
    const a = account(s);
    s.grant(a, 1_000_000, "judge:j000000000000");
    const h = s.hold(ctx(a), 300_000, 100_000, CAP);
    expect(h.ok).toBe(true);
    expect(s.balance(a)).toBe(700_000);
    s.settle((h as { holdId: number }).holdId, { usage: usage(10, 0, 5), amountMicros: 120_000, costMicros: 40_000 });
    expect(s.balance(a)).toBe(880_000);
    expect(s.ledger(a).map((r) => [r.kind, r.amount, r.open])).toEqual([
      ["grant", 1_000_000, false],
      ["hold", 300_000, false],
      ["charge", 120_000, false],
      ["release", 180_000, false],
    ]);
    // Settling twice does nothing.
    expect(s.settle((h as { holdId: number }).holdId, null)).toEqual({ charged: 0 });
    expect(s.balance(a)).toBe(880_000);
  });

  it("refuses a hold the balance cannot cover and writes nothing", () => {
    const s = newStore();
    const a = account(s);
    s.grant(a, 100, "judge:j000000000000");
    expect(s.hold(ctx(a), 101, 1, CAP)).toEqual({ ok: false, reason: "credits" });
    expect(s.ledger(a).map((r) => r.kind)).toEqual(["grant"]);
    expect(s.hold(ctx(a), 100, 1, CAP).ok).toBe(true);
    expect(s.balance(a)).toBe(0);
    expect(s.hold(ctx(a), 1, 1, CAP)).toEqual({ ok: false, reason: "credits" });
  });

  it("a charge above its hold is cut to the hold, so the balance stays at zero or more", () => {
    const s = newStore();
    const a = account(s);
    s.grant(a, 1_000, "g");
    const h = s.hold(ctx(a), 600, 1, CAP) as { holdId: number };
    s.settle(h.holdId, { usage: usage(1, 0, 1), amountMicros: 5_000, costMicros: 2_000 });
    // Review round 1, finding 1: never more than the hold, nor its cost.
    expect(s.balance(a)).toBe(400);
    expect(s.charges(a)[0]!.amountMicros).toBe(600);
    expect(s.ledger(a).find((r) => r.kind === "charge")!.cost).toBe(1);
  });

  it("property: random grants, holds, charges, releases and adjustments never leave a negative balance, and the sums are exact", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const s = newStore();
      const a = account(s);
      let credit = 0;
      let charged = 0;
      const open = new Map<number, number>();
      for (let step = 0; step < 120; step++) {
        const pick = r();
        if (pick < 0.15) {
          const g = 1 + Math.floor(r() * 50_000);
          s.grant(a, g, "g");
          credit += g;
        } else if (pick < 0.55) {
          const amount = Math.floor(r() * 30_000);
          const before = s.balance(a);
          const h = s.hold(ctx(a), amount, Math.floor(amount / 3), CAP);
          expect(h.ok).toBe(before >= amount);
          if (h.ok) open.set(h.holdId, amount);
        } else if (pick < 0.85 && open.size > 0) {
          const [id, amount] = [...open][Math.floor(r() * open.size)]!;
          open.delete(id);
          const mode = r();
          if (mode < 0.2) s.release(id);
          else {
            const want = mode < 0.6 ? Math.floor(r() * amount) : mode < 0.8 ? null : amount + Math.floor(r() * 10_000);
            charged += s.settle(id, want === null ? null : { usage: usage(1, 0, 1), amountMicros: want, costMicros: 1 }).charged;
          }
        } else if (pick < 0.92) {
          const adj = Math.floor((r() - 0.6) * 20_000) || 1;
          credit += s.adjust(a, adj, "admin");
        } else {
          s.sweepSessions();
        }
        const held = [...open.values()].reduce((x, y) => x + y, 0);
        const balance = s.balance(a);
        expect(balance, `seed ${seed} step ${step}`).toBeGreaterThanOrEqual(0);
        expect(balance).toBe(credit - charged - held);
        // Every closed hold has its charge and release summing to the hold,
        // or a charge above it that the balance covered.
        const rows = s.ledger(a);
        for (const hold of rows.filter((x) => x.kind === "hold" && !x.open)) {
          const parts = rows.filter((x) => x.holdId === hold.id);
          const sum = parts.filter((x) => x.kind === "charge" || x.kind === "release").reduce((x, y) => x + y.amount, 0);
          expect(sum).toBeGreaterThanOrEqual(hold.amount);
        }
        expect(rows.every((x) => Number.isSafeInteger(x.amount))).toBe(true);
      }
    }
  });

  it("concurrent holds from two connections never overspend", async () => {
    const file = tempFile();
    const s1 = newStore(file);
    const s2 = newStore(file);
    const a = account(s1);
    s1.grant(a, 1_000_000, "g");
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => Promise.resolve().then(() => (i % 2 ? s1 : s2).hold(ctx(a), 100_000, 1, CAP))),
    );
    expect(results.filter((x) => x.ok)).toHaveLength(10);
    expect(s1.balance(a)).toBe(0);
    expect(s2.balance(a)).toBe(0);
  });

  it("concurrent metered calls on one account hold before they run, and never overspend", async () => {
    const s = newStore();
    const a = account(s);
    s.grant(a, 5 * 1_000_000, "g");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const inner: LiveClient = {
      label: "fake",
      call: async () => {
        calls++;
        await gate;
        return { outputText: "{}", usage: usage(500, 0, 50), latencyMs: 1 };
      },
      respond: async () => {
        throw new Error("unused");
      },
    };
    const client = new MeteredClient({ store: s, accountId: a, workspace: a, config: config(), serverKey: "k", model: () => "muse-wonder-1.0", inner });
    const body = { model: "muse-wonder-1.0", store: false as const, reasoning: { effort: "low" as const }, instructions: "x".repeat(2_500), input: "y", text: { format: { type: "json_schema" as const, name: "n", schema: {}, strict: false as const } } };
    const runs = Array.from({ length: 20 }, () => withUsageScope({ route: "extract", turn: null }, () => client.call({ key: "m1", attempt: 1, effort: "low", body })).then(
      () => "ok",
      (e) => (e instanceof UsageRefusedError ? e.code : "other"),
    ));
    await new Promise((r) => setTimeout(r, 20));
    const held = s.ledger(a).filter((x) => x.kind === "hold" && x.open);
    // Every call that started holds its bound, and the rest were refused
    // before they ran.
    expect(held.length).toBe(calls);
    expect(held.length * held[0]!.amount).toBeLessThanOrEqual(5_000_000);
    release();
    const outcomes = await Promise.all(runs);
    expect(outcomes.filter((x) => x === "ok")).toHaveLength(calls);
    expect(outcomes.filter((x) => x === "credits_exhausted")).toHaveLength(20 - calls);
    expect(s.balance(a)).toBe(5_000_000 - calls * chargeMicros(wonder, usage(500, 0, 50), 300));
    expect(s.charges(a).every((c) => c.route === "extract" && c.model === "muse-wonder-1.0" && c.input === 500)).toBe(true);
  });

  it("the daily ceiling counts charges and open holds across accounts, by UTC day", () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    const s = newStore(tempFile(), () => now);
    const a = account(s, "a");
    const b = account(s, "b");
    s.grant(a, 100_000_000, "g");
    s.grant(b, 100_000_000, "g");
    const h = s.hold(ctx(a), 1_000, 600, 1_000) as { holdId: number };
    expect(s.hold(ctx(b), 1_000, 500, 1_000)).toEqual({ ok: false, reason: "daily_cap" });
    s.settle(h.holdId, { usage: usage(1, 0, 1), amountMicros: 900, costMicros: 300 });
    expect(s.dayCost()).toBe(300);
    expect(s.hold(ctx(b), 1_000, 700, 1_000).ok).toBe(true);
    now = Date.parse("2026-11-02T00:00:01Z");
    // The new day counts only the hold still open.
    expect(s.dayCost()).toBe(700);
  });

  it("a hold left open by a stopped process is charged in full", () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    const s = newStore(tempFile(), () => now);
    const a = account(s);
    s.grant(a, 10_000, "g");
    s.hold(ctx(a), 4_000, 1, CAP);
    expect(s.settleStaleHolds()).toBe(0);
    now += STALE_HOLD_MS + 1;
    expect(s.settleStaleHolds()).toBe(1);
    expect(s.balance(a)).toBe(6_000);
    expect(s.charges(a)[0]).toMatchObject({ amountMicros: 4_000, wholeHold: true });
  });
});

describe("the metered client", () => {
  const body = { model: "muse-spark-1.3", store: false as const, reasoning: { effort: "low" as const }, instructions: "x".repeat(2_500), input: "y", text: { format: { type: "json_schema" as const, name: "n", schema: {}, strict: false as const } } };
  const setup = (inner: Partial<LiveClient>, over: Record<string, string> = {}, grant = 10_000_000) => {
    const s = newStore();
    const a = account(s);
    if (grant > 0) s.grant(a, grant, "g");
    const sent: unknown[] = [];
    const full: LiveClient = {
      label: "fake",
      call: async (r) => {
        sent.push(r.body);
        return inner.call ? inner.call(r) : { outputText: "{}", usage: usage(100, 0, 10), latencyMs: 1 };
      },
      respond: async (r) => {
        sent.push(r.body);
        return inner.respond!(r);
      },
    };
    const client = new MeteredClient({ store: s, accountId: a, workspace: a, config: config(over), serverKey: over.KEY === "none" ? null : "k", model: () => "muse-spark-1.3", inner: full });
    return { s, a, client, sent, run: () => client.call({ key: "m", attempt: 1, effort: "low", body }) };
  };

  it("sets max_output_tokens on every call, and charges the reported usage", async () => {
    const t = setup({});
    await t.run();
    expect((t.sent[0] as { max_output_tokens: number }).max_output_tokens).toBe(MAX_OUTPUT_TOKENS.json);
    expect(t.s.balance(t.a)).toBe(10_000_000 - chargeMicros(spark, usage(100, 0, 10), 300));
  });

  it("a call that fails after it may have run is charged the whole hold, or its reported usage", async () => {
    const whole = setup({ call: async () => Promise.reject(new ModelCallError("timeout", null)) });
    await expect(whole.run()).rejects.toThrow(ModelCallError);
    const hold = whole.s.ledger(whole.a).find((r) => r.kind === "hold")!;
    expect(whole.s.charges(whole.a)[0]).toMatchObject({ amountMicros: hold.amount, wholeHold: true });

    const server = setup({ call: async () => Promise.reject(new ModelCallError("503", 503)) });
    await expect(server.run()).rejects.toThrow();
    expect(server.s.charges(server.a)[0]!.wholeHold).toBe(true);

    const partial = setup({
      call: async () => {
        const e = new ModelCallError("incomplete", 200);
        e.usage = usage(300, 0, 4_096);
        throw e;
      },
    });
    await expect(partial.run()).rejects.toThrow();
    expect(partial.s.charges(partial.a)[0]).toMatchObject({ amountMicros: chargeMicros(spark, usage(300, 0, 4_096), 300), wholeHold: false });

    const noUsage = setup({ call: async () => ({ outputText: "{}", usage: usage(0, 0, 0), latencyMs: 1 }) });
    await noUsage.run();
    expect(noUsage.s.charges(noUsage.a)[0]!.wholeHold).toBe(true);
  });

  it("a call the API refused before it ran is released, not charged", async () => {
    const t = setup({ call: async () => Promise.reject(new ModelCallError("400", 400)) });
    await expect(t.run()).rejects.toThrow();
    expect(t.s.balance(t.a)).toBe(10_000_000);
    expect(t.s.charges(t.a)).toEqual([]);
  });

  it("the off switch, a missing key and the daily ceiling refuse every call before a hold, whatever the balance", async () => {
    for (const [over, code] of [
      [{ APP_SERVER_KEY: "off" }, "server_key_off"],
      [{ KEY: "none" }, "server_key_off"],
      [{ APP_DAILY_COST_CAP_USD: "0.000001" }, "daily_cap"],
    ] as const) {
      const t = setup({}, over);
      await expect(t.run()).rejects.toMatchObject({ name: "UsageRefusedError", code });
      expect(t.sent).toEqual([]);
      expect(t.s.ledger(t.a).map((r) => r.kind)).toEqual(["grant"]);
    }
    const broke = setup({}, {}, 0);
    await expect(broke.run()).rejects.toMatchObject({ code: "credits_exhausted" });
    expect(broke.sent).toEqual([]);
  });
});
