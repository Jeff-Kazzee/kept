// Muse Wonder's sprint 13 review, round 1, and Jeff's J19 (0014). Each
// test failed before its fix.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAdmin } from "../scripts/admin.ts";
import { JUDGE_SHARED_TRY_LIMIT } from "../server/hosted.ts";
import { readHostedConfig } from "../src/hosted/config.ts";
import { MeteredClient } from "../src/hosted/metered.ts";
import { clientAddress } from "../src/hosted/rate-limit.ts";
import { AccountsStore } from "../src/hosted/store.ts";
import type { LiveClient } from "../src/model/providers/factory.ts";
import type { TokenUsage } from "../src/model/request.ts";
import { USAGE_TEXT } from "../src/model/usage.ts";
import { completed, message } from "./provider-fakes.ts";
import { fakeMeta, sseEvents, startHosted, type Browser, type Hosted } from "./hosted-helpers.ts";

let h: Hosted | null = null;
const dirs: string[] = [];
const stores: AccountsStore[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "review1-"));
  dirs.push(dir);
  const s = new AccountsStore(path.join(dir, "accounts.sqlite"));
  stores.push(s);
  return { s, dir };
}

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

const CAPS = { APP_MODE: "hosted", APP_DAILY_COST_CAP_USD: "1000", APP_JUDGE_TOTAL_CAP_USD: "1000" };
const gen = (state: { generation: number }) => ({ "X-Case-Generation": String(state.generation) });
const sessionOf = (b: Browser) => b.cookies.get(`appt_session_${h!.port}`)!;

describe("finding 1: a charge never exceeds its hold", () => {
  const body = { model: "muse-spark-1.3", store: false as const, reasoning: { effort: "low" as const }, instructions: "x".repeat(2_500), input: "y", text: { format: { type: "json_schema" as const, name: "n", schema: {}, strict: false as const } } };

  it("bills output_tokens only, and charges a reasoning count above output as the whole hold", async () => {
    const { s } = tempStore();
    const a = s.userAccount({ userId: "user-s-000000", email: "e@example.com", name: null }).id;
    s.grant(a, 100_000_000, "g");
    const r = rng(11);
    let next: TokenUsage = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
    const inner: LiveClient = {
      label: "fake",
      call: async () => ({ outputText: "{}", usage: next, latencyMs: 1 }),
      respond: async () => {
        throw new Error("unused");
      },
    };
    const client = new MeteredClient({ store: s, accountId: a, workspace: a, config: readHostedConfig(CAPS), serverKey: "k", model: () => "muse-spark-1.3", inner });
    for (let i = 0; i < 300; i++) {
      const input = 1 + Math.floor(r() * 2_000);
      const output = Math.floor(r() * 9_000);
      // Some answers report more reasoning than output, or more output
      // than the call allows.
      next = { input, cachedInput: Math.floor(r() * input), output, reasoning: r() < 0.3 ? output + 1 + Math.floor(r() * 5_000) : Math.floor(r() * (output + 1)) };
      await client.call({ key: "m", attempt: 1, effort: "low", body });
    }
    const rows = s.ledger(a);
    const holds = new Map(rows.filter((x) => x.kind === "hold").map((x) => [x.id, x]));
    const charges = rows.filter((x) => x.kind === "charge");
    expect(charges).toHaveLength(300);
    for (const c of charges) {
      const hold = holds.get(c.holdId!)!;
      expect(c.amount).toBeLessThanOrEqual(hold.amount);
      expect(c.cost).toBeLessThanOrEqual(hold.cost);
    }
    // The malformed answers were charged the whole hold.
    const whole = s.charges(a, 1000).filter((c) => c.wholeHold);
    expect(whole.length).toBeGreaterThan(50);
  });

  it("the live rows' shape, output with reasoning inside it, is billed by output_tokens", () => {
    // Live check, 2026-10-28: output 67 with reasoning 13, and 62 with 40.
    const { s } = tempStore();
    const a = s.userAccount({ userId: "user-t-000000", email: "t@example.com", name: null }).id;
    s.grant(a, 10_000_000, "g");
    return (async () => {
      const inner: LiveClient = {
        label: "fake",
        call: async () => ({ outputText: "{}", usage: { input: 1000, cachedInput: 0, output: 67, reasoning: 13 }, latencyMs: 1 }),
        respond: async () => {
          throw new Error("unused");
        },
      };
      const client = new MeteredClient({ store: s, accountId: a, workspace: a, config: readHostedConfig(CAPS), serverKey: "k", model: () => "muse-spark-1.3", inner });
      await client.call({ key: "m", attempt: 1, effort: "low", body });
      // (1000 x 1.25 + 67 x 4.25) x 3 = 4,604.25, rounded up.
      expect(s.charges(a)[0]).toMatchObject({ amountMicros: 4_605, wholeHold: false });
    })();
  });
});

describe("finding 2: a revoked code's credit is fully gone once its holds settle", () => {
  const ctx = (accountId: string) => ({ accountId, workspace: accountId, route: "chat", turn: null, model: "muse-spark-1.3" });

  it("credit inside an open hold does not come back, and no new hold draws on it", () => {
    const { s } = tempStore();
    const { id, code } = s.createJudgeCode({ label: "J", capMicros: 5_000_000, expiresAt: Date.now() + 86_400_000, totalCapMicros: 100_000_000 });
    const a = s.redeemJudgeCode(code).id;
    const h1 = s.hold(ctx(a), 3_000_000, 1_000_000, 1e12) as { holdId: number };
    s.revokeJudgeCode(id);
    expect(s.balance(a)).toBe(0);
    // An in-flight turn's next call is refused.
    expect(s.hold(ctx(a), 1, 1, 1e12)).toEqual({ ok: false, reason: "credits" });
    // The open hold is released: its credit stays gone.
    s.release(h1.holdId);
    expect(s.balance(a)).toBe(0);
    expect(s.hold(ctx(a), 1, 1, 1e12)).toEqual({ ok: false, reason: "credits" });
  });

  it("an open hold that settles with a charge leaves nothing, and the code counts what it spent", () => {
    const { s } = tempStore();
    const { id, code } = s.createJudgeCode({ label: "J", capMicros: 5_000_000, expiresAt: Date.now() + 86_400_000, totalCapMicros: 100_000_000 });
    const a = s.redeemJudgeCode(code).id;
    const h1 = s.hold(ctx(a), 3_000_000, 1_000_000, 1e12) as { holdId: number };
    s.revokeJudgeCode(id);
    s.settle(h1.holdId, { usage: { input: 1, cachedInput: 0, output: 1, reasoning: 0 }, amountMicros: 1_000_000, costMicros: 300_000 });
    expect(s.balance(a)).toBe(0);
    expect(s.charges(a)[0]!.amountMicros).toBe(1_000_000);
    expect(s.listJudgeCodes()[0]).toMatchObject({ status: "revoked", spentMicros: 1_000_000 });
    expect(s.judgeTotals().committedMicros).toBe(1_000_000);
  });

  it("other credit on the same account stays usable after a revoke", () => {
    const { s } = tempStore();
    const g = s.userAccount({ userId: "user-g-000000", email: "g@example.com", name: null }).id;
    s.grant(g, 2_000_000, "purchase:test");
    const { id, code } = s.createJudgeCode({ label: "J", capMicros: 5_000_000, expiresAt: Date.now() + 86_400_000, totalCapMicros: 100_000_000 });
    s.redeemJudgeCode(code, g);
    const h1 = s.hold(ctx(g), 6_000_000, 1, 1e12) as { holdId: number };
    s.revokeJudgeCode(id);
    s.release(h1.holdId);
    expect(s.balance(g)).toBe(2_000_000);
    expect(s.hold(ctx(g), 2_000_000, 1, 1e12).ok).toBe(true);
  });
});

describe("finding 3: Delete account finds out the account is busy before it disconnects Google", () => {
  it("a running turn makes Delete account answer 409 with Google still connected, and it goes ahead after", async () => {
    const meta = fakeMeta();
    h = await startHosted();
    const b = h.browser();
    await h.signUp(b);
    const id = await h.accountOf(b);
    h.app.store.grant(id, 5_000_000, "g");
    const s = (await b.call("GET", "/api/state")).body;
    const g = (await b.call("GET", "/api/google")).body;
    const start = await b.call("POST", "/api/google/connect", { expectedVersion: g.version }, gen(s));
    const back = h.google!.fake.consent(start.body.authorizeUrl);
    expect((await b.visit(`${back.pathname}${back.search}`)).headers.location).toBe("/?connected=google");

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    meta.script.push(async () => {
      await gate;
      return new Response(completed([message("I can help with your appointments.")]), { headers: { "content-type": "text/event-stream" } });
    });
    const turn = b.call("POST", "/api/chat", { text: "What is on my schedule?", expectedVersion: 0 }, gen(s));
    while (meta.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    let refused;
    let revokedWhileBusy: string[];
    try {
      refused = await b.call("POST", "/api/account/delete", { confirmation: "DELETE" });
      revokedWhileBusy = [...h.google!.fake.revoked];
    } finally {
      release();
    }
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("account_busy");
    expect(revokedWhileBusy).toEqual([]);
    expect((await b.call("GET", "/api/session")).body.signedIn).toBe(true);
    expect(sseEvents((await turn).text).at(-1)!.event).toBe("turn.done");
    expect((await b.call("GET", "/api/google")).body.connected).toBe(true);
    const done = await b.call("POST", "/api/account/delete", { confirmation: "DELETE" });
    expect(done.body).toEqual({ deleted: true });
    expect(h.google!.fake.revoked.length).toBe(1);
  });
});

describe("finding 4: forwarding headers count only behind a trusted proxy", () => {
  it("without APP_TRUSTED_PROXY, a rotating CF-Connecting-IP does not escape the limit", async () => {
    h = await startHosted({ env: { APP_TRUSTED_PROXY: "" } });
    const b = h.browser();
    const statuses: number[] = [];
    // 0023, fix round 2: every request is the loopback socket, so all of
    // them share the one ceiling for addresses that are not counted.
    for (let i = 0; i <= JUDGE_SHARED_TRY_LIMIT.limit; i++) statuses.push((await b.call("POST", "/api/session/judge", { code: `judge_${"C".repeat(43)}` }, { "CF-Connecting-IP": `192.0.2.${i % 250}`, "X-Forwarded-For": `198.51.100.${i % 250}` })).status);
    expect(statuses.at(-1)).toBe(429);
  }, 30_000);

  it("with cloudflare, only CF-Connecting-IP, and only from a loopback socket", () => {
    const headers = { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" };
    expect(clientAddress(headers, "127.0.0.1", "cloudflare")).toBe("203.0.113.9");
    expect(clientAddress(headers, "::1", "cloudflare")).toBe("203.0.113.9");
    expect(clientAddress(headers, "::ffff:127.0.0.1", "cloudflare")).toBe("203.0.113.9");
    expect(clientAddress(headers, "10.0.0.5", "cloudflare")).toBe("10.0.0.5");
    expect(clientAddress({ "x-forwarded-for": "198.51.100.1" }, "127.0.0.1", "cloudflare")).toBe("127.0.0.1");
    expect(clientAddress(headers, "127.0.0.1", "none")).toBe("127.0.0.1");
    expect(readHostedConfig(CAPS).trustedProxy).toBe("none");
    expect(readHostedConfig({ ...CAPS, APP_TRUSTED_PROXY: "cloudflare" }).trustedProxy).toBe("cloudflare");
    expect(() => readHostedConfig({ ...CAPS, APP_TRUSTED_PROXY: "anything" })).toThrow();
  });
});

describe("finding 5: the cache never drops a workspace with a Google flow, or one used in the last 10 minutes", () => {
  it("a full cache keeps A's pending Google connect, and A finishes it", async () => {
    h = await startHosted({ maxWorkspaces: 1 });
    const a = h.browser();
    const b = h.browser();
    await h.signUp(a, { email: "a@example.com" });
    await h.signUp(b, { email: "b@example.com" });
    const sa = (await a.call("GET", "/api/state")).body;
    const g = (await a.call("GET", "/api/google")).body;
    const start = await a.call("POST", "/api/google/connect", { expectedVersion: g.version }, gen(sa));
    expect((await b.call("GET", "/api/state")).status).toBe(200);
    h.google!.fake.account = { sub: "sub-a", email: "a@example.com" };
    const back = h.google!.fake.consent(start.body.authorizeUrl);
    expect((await a.visit(`${back.pathname}${back.search}`)).headers.location).toBe("/?connected=google");
  });

  it("a workspace used in the last 10 minutes stays open, and an older idle one goes", async () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    h = await startHosted({ maxWorkspaces: 1, now: () => now });
    const a = h.browser();
    const b = h.browser();
    const c = h.browser();
    for (const [x, sub] of [[a, "a"], [b, "b"], [c, "c"]] as const) await h.signUp(x, { email: `${sub}@example.com` });
    const [idA, idC] = [await h.accountOf(a), await h.accountOf(c)];
    await a.call("GET", "/api/state");
    await b.call("GET", "/api/state");
    expect(h.app.workspaces.isOpen(idA)).toBe(true);
    now += 11 * 60_000;
    await c.call("GET", "/api/state");
    expect(h.app.workspaces.isOpen(idA)).toBe(false);
    expect(h.app.workspaces.isOpen(idC)).toBe(true);
  });
});

describe("finding 6: sign-in and sign-out end and clear both cookie forms", () => {
  it("sign-out ends the loopback session even when the request claims HTTPS", async () => {
    h = await startHosted();
    const b = h.browser();
    await b.call("POST", "/api/session/judge", { code: h.judgeCode().code });
    const token = sessionOf(b);
    const out = await b.call("POST", "/api/session/signout", {}, { "X-Forwarded-Proto": "https" });
    const set = (Array.isArray(out.headers["set-cookie"]) ? out.headers["set-cookie"] : [out.headers["set-cookie"]]).join("\n");
    expect(set).toContain(`appt_session_${h.port}=; `);
    expect(set).toContain("__Host-appt_session=; ");
    expect((await h.raw("GET", "/api/state", { Cookie: `appt_session_${h.port}=${token}` })).status).toBe(401);
  });

  it("signing in again ends the earlier session of either form", async () => {
    h = await startHosted();
    const b = h.browser();
    await b.call("POST", "/api/session/judge", { code: h.judgeCode("A").code });
    const first = sessionOf(b);
    const again = await b.call("POST", "/api/session/judge", { code: h.judgeCode("B").code }, { "X-Forwarded-Proto": "https" });
    expect(again.status).toBe(200);
    expect((await h.raw("GET", "/api/state", { Cookie: `appt_session_${h.port}=${first}` })).status).toBe(401);
    const set = (again.headers["set-cookie"] as string[]).join("\n");
    expect(set).toContain(`appt_session_${h.port}=; `);
    expect(set).toMatch(/__Host-appt_session=[A-Za-z0-9_-]{43}; /);
  });
});

describe("finding 7 and J19: hosted-only settings", () => {
  it("local mode ignores hosted-only settings, and still refuses a bad APP_MODE", () => {
    expect(readHostedConfig({ APP_MARKUP: "0.5", APP_SERVER_KEY: "maybe", APP_DAILY_COST_CAP_USD: "lots", APP_TRUSTED_PROXY: "x" }).mode).toBe("local");
    expect(() => readHostedConfig({ APP_MODE: "cloud" })).toThrow();
  });

  it("J19: without both caps set, hosted mode turns the server key off and names what is missing", () => {
    const none = readHostedConfig({ APP_MODE: "hosted" });
    expect(none).toMatchObject({ serverKeyOn: false, dailyCapMicros: null, judgeTotalCapMicros: null, missing: ["APP_DAILY_COST_CAP_USD", "APP_JUDGE_TOTAL_CAP_USD"] });
    expect(readHostedConfig({ APP_MODE: "hosted", APP_DAILY_COST_CAP_USD: "5" })).toMatchObject({ serverKeyOn: false, missing: ["APP_JUDGE_TOTAL_CAP_USD"] });
    expect(readHostedConfig(CAPS)).toMatchObject({ serverKeyOn: true, missing: [], dailyCapMicros: 1_000_000_000 });
  });

  it("J19: the start log names the missing setting, and every step gives the usage-paused message", async () => {
    const meta = fakeMeta();
    h = await startHosted({ env: { APP_DAILY_COST_CAP_USD: "", APP_JUDGE_TOTAL_CAP_USD: "7" } });
    expect(h.app.startLines().join("\n")).toContain("APP_DAILY_COST_CAP_USD is not set, so the server key is off.");
    const b = h.browser();
    await b.call("POST", "/api/session/judge", { code: h.judgeCode().code });
    const s = (await b.call("GET", "/api/state")).body;
    const events = sseEvents((await b.call("POST", "/api/chat", { text: "What is on my schedule?", expectedVersion: 0 }, gen(s))).text);
    expect(events[0]!.data).toMatchObject({ code: "usage_paused", message: USAGE_TEXT.server_key_off.text });
    expect(meta.calls).toEqual([]);
  });

  it("J19: admin create and grant refuse while the total cap is unset", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review1-admin-"));
    dirs.push(dir);
    const env = { APP_DB: path.join(dir, "app.sqlite") };
    const made = runAdmin(["judges", "create", "--label", "A", "--cap-usd", "1", "--expires", "2099-01-01"], env);
    expect(made.code).toBe(2);
    expect(made.err.join("\n")).toContain("APP_JUDGE_TOTAL_CAP_USD is not set");
    const withCap = runAdmin(["judges", "create", "--label", "A", "--cap-usd", "1", "--expires", "2099-01-01"], { ...env, APP_JUDGE_TOTAL_CAP_USD: "5" });
    expect(withCap.code).toBe(0);
    const id = runAdmin(["judges", "list"], env).out[0]!.split(" ")[0]!;
    expect(runAdmin(["judges", "grant", "--id", id, "--usd", "1"], env).code).toBe(2);
    expect(runAdmin(["judges", "list"], env).code).toBe(0);
    expect(runAdmin(["judges", "revoke", "--id", id], env).code).toBe(0);
  });
});
