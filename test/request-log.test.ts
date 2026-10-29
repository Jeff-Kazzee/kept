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
      if (path === "/api/slow") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: text.delta\ndata: {}\n\n");
        return;
      }
      if (path === "/api/fail") {
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
    await call(port, "POST", "/api/fail");
    // Not an API request: the page and its files are not logged.
    await call(port, "GET", "/assets/index.js");
    await settle();
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^request GET \/api\/state 200 \d+ ms$/);
    expect(lines[1]).toMatch(/^request POST \/api\/messages 200 \d+ ms$/);
    expect(lines[2]).toMatch(/^request POST \/api\/chat 200 stream, started \d+ ms, done at \d+ ms$/);
    expect(lines[3]).toMatch(/^request GET \/auth\/google\/callback 200 \d+ ms$/);
    expect(lines[4]).toMatch(/^request POST \/api\/messages\/\*\/extract 200 \d+ ms$/);
    expect(lines[5]).toMatch(/^request POST \/api\/fail 503 \d+ ms$/);
    const all = lines.join("\n");
    for (const s of SECRETS) expect(all).not.toContain(s);
    for (const s of ["token", "@", "session", "Bearer", "code=", "?", "Cookie"]) expect(all).not.toContain(s);
  });

  it("says when the client closed a stream before it was done", async () => {
    const lines: string[] = [];
    const port = await serve(lines);
    await call(port, "POST", "/api/slow", "", 20);
    await settle();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^request POST \/api\/slow 200 stream, started \d+ ms, closed by the client at \d+ ms$/);
  });

  it("keeps plain ids in a path and writes every other segment as *", () => {
    expect(loggedPath("/api/evidence/gmail-18f0a1-e1/accept?x=1")).toBe("/api/evidence/gmail-18f0a1-e1/accept");
    expect(loggedPath("/api/records/2026-11-16T13:00/archive")).toBe("/api/records/2026-11-16T13:00/archive");
    expect(loggedPath("/api/messages/dana%40example.com/extract")).toBe("/api/messages/*/extract");
    expect(loggedPath("/api/messages/a@b.example/extract")).toBe("/api/messages/*/extract");
    expect(loggedPath(`/api/x/${"a".repeat(81)}`)).toBe("/api/x/*");
    expect(loggedPath("/api/x#frag")).toBe("/api/x");
    expect(loggedPath("/index.html")).toBeNull();
  });

  it("is on by default in local mode and off in hosted mode, and one setting changes either", () => {
    expect(requestLogEnabled("local", undefined)).toBe(true);
    expect(requestLogEnabled("hosted", undefined)).toBe(false);
    expect(requestLogEnabled("local", "0")).toBe(false);
    expect(requestLogEnabled("hosted", "1")).toBe(true);
    expect(requestLogEnabled("hosted", "yes")).toBe(false);
  });
});
