// Muse Wonder's sprint 13 review, final round (0014). Each test failed
// before its fix.
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountsStore } from "../src/hosted/store.ts";
import { trustedSecure } from "../server/http.ts";
import type { Workspace } from "../server/workspace.ts";
import { WorkspacesFullError, Workspaces } from "../server/workspaces.ts";
import { startHosted, type Browser, type Hosted } from "./hosted-helpers.ts";

let h: Hosted | null = null;
const dirs: string[] = [];
const stores: AccountsStore[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "review2-"));
  dirs.push(dir);
  return dir;
}

function tempStore() {
  const s = new AccountsStore(path.join(tempDir(), "accounts.sqlite"));
  stores.push(s);
  return s;
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

const ctx = (accountId: string) => ({ accountId, workspace: accountId, route: "chat", turn: null, model: "muse-spark-1.3" });
const usage = { input: 1, cachedInput: 0, output: 1, reasoning: 0 };
const revoked = (s: AccountsStore, a: string) => 0 - s.ledger(a).filter((r) => r.kind === "adjust" && r.source?.startsWith("judge_revoked:")).reduce((x, r) => x + r.amount, 0);

describe("finding 1: a revoke never takes other credit", () => {
  it("Muse's case: $5 judge credit, $2 other credit, a $6 hold open, then a $1 charge, leaves $2", () => {
    const s = tempStore();
    const g = s.googleAccount({ sub: "g", email: "g@example.com", name: null }).id;
    s.grant(g, 2_000_000, "purchase:test");
    const { id, code } = s.createJudgeCode({ label: "J", capMicros: 5_000_000, expiresAt: Date.now() + 86_400_000, totalCapMicros: 100_000_000 });
    s.redeemJudgeCode(code, g);
    const h1 = s.hold(ctx(g), 6_000_000, 1, 1e12) as { holdId: number };
    s.revokeJudgeCode(id);
    // None of it may be spent while the hold is open.
    expect(s.hold(ctx(g), 1_000_001, 1, 1e12)).toEqual({ ok: false, reason: "credits" });
    s.settle(h1.holdId, { usage, amountMicros: 1_000_000, costMicros: 1 });
    expect(s.balance(g)).toBe(2_000_000);
    expect(revoked(s, g)).toBe(4_000_000);
    expect(s.hold(ctx(g), 2_000_000, 1, 1e12).ok).toBe(true);
  });

  it("two holds open at the revoke, one released and one charged, still leave other credit whole", () => {
    const s = tempStore();
    const g = s.googleAccount({ sub: "g2", email: "g2@example.com", name: null }).id;
    s.grant(g, 2_000_000, "purchase:test");
    const { id, code } = s.createJudgeCode({ label: "J", capMicros: 5_000_000, expiresAt: Date.now() + 86_400_000, totalCapMicros: 100_000_000 });
    s.redeemJudgeCode(code, g);
    const a = s.hold(ctx(g), 3_000_000, 1, 1e12) as { holdId: number };
    const b = s.hold(ctx(g), 3_000_000, 1, 1e12) as { holdId: number };
    s.revokeJudgeCode(id);
    s.release(a.holdId);
    s.settle(b.holdId, { usage, amountMicros: 2_000_000, costMicros: 1 });
    // The $2 charged counts against the judge credit first, so $3 of it
    // is removed and the $2 of other credit stays.
    expect(revoked(s, g)).toBe(3_000_000);
    expect(s.balance(g)).toBe(2_000_000);
  });

  it("property: random judge and other grants, holds, partial settles, a revoke and grants after it never take other credit, and the balance never goes negative", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const s = tempStore();
      const g = s.googleAccount({ sub: `p${seed}`, email: `p${seed}@example.com`, name: null }).id;
      const { id, code } = s.createJudgeCode({ label: "J", capMicros: 1 + Math.floor(r() * 5_000_000), expiresAt: Date.now() + 86_400_000, totalCapMicros: 1e12 });
      s.redeemJudgeCode(code, g);
      let other = 0;
      let charged = 0;
      let chargedBeforeRevoke = 0;
      let isRevoked = false;
      let expectedRemoval = 0;
      let unspentAtRevoke = 0;
      let inflightCharged = 0;
      const open = new Map<number, { amount: number; beforeRevoke: boolean }>();
      const cap = () => s.listJudgeCodes()[0]!.capMicros;
      for (let step = 0; step < 80; step++) {
        const pick = r();
        if (pick < 0.12) {
          const v = 1 + Math.floor(r() * 2_000_000);
          s.grant(g, v, "purchase:test");
          other += v;
        } else if (pick < 0.18 && !isRevoked) {
          s.grantJudgeCode(id, 1 + Math.floor(r() * 1_000_000), 1e12);
        } else if (pick < 0.5) {
          const amount = 1 + Math.floor(r() * 3_000_000);
          const res = s.hold(ctx(g), amount, 1, 1e12);
          if (res.ok) open.set(res.holdId, { amount, beforeRevoke: !isRevoked });
        } else if (pick < 0.85 && open.size > 0) {
          const [hid, hold] = [...open][Math.floor(r() * open.size)]!;
          open.delete(hid);
          let c = 0;
          if (r() < 0.25) s.release(hid);
          else c = s.settle(hid, { usage, amountMicros: Math.floor(r() * hold.amount), costMicros: 1 }).charged;
          charged += c;
          if (!isRevoked) chargedBeforeRevoke += c;
          else if (hold.beforeRevoke) inflightCharged += c;
        } else if (pick < 0.9 && !isRevoked && step > 10) {
          unspentAtRevoke = cap() - Math.min(cap(), chargedBeforeRevoke);
          s.revokeJudgeCode(id);
          isRevoked = true;
        }
        expect(s.balance(g), `seed ${seed} step ${step}`).toBeGreaterThanOrEqual(0);
        expect(revoked(s, g)).toBeLessThanOrEqual(unspentAtRevoke);
      }
      // Close every hold, then check the totals.
      for (const [hid, hold] of open) {
        const c = s.settle(hid, { usage, amountMicros: Math.floor(r() * hold.amount), costMicros: 1 }).charged;
        charged += c;
        if (!isRevoked) chargedBeforeRevoke += c;
        else if (hold.beforeRevoke) inflightCharged += c;
      }
      if (isRevoked) expectedRemoval = Math.max(0, unspentAtRevoke - inflightCharged);
      const judgeGranted = s.ledger(g).filter((x) => x.kind === "grant" && x.source?.startsWith("judge:")).reduce((x, y) => x + y.amount, 0);
      expect(revoked(s, g), `seed ${seed}`).toBe(expectedRemoval);
      expect(s.balance(g), `seed ${seed}`).toBe(other + judgeGranted - charged - expectedRemoval);
    }
  });
});

describe("finding 2: the workspace cache has a hard ceiling", () => {
  const stub = (): Workspace => ({ close: () => {}, pendingGoogleFlow: () => true }) as unknown as Workspace;
  const id = (n: number) => `a${n.toString(16).padStart(32, "0")}`;

  it("at four times the cap, the least recently used workspace with no request goes, even a recent one with a Google flow", async () => {
    let now = 1_000_000;
    const ws = new Workspaces({ root: tempDir(), build: stub, now: () => now, max: 2 });
    for (let i = 1; i <= 8; i++) {
      now += 1;
      await ws.use(id(i), () => {});
    }
    expect(ws.size).toBe(8);
    now += 1;
    await ws.use(id(9), () => {});
    expect(ws.size).toBe(8);
    expect(ws.isOpen(id(1))).toBe(false);
    expect(ws.isOpen(id(9))).toBe(true);
  });

  it("when every workspace at the ceiling has a request running, a new one is refused with a retryable error", async () => {
    const ws = new Workspaces({ root: tempDir(), build: stub, max: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const running = [1, 2, 3, 4].map((i) => ws.use(id(i), () => gate));
    await expect(ws.use(id(5), () => {})).rejects.toBeInstanceOf(WorkspacesFullError);
    release();
    await Promise.all(running);
    await ws.use(id(5), () => {});
    expect(ws.isOpen(id(5))).toBe(true);
  });

  it("the site answers 503 with a plain sentence while the cache is full of running requests", async () => {
    h = await startHosted({ maxWorkspaces: 1 });
    const browsers: Browser[] = [];
    for (let i = 0; i < 5; i++) {
      const b = h.browser();
      await h.googleSignIn(b, { sub: `full-${i}`, email: `full${i}@example.com` });
      browsers.push(b);
    }
    const idOf = (b: Browser) => h!.app.store.session(b.cookies.get(`appt_session_${h!.port}`)!)!.account.id;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = browsers.slice(0, 4).map((b) => h!.app.workspaces.use(idOf(b), () => gate));
    const res = await browsers[4]!.call("GET", "/api/state");
    release();
    await Promise.all(held);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "site_busy", retryable: true });
    expect(res.body.message).toMatch(/^This site is busy/);
    expect((await browsers[4]!.call("GET", "/api/state")).status).toBe(200);
  });
});

describe("finding 3: the cookie form does not follow a claimed scheme", () => {
  const req = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

  it("X-Forwarded-Proto counts only from a loopback socket, and Origin never decides", () => {
    expect(trustedSecure(req("127.0.0.1", { "x-forwarded-proto": "https" }))).toBe(true);
    expect(trustedSecure(req("::1", { "x-forwarded-proto": "https" }))).toBe(true);
    expect(trustedSecure(req("10.1.2.3", { "x-forwarded-proto": "https" }))).toBe(false);
    expect(trustedSecure(req("127.0.0.1", { origin: "https://evil.example" }))).toBe(false);
    expect(trustedSecure(req("127.0.0.1", {}))).toBe(false);
  });

  it("a loopback session still reads when a request wrongly claims HTTPS", async () => {
    h = await startHosted();
    const b = h.browser();
    await b.call("POST", "/api/session/judge", { code: h.judgeCode().code });
    expect((await b.call("GET", "/api/session", undefined, { "X-Forwarded-Proto": "https" })).body.signedIn).toBe(true);
    expect((await b.call("GET", "/api/state", undefined, { "X-Forwarded-Proto": "https" })).status).toBe(200);
  });

  it("a loopback Google sign-in finishes when its callback wrongly claims HTTPS", async () => {
    h = await startHosted();
    const b = h.browser();
    const start = await b.call("POST", "/api/session/google", {});
    const back = h.google!.fake.consent(start.body.authorizeUrl);
    const cb = await b.call("GET", `${back.pathname}${back.search}`, undefined, { "X-Forwarded-Proto": "https" });
    expect(cb.headers.location).toBe("/?signedIn=google");
  });

  it("the __Host- form wins when both forms are sent", async () => {
    h = await startHosted();
    const plain = h.browser();
    await plain.call("POST", "/api/session/judge", { code: h.judgeCode("Plain", 3).code });
    const secure = h.browser();
    await secure.call("POST", "/api/session/judge", { code: h.judgeCode("Secure").code }, { "X-Forwarded-Proto": "https" });
    const both = `appt_session_${h.port}=${plain.cookies.get(`appt_session_${h.port}`)}; __Host-appt_session=${secure.cookies.get("__Host-appt_session")}`;
    // Plain has $3, Secure $5: the answer says which session was read.
    const who = await h.raw("GET", "/api/session", { Cookie: both });
    expect(who.body.balanceMicros).toBe(5_000_000);
  });
});
