// Round 2, findings 2 and 4: the first render's data is read together and
// names its generation (GET /api/boot), and the held live read answers the
// moment the case changes, a Delete case included.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIVE_HOLD_MS, parseSince, waitForChange, type Live } from "../server/live.ts";
import { bootOf, createWorkspace, liveOf, type Workspace } from "../server/workspace.ts";

const dirs: string[] = [];
const spaces: Workspace[] = [];
afterEach(() => {
  for (const ws of spaces.splice(0)) ws.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-"));
  dirs.push(dir);
  const ws = createWorkspace({ dbPath: path.join(dir, "app.sqlite"), secretsPath: path.join(dir, "app-secrets.sqlite"), port: 5197, extraHosts: [], googleClient: null, serverMetaKey: null });
  spaces.push(ws);
  return ws;
}

describe("round 2, finding 4: the held live read", () => {
  it("reads since as generation.seq or generation.seq.calendar, and nothing else", () => {
    expect(parseSince("?since=3.41")).toEqual({ generation: 3, seq: 41 });
    expect(parseSince("?since=3.41.2")).toEqual({ generation: 3, seq: 41, calendar: 2 });
    for (const bad of ["", "?since=", "?since=3", "?since=a.b", "?since=3.4.5.6", "?since=-1.2"]) expect(parseSince(bad), bad).toBeNull();
  });

  it("answers at once when the version differs, holds while it is the same, and stops when the client goes away", async () => {
    const since: Live = { generation: 1, seq: 5 };
    let clock = 0;
    let reads = 0;
    const read = async () => (reads++, reads < 4 ? since : { generation: 1, seq: 6 });
    const sleep = async (ms: number) => void (clock += ms);
    expect(await waitForChange(read, since, { closed: () => false, sleep, now: () => clock })).toEqual({ generation: 1, seq: 6 });
    expect(reads).toBe(4);
    clock = 0;
    expect(await waitForChange(async () => since, since, { closed: () => false, sleep, now: () => clock })).toEqual(since);
    expect(clock).toBeGreaterThanOrEqual(LIVE_HOLD_MS);
    expect(await waitForChange(async () => since, since, { closed: () => true, sleep, now: () => 0 })).toBeNull();
  });
});

describe("round 2, finding 2: the first render's data names its generation", () => {
  it("GET /api/boot gives the case, the settings, the activity, Google and the chat of one live version", async () => {
    const ws = workspace();
    const boot = (await bootOf(ws))!;
    const state = boot.state as { generation: number; live: Live };
    expect(boot.live).toEqual(await liveOf(ws));
    expect(state.generation).toBe(boot.live.generation);
    expect(boot.chat).toMatchObject({ messages: [] });
    expect(boot.settings).toBeTruthy();
    expect(boot.activity).toBeTruthy();
    expect(boot.google).toBeTruthy();
  });

  it("a Delete case after the boot read: the page's first held read answers at once with the new generation", async () => {
    const ws = workspace();
    const boot = (await bootOf(ws))!;
    const state = boot.state as { caseVersion: number; generation: number };
    const del = await ws.api({ method: "POST", path: "/api/case/delete", body: { expectedVersion: state.caseVersion, confirmation: "DELETE" }, generation: state.generation });
    expect(del.status).toBe(200);
    const started = Date.now();
    const now = await waitForChange(() => liveOf(ws), boot.live, { closed: () => false });
    expect(now!.generation).not.toBe(boot.live.generation);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("0019, P30: the server renders the case screen from the boot data", () => {
  it("renders the shell, the welcome and the composer, with no inline script the CSP would refuse", async () => {
    const ws = workspace();
    const boot = (await bootOf(ws))!;
    const entry = "../ui/entry-server.tsx";
    const { renderCase } = (await import(entry)) as { renderCase: (b: unknown) => Promise<string> };
    const html = await renderCase(boot);
    expect(html).toContain('class="app"');
    expect(html).toContain('id="chat-input"');
    expect(html).toContain("What changed with your appointments?");
    expect(html).toContain('data-opening="true"');
    expect(html).not.toMatch(/<script/);
    // The same boot renders the same HTML, so the page's hydration matches.
    expect(await renderCase(boot)).toBe(html);
  });
});

describe("Muse round 2, finding 2: the boot read is of one version or none", () => {
  // Makes the live version's calendar counter move on chosen reads.
  function moving(ws: Workspace, moveOn: (n: number) => boolean) {
    const api = ws.api;
    let reads = 0;
    let calendar = 0;
    (ws as unknown as { api: (req: Parameters<Workspace["api"]>[0]) => ReturnType<Workspace["api"]> }).api = async (req) => {
      const r = await api(req);
      if (req.method === "GET" && req.path === "/api/case/version") {
        if (moveOn(++reads)) calendar++;
        return { ...r, body: { ...(r.body as object), calendar } };
      }
      return r;
    };
    return () => reads;
  }

  it("a move of the calendar alone during the read takes the reads again", async () => {
    const ws = workspace();
    // The second version read (after the first round of reads) has moved.
    const reads = moving(ws, (n) => n === 2);
    const boot = await bootOf(ws);
    expect(boot).not.toBeNull();
    expect(reads()).toBe(4);
    expect(boot!.live.calendar).toBe(1);
  });

  it("a case that keeps moving gives no boot, never one of mixed versions, and the route says so", async () => {
    const ws = workspace();
    moving(ws, () => true);
    expect(await bootOf(ws)).toBeNull();
    const { BOOT_ATTEMPTS } = await import("../server/workspace.ts");
    expect(BOOT_ATTEMPTS).toBe(5);
  });
});

describe("Muse round 2, finding 9: hostile text through the real server render and the boot block", () => {
  it("a message with </script>, <!--, U+2028, U+2029, quotes and a long subject renders escaped, and the block parses back whole", async () => {
    const ws = workspace();
    const hostile = `Lantern "Hill" Clinic's </script><script>alert(1)</script> <!-- x --> \u2028 \u2029 ${"Subject ".repeat(80)}`;
    const boot = (await bootOf(ws))!;
    const chat = {
      chatVersion: 2,
      messages: [
        { id: "u1", role: "user", text: hostile, createdAt: "2026-11-05T16:00:00.000Z", cards: [], chips: [], actions: [] },
        { id: "a1", role: "assistant", text: `About ${hostile}`, createdAt: "2026-11-05T16:00:01.000Z", cards: [], chips: [], actions: [] },
      ],
    };
    const withHostile = { ...boot, chat };
    const entry = "../ui/entry-server.tsx";
    const { renderCase } = (await import(entry)) as { renderCase: (b: unknown) => Promise<string> };
    const html = await renderCase(withHostile);
    const { bootBlock, withRendered } = await import("../server/static.ts");
    const page = withRendered('<html><body><div id="root"></div><script type="module" src="/a.js"></script></body></html>', { html, boot: withHostile });
    // No message text closes or opens a script, and no comment begins.
    expect(page.match(/<script/g)).toHaveLength(2);
    expect(page.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain("<!-- x");
    expect(html).toContain("&lt;/script&gt;");
    const block = bootBlock(withHostile);
    const json = block.slice(block.indexOf(">") + 1, block.lastIndexOf("</script>"));
    expect(json).not.toMatch(/[<\u2028\u2029]/);
    expect(JSON.parse(json)).toEqual(withHostile);
  });
});

describe("Muse round 2, finding 9: the hosted held read and the idle sweep", () => {
  const ACCT = `a${"0".repeat(31)}1`;
  it("a look at an open workspace keeps it open only while it runs, does not count as use, and finds nothing in a closed one", async () => {
    const { Workspaces } = await import("../server/workspaces.ts");
    const root = mkdtempSync(path.join(tmpdir(), "ws-"));
    dirs.push(root);
    let now = 1_000_000;
    const all = new Workspaces({
      root,
      now: () => now,
      idleMs: 60_000,
      build: (_id, files) => createWorkspace({ ...files, port: 5197, extraHosts: [], googleClient: null, serverMetaKey: null }),
    });
    expect(await all.peek(ACCT, (ws) => liveOf(ws))).toBeNull();
    expect(all.isOpen(ACCT)).toBe(false);
    const first = await all.use(ACCT, (ws) => liveOf(ws));
    // A held tab looks every 250 ms for two minutes: no look counts as use.
    for (let i = 0; i < 480; i++) {
      now += 250;
      expect(await all.peek(ACCT, (ws) => liveOf(ws))).toEqual(first);
    }
    expect(all.sweep()).toBe(1);
    expect(all.isOpen(ACCT)).toBe(false);
    // The held read then reads the closed workspace as unchanged.
    const live = await waitForChange(async () => (await all.peek(ACCT, (ws) => liveOf(ws))) ?? first, first, { closed: () => false, holdMs: 0 });
    expect(live).toEqual(first);
    all.closeAll();
  });

  it("hosted.ts uses the look, not use, for its held read", async () => {
    const { readFileSync } = await import("node:fs");
    const hosted = readFileSync(new URL("../server/hosted.ts", import.meta.url), "utf8");
    expect(hosted).toMatch(/waitForChange\(async \(\) => \(await workspaces\.peek\(accountId, \(ws\) => liveOf\(ws\)\)\) \?\? since/);
  });
});
