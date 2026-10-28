// The chat routes: request checks in server/chat.ts, and the real server
// process with its paired session, same-origin check and event stream.
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChat, sseFrame, type ChatSink } from "../server/chat.ts";
import { MAX_CHAT_CHARS } from "../src/agent/agent.ts";
import { MODEL_UNAVAILABLE_TEXT, WITHHELD_USER_TEXT, type ChatEvent } from "../src/agent/types.ts";
import { SCOPE_DECLINE } from "../src/domain/scope.ts";
import { fromPackage } from "../src/paths.ts";
import { EventStore } from "../src/store/event-log.ts";
import { CLOCK, agentFor, message, reply, sequence, services } from "./agent-helpers.ts";

function sink() {
  const out: { json: Array<[number, unknown]>; events: ChatEvent[]; ended: boolean } = { json: [], events: [], ended: false };
  const s: ChatSink = {
    json: (status, body) => out.json.push([status, body]),
    event: (e) => out.events.push(e),
    end: () => (out.ended = true),
  };
  return { s, out };
}

describe("server/chat.ts", () => {
  const setup = () => {
    const app = services(new EventStore(":memory:", CLOCK));
    const model = sequence(reply(message("Hello.")));
    return { app, model, chat: createChat(agentFor(app, model)) };
  };

  it("GET returns the chat version and messages", async () => {
    const { chat } = setup();
    const { s, out } = sink();
    await chat.serve({ method: "GET", body: undefined }, s);
    expect(out.json).toEqual([[200, { chatVersion: 0, messages: [] }]]);
  });

  it("POST needs the case generation and a valid body, and refuses other methods, before any event", async () => {
    const { chat, model } = setup();
    const cases: Array<[unknown, number | undefined, number, string]> = [
      [{ text: "Hi", expectedVersion: 0 }, undefined, 400, "generation_required"],
      [{ text: "   ", expectedVersion: 0 }, 0, 400, "invalid_body"],
      [{ text: "x".repeat(MAX_CHAT_CHARS + 1), expectedVersion: 0 }, 0, 400, "invalid_body"],
      [{ text: "Hi", expectedVersion: -1 }, 0, 400, "invalid_body"],
      [{ text: "Hi", expectedVersion: 0, tool: "accept_claim" }, 0, 400, "invalid_body"],
      [null, 0, 400, "invalid_body"],
    ];
    for (const [body, generation, status, error] of cases) {
      const { s, out } = sink();
      await chat.serve({ method: "POST", body, generation }, s);
      expect(out.json.map(([st, b]) => [st, (b as { error: string }).error])).toEqual([[status, error]]);
      expect(out.events).toEqual([]);
    }
    const { s, out } = sink();
    await chat.serve({ method: "PUT", body: {}, generation: 0 }, s);
    expect(out.json[0]![0]).toBe(405);
    expect(model.calls).toHaveLength(0);
  });

  it("POST streams the turn's events and ends the stream", async () => {
    const { chat } = setup();
    const { s, out } = sink();
    await chat.serve({ method: "POST", body: { text: "Hi", expectedVersion: 0 }, generation: 0 }, s);
    expect(out.events.map((e) => e.event)).toEqual(["turn.started", "text.delta", "turn.done"]);
    expect(out.ended).toBe(true);
    expect(sseFrame(out.events[1]!)).toBe(`event: text.delta\ndata: ${JSON.stringify({ turnId: "t1", text: "Hello." })}\n\n`);
  });
});

// The real app process on a temporary database, in recorded mode.
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Res = { status: number; type: string; text: string; setCookie: string[] };

function call(port: number, method: string, p: string, headers: Record<string, string>, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), text, setCookie: res.headers["set-cookie"] ?? [] }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function parseSse(text: string): ChatEvent[] {
  return text
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)![1]!;
      const data = JSON.parse(/^data: (.+)$/m.exec(block)![1]!);
      return { event, data } as ChatEvent;
    });
}

async function startServer() {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-http-"));
  dirs.push(dir);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, APP_PORT: String(port), APP_DB: path.join(dir, "app.sqlite"), APP_LIVE_MODEL: "", MODEL_API_KEY: "" };
  const child = spawn(process.execPath, [fromPackage("server/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  const code = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /Pairing code for this run: ([A-Z0-9]{4}-[A-Z0-9]{4})\./.exec(out);
      if (m) resolve(m[1]!);
    });
    child.on("exit", (c) => reject(new Error(`server exited ${c}`)));
    setTimeout(() => reject(new Error("server did not start")), 15_000);
  });
  const page = (extra: Record<string, string> = {}) => ({
    "Content-Type": "application/json",
    "X-Case-Generation": "0",
    Origin: `http://127.0.0.1:${port}`,
    "X-Appointments-App": "1",
    ...extra,
  });
  return { port, code, page, stderr: () => stderr };
}

describe("the chat routes on the real server", () => {
  it("need the paired session for GET and POST, refuse another origin, and stream a turn as server-sent events", async () => {
    const { port, code, page, stderr } = await startServer();
    for (const [method, body] of [["GET", undefined], ["POST", { text: "Hi", expectedVersion: 0 }]] as const) {
      const res = await call(port, method, "/api/chat", page(), body);
      expect([method, res.status, JSON.parse(res.text).error]).toEqual([method, 401, "not_paired"]);
    }
    const paired = await call(port, "POST", "/api/pair", page(), { code });
    const cookie = paired.setCookie[0]!.split(";")[0]!;
    const withSession = (extra: Record<string, string> = {}) => page({ Cookie: cookie, ...extra });

    const cross = await call(port, "POST", "/api/chat", { ...withSession(), Origin: "http://evil.example" }, { text: "Hi", expectedVersion: 0 });
    expect(cross.status).toBe(403);
    const noHeader = await call(port, "POST", "/api/chat", { ...withSession(), "X-Appointments-App": "" }, { text: "Hi", expectedVersion: 0 });
    expect(noHeader.status).toBe(403);

    // A clinical message: the fixed decline, no model call.
    const declined = await call(port, "POST", "/api/chat", withSession(), { text: "What do my test results mean?", expectedVersion: 0 });
    expect(declined.status).toBe(200);
    expect(declined.type).toMatch(/^text\/event-stream/);
    const events = parseSse(declined.text);
    expect(events.map((e) => e.event)).toEqual(["turn.started", "text.delta", "text.delta", "turn.error", "turn.done"]);
    expect(events.find((e) => e.event === "turn.error")!.data).toMatchObject({ code: "out_of_scope", message: SCOPE_DECLINE });
    expect(events.at(-1)!.data).toMatchObject({ chatVersion: 2 });

    // Recorded mode has no recording for this request: model_unavailable.
    const unrecorded = parseSse((await call(port, "POST", "/api/chat", withSession(), { text: "Hello there", expectedVersion: 2 })).text);
    expect(unrecorded.find((e) => e.event === "turn.error")!.data).toMatchObject({ code: "model_unavailable" });

    // E2: the server log names the failed call with codes only.
    expect(stderr()).toContain("Chat model call 1 (loop) failed: HTTP none, type none, code none.");
    expect(stderr()).not.toContain("Hello there");

    // A stale version is refused in the stream.
    const stale = parseSse((await call(port, "POST", "/api/chat", withSession(), { text: "Hello", expectedVersion: 0 })).text);
    expect(stale.map((e) => [e.event, (e.data as { code?: string }).code])).toEqual([["turn.error", "stale_edit"]]);

    const chat = JSON.parse((await call(port, "GET", "/api/chat", withSession())).text);
    expect(chat.chatVersion).toBe(4);
    expect(chat.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([
      ["user", WITHHELD_USER_TEXT],
      ["assistant", SCOPE_DECLINE],
      ["user", "Hello there"],
      ["assistant", MODEL_UNAVAILABLE_TEXT],
    ]);
    expect(chat.messages[1].declined).toBe(true);
  }, 60_000);
});
