import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApi } from "../server/api.ts";
import { IntakeService } from "../src/intake/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { fromPackage } from "../src/paths.ts";
import { EventStore } from "../src/store/event-log.ts";

const M1 = {
  id: "m1",
  channel: "sms",
  from: "Lantern Hill Clinic",
  received_at: "2026-10-30T15:04:00-06:00",
  text: "Lantern Hill Clinic: Hi Dana, we can see you Tuesday, November 10 at 2:00 PM or Thursday, November 12 at 10:30 AM at our Elm Street office. Reply 1 or 2.",
};

function setup() {
  const service = new IntakeService(new EventStore(), RecordedModelClient.fromDirectory());
  return createApi(service, { mode: "recorded" });
}

describe("local API", () => {
  it("lists fixtures without their expected claims and serves the demo calendar", async () => {
    const api = setup();
    const fixtures = (await api({ method: "GET", path: "/api/fixtures", body: undefined })).body as Array<{
      id: string;
      messages: object[];
    }>;
    expect(fixtures).toHaveLength(12);
    expect(fixtures[0]!.messages[0]).not.toHaveProperty("expected");
    const cal = (await api({ method: "GET", path: "/api/fixtures/calendar", body: undefined })).body as { text: string };
    expect(cal.text).toContain("Team meeting");
  });

  it("imports, extracts and reviews with version checks", async () => {
    const api = setup();
    expect((await api({ method: "POST", path: "/api/messages", body: M1 })).status).toBe(200);
    const stale = await api({ method: "POST", path: "/api/messages/m1/extract", body: { effort: "low", expectedVersion: 0 } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "stale_edit", currentVersion: 1, current: { id: "m1", version: 1 } });
    const extracted = await api({ method: "POST", path: "/api/messages/m1/extract", body: { effort: "low", expectedVersion: 1 } });
    expect(extracted.status).toBe(200);
    const state = (await api({ method: "GET", path: "/api/state", body: undefined })).body as {
      mode: string;
      evidence: Array<{ id: string; status: string; version: number }>;
    };
    expect(state.mode).toBe("recorded");
    expect(state.evidence.map((e) => e.status)).toEqual(["pending", "pending"]);
    const id = state.evidence[0]!.id;
    const accepted = await api({ method: "POST", path: `/api/evidence/${id}/accept`, body: { expectedVersion: 1 } });
    expect(accepted.body).toMatchObject({ status: "accepted", version: 2 });
    expect((await api({ method: "POST", path: `/api/evidence/${id}/reject`, body: { expectedVersion: 1 } })).status).toBe(409);
  });

  it("assigns an id to pasted messages and validates bodies", async () => {
    const api = setup();
    const { id: _id, ...pasted } = M1;
    const added = await api({ method: "POST", path: "/api/messages", body: pasted });
    expect((added.body as { id: string }).id).toMatch(/^pasted-/);
    expect((await api({ method: "POST", path: "/api/messages", body: { ...pasted, received_at: "yesterday" } })).status).toBe(400);
    expect((await api({ method: "POST", path: "/api/messages", body: { ...pasted, extra: 1 } })).status).toBe(400);
    const manual = await api({
      method: "POST",
      path: `/api/messages/${(added.body as { id: string }).id}/manual`,
      body: { claim_type: "offer", date: "2026-11-10", time: "14:00", location: null, quote: "made up words", request_item: null },
    });
    expect(manual.status).toBe(422);
    expect((await api({ method: "GET", path: "/api/nothing", body: undefined })).status).toBe(404);
    expect((await api({ method: "GET", path: "/api/messages", body: undefined })).status).toBe(405);
  });
});

describe("dev server", () => {
  let child: ChildProcess | undefined;
  const dir = mkdtempSync(path.join(tmpdir(), "d1-server-"));
  afterAll(() => {
    if (child?.pid) process.kill(child.pid, "SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (port: number, host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/state", headers: { Host: host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });

  it("binds to 127.0.0.1 in recorded mode and refuses other host names", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const env = { ...process.env, APP_PORT: String(port), APP_DB: path.join(dir, "dev.sqlite"), APP_LIVE_MODEL: "", MODEL_API_KEY: "" };
    child = spawn(process.execPath, [fromPackage("server/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
    const line = await new Promise<string>((resolve, reject) => {
      let out = "";
      child!.stdout!.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("on http")) resolve(out);
      });
      child!.on("exit", (code) => reject(new Error(`server exited ${code}`)));
      setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15_000);
    });
    expect(line).toContain(`http://127.0.0.1:${port} (model: recorded responses)`);
    expect(await get(port, `127.0.0.1:${port}`)).toBe(200);
    expect(await get(port, `attacker.example:${port}`)).toBe(403);
  }, 20_000);
});
