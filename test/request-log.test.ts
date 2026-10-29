// Sprint 13D, E4 (0017): the request log writes the method, the path, the
// status and the time of each API request, and nothing secret.
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loggedPath, requestLogEnabled, requestLogger } from "../server/request-log.ts";

const SECRETS: [string, string, string, string, string, string, string] = ["sk-live-token-0123456789", "dana.demo@example.com", "session=abc123secret", "Bearer ya29.secret-access", "4/0AbCdEfGh-code", "state-xyz-789", "The office's message text"];

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

async function serve(lines: string[]) {
  const server = createServer();
  server.on("request", requestLogger({ write: (l) => lines.push(l) }));
  server.on("request", (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/api/chat") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Set-Cookie": "session=abc123secret" });
        res.write(`event: text.delta\ndata: ${JSON.stringify({ text: SECRETS[6] })}\n\n`);
        setTimeout(() => res.end("event: turn.done\ndata: {}\n\n"), 30);
        return;
      }
      if (path === "/api/reply/suggest") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: text.delta\ndata: {}\n\n");
        return;
      }
      if (path === "/api/usage" || (path === "/api/case/version" && req.headers["x-fail"])) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: SECRETS[0] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "session=abc123secret" });
      res.end(JSON.stringify({ echo: body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

function call(port: number, method: string, path: string, body = "", abortAfter?: number): Promise<void> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { Cookie: SECRETS[2], Authorization: SECRETS[3], "Content-Type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve());
      res.on("close", () => resolve());
      if (abortAfter !== undefined) setTimeout(() => req.destroy(), abortAfter);
    });
    req.on("error", () => resolve());
    req.end(body);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("sprint 13D, E4: the request log", () => {
  it("writes one line per API request with the method, the path, the status and the time, and nothing secret", async () => {
    const lines: string[] = [];
    const port = await serve(lines);
    await call(port, "GET", `/api/state?token=${SECRETS[0]}&email=${encodeURIComponent(SECRETS[1])}`);
    await call(port, "POST", "/api/messages", JSON.stringify({ text: SECRETS[6], key: SECRETS[0], from: SECRETS[1] }));
    await call(port, "POST", "/api/chat", JSON.stringify({ text: SECRETS[6] }));
    await call(port, "GET", `/auth/google/callback?code=${encodeURIComponent(SECRETS[4])}&state=${SECRETS[5]}`);
    await call(port, "POST", `/api/messages/${encodeURIComponent(SECRETS[1])}/extract`);
    await call(port, "POST", "/api/usage");
    // Not an API request: the page and its files are not logged.
    await call(port, "GET", "/assets/index.js");
    await settle();
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^request GET \/api\/state 200 \d+ ms$/);
    expect(lines[1]).toMatch(/^request POST \/api\/messages 200 \d+ ms$/);
    expect(lines[2]).toMatch(/^request POST \/api\/chat 200 stream, started \d+ ms, done at \d+ ms$/);
    expect(lines[3]).toMatch(/^request GET \/auth\/google\/callback 200 \d+ ms$/);
    expect(lines[4]).toMatch(/^request POST \/api\/messages\/\*\/extract 200 \d+ ms$/);
    expect(lines[5]).toMatch(/^request POST \/api\/usage 503 \d+ ms$/);
    const all = lines.join("\n");
    for (const s of SECRETS) expect(all).not.toContain(s);
    for (const s of ["token", "@", "session", "Bearer", "code=", "?", "Cookie"]) expect(all).not.toContain(s);
  });

  it("says when the client closed a stream before it was done", async () => {
    const lines: string[] = [];
    const port = await serve(lines);
    await call(port, "POST", "/api/reply/suggest", "", 20);
    await settle();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^request POST \/api\/reply\/suggest 200 stream, started \d+ ms, closed by the client at \d+ ms$/);
  });

  it("keeps the app's route words and its own ids where a route takes one, and writes every other segment as * (fix round 1, R4)", () => {
    // Fix round 2, F5: message and fact ids are always "*".
    expect(loggedPath("/api/evidence/gmail-18f0a1-e1/accept?x=1")).toBe("/api/evidence/*/accept");
    expect(loggedPath("/api/evidence/m2-r2-u1/reject")).toBe("/api/evidence/*/reject");
    expect(loggedPath("/api/records/2026-11-16T13%3A00/archive")).toBe("/api/records/2026-11-16T13:00/archive");
    expect(loggedPath("/api/messages/chat-3f9a2c/extract")).toBe("/api/messages/*/extract");
    expect(loggedPath("/api/messages/pasted-0b6f2c1e-8d3a-4f7b-9c2e-5a1d3e4f6a7b/manual")).toBe("/api/messages/*/manual");
    expect(loggedPath("/api/conflicts/both-held-20261112-1030_20261116-1300/explain")).toBe("/api/conflicts/both-held-20261112-1030_20261116-1300/explain");
    expect(loggedPath("/api/questions/q2/answer")).toBe("/api/questions/q2/answer");
    expect(loggedPath("/api/reply/drafts/d3/approve")).toBe("/api/reply/drafts/d3/approve");
    expect(loggedPath("/api/activity/a17/undo")).toBe("/api/activity/a17/undo");
    expect(loggedPath("/api/messages/dana%40example.com/extract")).toBe("/api/messages/*/extract");
    expect(loggedPath("/api/messages/a@b.example/extract")).toBe("/api/messages/*/extract");
    expect(loggedPath(`/api/x/${"a".repeat(81)}`)).toBe("/api/*/*");
    expect(loggedPath("/api/x#frag")).toBe("/api/*");
    expect(loggedPath("/index.html")).toBeNull();
  });

  it("writes a secret-looking segment as *, wherever it sits", () => {
    // Plain letters, digits and hyphens, the shape the earlier rule kept.
    const secret = "judge-7Kq2-Xv9P-t0kEn-a1b2c3";
    expect(loggedPath(`/api/messages/${secret}/extract`)).toBe("/api/messages/*/extract");
    expect(loggedPath(`/api/session/${secret}`)).toBe("/api/session/*");
    expect(loggedPath(`/api/${secret}/state`)).toBe("/api/*/state");
    expect(loggedPath(`/api/records/${secret}/archive`)).toBe("/api/records/*/archive");
    expect(loggedPath(`/api/evidence/gmail-${secret}-e1/accept`)).toBe("/api/evidence/*/accept");
    // Fix round 2, F5: a lowercase token where a chat- message id goes.
    const token = "chat-k7q2xv9pt0kena1b2c3d4e5";
    expect(loggedPath(`/api/messages/${token}/extract`)).toBe("/api/messages/*/extract");
    expect(loggedPath(`/api/evidence/${token}-e1/accept`)).toBe("/api/evidence/*/accept");
    // A word and digits shaped like a conflict id, but not one of its kinds.
    expect(loggedPath("/api/conflicts/token-20261116/explain")).toBe("/api/conflicts/*/explain");
    expect(loggedPath("/api/messages/%E0%A4%A/extract")).toBe("/api/messages/*/extract");
  });

  it("leaves out the page's 2-second poll unless it fails (fix round 1, R3)", async () => {
    const lines: string[] = [];
    const port = await serve(lines);
    for (let i = 0; i < 5; i++) await call(port, "GET", "/api/case/version");
    await call(port, "GET", "/api/state");
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path: "/api/case/version", headers: { "x-fail": "1" } }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.end();
    });
    await settle();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^request GET \/api\/state 200 \d+ ms$/);
    expect(lines[1]).toMatch(/^request GET \/api\/case\/version 503 \d+ ms$/);
  });

  it("is on by default in local mode and off in hosted mode, and one setting changes either", () => {
    expect(requestLogEnabled("local", undefined)).toBe(true);
    expect(requestLogEnabled("hosted", undefined)).toBe(false);
    expect(requestLogEnabled("local", "0")).toBe(false);
    expect(requestLogEnabled("hosted", "1")).toBe(true);
    expect(requestLogEnabled("hosted", "yes")).toBe(false);
  });
});
