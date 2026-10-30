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
    const boot = await bootOf(ws);
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
    const boot = await bootOf(ws);
    const state = boot.state as { caseVersion: number; generation: number };
    const del = await ws.api({ method: "POST", path: "/api/case/delete", body: { expectedVersion: state.caseVersion, confirmation: "DELETE" }, generation: state.generation });
    expect(del.status).toBe(200);
    const started = Date.now();
    const now = await waitForChange(() => liveOf(ws), boot.live, { closed: () => false });
    expect(now!.generation).not.toBe(boot.live.generation);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
