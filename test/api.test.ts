import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApi } from "../server/api.ts";
import { CaseService } from "../src/case/service.ts";
import { IntakeService } from "../src/intake/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { ReplyService } from "../src/reply/service.ts";
import type { ReplyView } from "../src/reply/types.ts";
import { fromPackage } from "../src/paths.ts";
import { EventStore } from "../src/store/event-log.ts";
import { fixtureMessage } from "./helpers.ts";

const M1 = {
  id: "m1",
  channel: "sms",
  from: "Lantern Hill Clinic",
  received_at: "2026-10-30T15:04:00-06:00",
  text: "Lantern Hill Clinic: Hi Dana, we can see you Tuesday, November 10 at 2:00 PM or Thursday, November 12 at 10:30 AM at our Elm Street office. Reply 1 or 2.",
};

function setup() {
  const store = new EventStore();
  const client = RecordedModelClient.fromDirectory();
  const service = new IntakeService(store, client);
  const kase = new CaseService(store, service, client, { userName: "Dana Reyes" });
  return createApi(service, kase, { mode: "recorded" }, new ReplyService(store, kase));
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

  it("extracts at effort minimal when the body names no effort", async () => {
    const api = setup();
    await api({ method: "POST", path: "/api/messages", body: M1 });
    const extracted = await api({ method: "POST", path: "/api/messages/m1/extract", body: { expectedVersion: 1 } });
    expect(extracted.body).toMatchObject({ message: { attempts: [{ effort: "minimal" }] } });
  });

  it("assigns an id to pasted messages and validates bodies", async () => {
    const api = setup();
    const { id: _id, ...pasted } = M1;
    const added = await api({ method: "POST", path: "/api/messages", body: pasted });
    expect((added.body as { id: string }).id).toMatch(/^pasted-/);
    expect((await api({ method: "POST", path: "/api/messages", body: { ...pasted, received_at: "yesterday" } })).status).toBe(400);
    expect((await api({ method: "POST", path: "/api/messages", body: { ...pasted, extra: 1 } })).status).toBe(400);
    const manualPath = `/api/messages/${(added.body as { id: string }).id}/manual`;
    const claim = { claim_type: "offer", date: "2026-11-10", time: "14:00", location: null, quote: null, request_item: null };
    const madeUp = await api({ method: "POST", path: manualPath, body: { expectedVersion: 1, claim: { ...claim, quote: "made up words" } } });
    expect(madeUp.status).toBe(422);
    expect((await api({ method: "POST", path: manualPath, body: claim })).status).toBe(400);
    expect((await api({ method: "POST", path: manualPath, body: { expectedVersion: 1, claim } })).status).toBe(200);
    expect((await api({ method: "POST", path: manualPath, body: { expectedVersion: 1, claim } })).status).toBe(409);
    expect((await api({ method: "GET", path: "/api/nothing", body: undefined })).status).toBe(404);
    expect((await api({ method: "GET", path: "/api/messages", body: undefined })).status).toBe(405);
  });
});

describe("local API for slot states", () => {
  type State = {
    evidence: Array<{ id: string; version: number; status: string }>;
    case: {
      slots: Array<{ key: string; stateLabel: string; clashes: Array<{ summary: string }> | null }>;
      conflicts: Array<{ id: string; version: number; explanation: { outcome: string; citedEvidenceIds: string[] } | null }>;
      question: { id: string; text: string; choices: Array<{ id: string; label: string }> } | null;
      questionsVersion: number;
      calendarVersion: number;
      reply: ReplyView;
    };
  };

  it("runs the demo story: calendar, explanation, one question and an answer", async () => {
    const api = setup();
    const call = async (method: string, path: string, body?: unknown) => api({ method, path, body });
    const state = async () => (await call("GET", "/api/state")).body as State;
    for (const id of ["m1", "m2", "m3"]) {
      await call("POST", "/api/messages", fixtureMessage(id));
      await call("POST", `/api/messages/${id}/extract`, { effort: "low", expectedVersion: 1 });
    }
    for (const e of (await state()).evidence) await call("POST", `/api/evidence/${e.id}/accept`, { expectedVersion: e.version });

    const cal = (await call("GET", "/api/fixtures/calendar")).body as { name: string; text: string };
    expect((await call("POST", "/api/calendar", { ...cal, expectedVersion: 0 })).status).toBe(200);
    expect((await call("POST", "/api/calendar", { ...cal, expectedVersion: 0 })).status).toBe(409);
    expect((await call("POST", "/api/calendar", { name: "x.ics", text: "nope", expectedVersion: 1 })).status).toBe(422);
    let s = await state();
    expect(s.case.slots.map((x) => [x.key, x.stateLabel, x.clashes?.map((c) => c.summary)])).toEqual([
      ["2026-11-10T14:00", "Offered · office message", []],
      ["2026-11-12T10:30", "Confirmed · office message, change proposed", []],
      ["2026-11-13T09:15", "Offered · office message", ["Team meeting"]],
      ["2026-11-16T13:00", "Offered · office message", []],
    ]);

    const conflict = s.case.conflicts[0]!;
    const explained = await call("POST", `/api/conflicts/${conflict.id}/explain`, { expectedVersion: conflict.version });
    expect(explained.body).toMatchObject({ explanation: { outcome: "valid", citedEvidenceIds: ["m2-e1", "m3-e1", "m3-e2", "m3-e3"] } });
    expect((await call("POST", `/api/conflicts/${conflict.id}/explain`, { expectedVersion: 0 })).status).toBe(409);

    expect((await call("POST", "/api/questions/next", { expectedVersion: 0 })).status).toBe(200);
    expect((await call("POST", "/api/questions/next", { expectedVersion: 1 })).status).toBe(422);
    s = await state();
    expect(s.case.question!.text).toBe("The office needs to move your Thursday 11/12 10:30 AM visit. Which new time do you want to request?");
    const answerPath = `/api/questions/${s.case.question!.id}/answer`;
    expect((await call("POST", answerPath, { expectedVersion: 1, choiceId: "nope" })).status).toBe(422);
    expect((await call("POST", answerPath, { expectedVersion: 0, choiceId: "unsure" })).status).toBe(409);
    expect((await call("POST", answerPath, { expectedVersion: 1 })).status).toBe(400);
    expect((await call("POST", answerPath, { expectedVersion: 1, choiceId: "request:2026-11-16T13:00" })).status).toBe(422);
    const answered = await call("POST", answerPath, { expectedVersion: 1, choiceId: "request:2026-11-16T13:00", replyVersion: 0 });
    expect(answered.status).toBe(200);
    s = await state();
    // W30: the tap opens a draft. Monday becomes requested only on approval.
    expect(s.case.slots.find((x) => x.key === "2026-11-16T13:00")!.stateLabel).toBe("Offered · office message");
    expect(s.case.question).toBeNull();
    const draft = s.case.reply.draft!;
    expect(draft).toMatchObject({ template: "accept_offer", slotKey: "2026-11-16T13:00", edited: false });
    const approvePath = `/api/reply/drafts/${draft.id}/approve`;
    expect((await call("POST", approvePath, { expectedVersion: 1, confirmedFields: ["date"] })).status).toBe(422);
    expect((await call("POST", approvePath, { expectedVersion: 0, confirmedFields: draft.fields.map((f) => f.name) })).status).toBe(409);
    const approved = await call("POST", approvePath, { expectedVersion: 1, confirmedFields: draft.fields.map((f) => f.name) });
    expect(approved.status).toBe(200);
    s = await state();
    expect(s.case.slots.map((x) => [x.key, x.stateLabel])).toEqual([
      ["2026-11-10T14:00", "Offered · office message"],
      ["2026-11-12T10:30", "Confirmed · office message, change proposed"],
      ["2026-11-13T09:15", "Offered · office message"],
      ["2026-11-16T13:00", "Requested · reported by you"],
    ]);
    expect(s.case.reply).toMatchObject({ draft: null, sent: [{ draftId: draft.id, simulated: true }] });
    expect(s.evidence.find((e) => e.id === `reply-${draft.id}-1`)).toMatchObject({ status: "accepted" });
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
