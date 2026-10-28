// 0010 through the real server process on a temporary data folder: the
// loopback callback is reached from the browser's redirect without the
// page's headers, the settings writes keep the page's source checks, PUT
// bodies are read as JSON, and the Meta key lands in a mode 600 file and in
// no log line. Pairing, while it exists, is done when the server prints a
// code.
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fromPackage } from "../src/paths.ts";
import { fakeSecret } from "./provider-fakes.ts";
import { SecretsStore } from "../src/model/providers/secrets.ts";

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Res = { status: number; headers: Record<string, string | string[] | undefined>; text: string };

function call(port: number, method: string, p: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const length = body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(body)) };
    const req = request({ host: "127.0.0.1", port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...length, ...headers } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function startServer() {
  const dir = mkdtempSync(path.join(tmpdir(), "providers-http-"));
  dirs.push(dir);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, APP_PORT: String(port), APP_DB: path.join(dir, "app.sqlite"), APP_LIVE_MODEL: "", MODEL_API_KEY: "" };
  const child = spawn(process.execPath, [fromPackage("server/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stderr!.on("data", (d: Buffer) => (output += d.toString()));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (d: Buffer) => {
      output += d.toString();
      // The pairing line, while pairing exists, follows the first line.
      if (/Appointment change assistant on/.test(output)) setTimeout(resolve, 300);
    });
    child.on("exit", (c) => reject(new Error(`server exited ${c}: ${output}`)));
    setTimeout(() => reject(new Error("server did not start")), 15_000);
  });
  const page: Record<string, string> = { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, "X-Appointments-App": "1" };
  const code = /Pairing code for this run: ([A-Z0-9]{4}-[A-Z0-9]{4})\./.exec(output)?.[1];
  if (code) {
    const res = await call(port, "POST", "/api/pair", page, JSON.stringify({ code }));
    page.Cookie = String((res.headers["set-cookie"] as string[])[0]).split(";")[0]!;
  }
  return { dir, port, page, output: () => output };
}

describe("0010 provider routes on the real server", () => {
  it("the callback redirects without the page's headers, and settings writes keep the source checks", async () => {
    const app = await startServer();
    const cb = await call(app.port, "GET", "/auth/callback?state=forged&code=c", {});
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe("/?signInError=state_mismatch");
    expect(cb.headers["cache-control"]).toBe("no-store");
    expect(cb.headers["referrer-policy"]).toBe("no-referrer");

    const settings = await call(app.port, "GET", "/api/settings", app.page);
    expect(settings.status).toBe(200);
    expect(JSON.parse(settings.text)).toMatchObject({ settingsVersion: 0, provider: null, meta: { keySet: false } });

    const key = fakeSecret("metakey");
    const foreign = await call(app.port, "POST", "/api/auth/meta-key", { ...app.page, Origin: "https://evil.example" }, JSON.stringify({ key, expectedVersion: 0 }));
    expect(foreign.status).toBe(403);
    const saved = await call(app.port, "POST", "/api/auth/meta-key", app.page, JSON.stringify({ key, expectedVersion: 0 }));
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(key);
    const file = path.join(app.dir, "app-secrets.sqlite");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const peek = new SecretsStore(file);
    expect(peek.read().meta).toEqual({ key });
    peek.close();

    const notJson = await call(app.port, "PUT", "/api/settings/model", { ...app.page, "Content-Type": "text/plain" }, "x");
    expect(notJson.status).toBe(415);
    const model = await call(app.port, "PUT", "/api/settings/model", app.page, JSON.stringify({ model: "muse-wonder-1.0", expectedVersion: 1 }));
    expect(JSON.parse(model.text)).toMatchObject({ model: "muse-wonder-1.0", settingsVersion: 2 });

    const stale = await call(app.port, "DELETE", "/api/auth/meta-key", app.page, JSON.stringify({ expectedVersion: 1 }));
    expect(stale.status).toBe(409);
    const removed = await call(app.port, "DELETE", "/api/auth/meta-key", app.page, JSON.stringify({ expectedVersion: 2 }));
    expect(JSON.parse(removed.text)).toMatchObject({ meta: { keySet: false } });
    expect(app.output()).not.toContain(key);
  }, 30_000);
});
