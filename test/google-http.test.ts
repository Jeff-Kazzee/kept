// Sprint 11: the Google routes in the real server process, on a temporary
// database. The client id and secret are made up, and no test step reaches
// Google: the callback is refused at the state check, before any call.
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fromPackage } from "../src/paths.ts";

const SECRET = "made-up-client-secret-for-tests";
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Res = { status: number; body: any; headers: Record<string, string | string[] | undefined> };

function call(port: number, method: string, p: string, headers: Record<string, string>, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => {
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // Not JSON.
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function start() {
  const dir = mkdtempSync(path.join(tmpdir(), "google-http-"));
  dirs.push(dir);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    ...process.env,
    APP_PORT: String(port),
    APP_DB: path.join(dir, "app.sqlite"),
    APP_LIVE_MODEL: "",
    MODEL_API_KEY: "",
    GOOGLE_CLIENT_ID: "made-up.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: SECRET,
  };
  const child = spawn(process.execPath, [fromPackage("server/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  const code = await new Promise<string>((resolve, reject) => {
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
  const paired = await call(port, "POST", "/api/pair", page(), { code });
  const cookie = (paired.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  return { port, page, cookie, output: () => out };
}

describe("Google routes in the server", () => {
  it("serve the status, connect and a refused callback behind the app's checks", { timeout: 30_000 }, async () => {
    const app = await start();
    expect(app.output()).toContain(`Google redirect URIs for the OAuth client: http://127.0.0.1:${app.port}/auth/google/callback http://localhost:${app.port}/auth/google/callback`);

    // The /api checks apply: a session, and a write from the app's page.
    expect((await call(app.port, "GET", "/api/google", app.page())).status).toBe(401);
    const status = await call(app.port, "GET", "/api/google", app.page({ Cookie: app.cookie }));
    expect(status).toMatchObject({ status: 200, body: { connected: false, email: null, gmail: false, calendar: false, calendarId: null, configured: true, version: 0 } });
    const foreign = await call(app.port, "POST", "/api/google/connect", { ...app.page({ Cookie: app.cookie }), Origin: "https://evil.example" }, { expectedVersion: 0, gmail: true, calendar: true });
    expect(foreign.status).toBe(403);
    const noGeneration = await call(app.port, "POST", "/api/google/connect", { ...app.page({ Cookie: app.cookie }), "X-Case-Generation": "" }, { expectedVersion: 0, gmail: true, calendar: true });
    expect(noGeneration.body).toMatchObject({ error: "generation_required" });

    const connect = await call(app.port, "POST", "/api/google/connect", app.page({ Cookie: app.cookie }), { expectedVersion: 0, gmail: true, calendar: true });
    expect(connect.status).toBe(200);
    const url = new URL(connect.body.authorizeUrl);
    expect(url.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${app.port}/auth/google/callback`);
    expect(url.searchParams.get("client_id")).toBe("made-up.apps.googleusercontent.com");
    expect(connect.body.authorizeUrl).not.toContain(SECRET);
    expect(String(connect.headers["set-cookie"])).toMatch(new RegExp(`^appt_google_flow_${app.port}=[A-Za-z0-9_-]+; Path=/auth/google; HttpOnly; SameSite=Lax`));

    // A callback with a state this browser did not start goes back to the
    // page with an error code, and clears the flow cookie.
    const cb = await call(app.port, "GET", `/auth/google/callback?state=${url.searchParams.get("state")}&code=made-up`, {});
    expect(cb.status).toBe(303);
    expect(cb.headers.location).toBe("/?google_error=invalid_state");
    expect(cb.headers["referrer-policy"]).toBe("no-referrer");
    expect(String(cb.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await call(app.port, "POST", "/auth/google/callback", {})).status).toBe(405);
    expect((await call(app.port, "GET", "/auth/google/callback", { Host: "evil.example" })).status).toBe(403);

    expect(app.output()).toContain("Google connect failed: invalid_state.");
    expect(app.output()).not.toContain(SECRET);
    expect(app.output()).not.toContain("made-up&");
  });
});
