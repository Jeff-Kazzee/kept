// Sprint 7B, P3: APP_ALLOWED_HOSTS adds host names for a private proxy such
// as Tailscale serve. An allowed host passes, any other is refused. The
// server still binds 127.0.0.1. Since sprint 8 there is no pairing or
// session cookie (0009, J3).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AllowedHostsError, appHosts, hostAllowed, parseAllowedHosts } from "../server/hosts.ts";
import { fromPackage } from "../src/paths.ts";

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TAILNET = "box.tail1234.ts.net";

describe("allowed hosts", () => {
  it("parses a comma-separated list and refuses anything that is not a host name", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("  ")).toEqual([]);
    expect(parseAllowedHosts(` ${TAILNET.toUpperCase()} , other-box:8443`)).toEqual([TAILNET, "other-box:8443"]);
    for (const bad of ["*", "evil.example/path", "http://box.ts.net", "a b", "box.ts.net,", ".ts.net", "user@box"]) {
      expect(() => parseAllowedHosts(bad), bad).toThrow(AllowedHostsError);
    }
  });

  it("an allowed host passes with or without the app's port, and any other host is refused", () => {
    const allowed = appHosts(5180, [TAILNET]);
    for (const ok of ["127.0.0.1:5180", "localhost:5180", TAILNET, `${TAILNET}:5180`, TAILNET.toUpperCase()]) expect(hostAllowed(allowed, ok), ok).toBe(true);
    for (const no of [undefined, "", "127.0.0.1", "localhost", `${TAILNET}:9999`, "evil.example", `evil.${TAILNET}`, "127.0.0.1:5181"]) expect(hostAllowed(allowed, no), String(no)).toBe(false);
    expect(allowed.origins).toContain(`https://${TAILNET}`);
    expect(allowed.origins).not.toContain("https://127.0.0.1:5180");
    expect(appHosts(5180).hosts).toEqual(new Set(["127.0.0.1:5180", "localhost:5180"]));
  });
});

type Res = { status: number; body: any; setCookie: string[]; headers: Record<string, string | string[] | undefined> };

function call(port: number, method: string, p: string, headers: Record<string, string>, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text.startsWith("{") ? JSON.parse(text) : text, setCookie: res.headers["set-cookie"] ?? [], headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function start(env: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "hosts-"));
  dirs.push(dir);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [fromPackage("server/main.ts")], {
    env: { ...process.env, APP_PORT: String(port), APP_DB: path.join(dir, "app.sqlite"), APP_LIVE_MODEL: "", MODEL_API_KEY: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const ready = new Promise<{ out: string }>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      if (/Serving the (production build|UI through Vite)/.test(out)) resolve({ out });
    });
    child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    child.on("exit", (c) => reject(new Error(`server exited ${c}: ${out}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15_000);
  });
  return { port, child, ready };
}

describe("the server with APP_ALLOWED_HOSTS", () => {
  it("answers to the allowed host over the proxy, sets no cookie, and refuses other hosts and origins", async () => {
    const app = start({ APP_ALLOWED_HOSTS: TAILNET });
    const { out } = await app.ready;
    expect(out).toContain(`Also answers to: ${TAILNET}`);
    const page = { Host: TAILNET, Origin: `https://${TAILNET}`, "Content-Type": "application/json", "X-Appointments-App": "1", "X-Forwarded-Proto": "https" };
    const state = await call(app.port, "GET", "/api/state", { Host: TAILNET });
    expect(state.status).toBe(200);
    expect(state.setCookie).toEqual([]);
    expect((await call(app.port, "GET", "/api/case/version", { Host: `${TAILNET}:${app.port}` })).status).toBe(200);
    // Any other host is refused.
    for (const host of ["evil.example", `evil.example:${app.port}`, `${TAILNET}.evil.example`]) {
      expect(await call(app.port, "GET", "/api/state", { Host: host })).toMatchObject({ status: 403, body: { error: "forbidden_host" } });
    }
    // A write from a page on another origin is refused.
    const M = { channel: "sms", from: "Clinic", received_at: "2026-11-05T09:00:00-07:00", text: "See you Monday." };
    expect(await call(app.port, "POST", "/api/messages", { ...page, Origin: "https://evil.example", "X-Case-Generation": "0" }, M)).toMatchObject({ status: 403, body: { error: "forbidden_source" } });
    expect((await call(app.port, "POST", "/api/messages", { ...page, "X-Case-Generation": "0" }, M)).status).toBe(200);
  }, 30_000);

  it("on 127.0.0.1 a page from the tailnet name is refused when the name is not allowed", async () => {
    const app = start({});
    await app.ready;
    expect((await call(app.port, "GET", "/", { Host: TAILNET })).status).toBe(403);
    expect((await call(app.port, "GET", "/api/state", { Host: `127.0.0.1:${app.port}` })).status).toBe(200);
  }, 30_000);

  it("stops at start when APP_ALLOWED_HOSTS has an entry that is not a host name", async () => {
    const app = start({ APP_ALLOWED_HOSTS: "*" });
    // The exit, or a failure after 15 seconds, never an endless wait.
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the server did not stop")), 15_000);
      app.child.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(2);
    await app.ready.catch((e: Error) => expect(e.message).toContain("APP_ALLOWED_HOSTS has an entry that is not a host name"));
  }, 30_000);

  it("review 1, finding 4: every /api response says nosniff and has a CSP that allows nothing, the chat route included", async () => {
    const app = start({});
    await app.ready;
    const host = `127.0.0.1:${app.port}`;
    const page = { Host: host, Origin: `http://${host}`, "Content-Type": "application/json", "X-Appointments-App": "1", "X-Case-Generation": "0" };
    const responses = [
      await call(app.port, "GET", "/api/state", { Host: host }),
      await call(app.port, "GET", "/api/pair", { Host: host }),
      await call(app.port, "GET", "/api/state", { Host: "evil.example" }),
      await call(app.port, "POST", "/api/messages", page, { channel: "sms", from: "Clinic", received_at: "2026-11-05T09:00:00-07:00", text: "See you Monday." }),
      // The chat route: GET is JSON, POST is the event stream.
      await call(app.port, "GET", "/api/chat", { Host: host }),
      await call(app.port, "POST", "/api/chat", { ...page, Accept: "text/event-stream" }, { text: "What is confirmed?", expectedVersion: 0 }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 404, 403, 200, 200, 200]);
    // The headers do not change for either.
    expect(responses[4]!.headers["content-type"]).toBe("application/json");
    expect(responses[5]!.headers["content-type"]).toBe("text/event-stream");
    expect(String(responses[5]!.body)).toContain("event: turn.done");
    for (const r of responses) {
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    }
  }, 30_000);
});
