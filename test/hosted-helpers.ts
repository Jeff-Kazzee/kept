// Offline helpers for hosted mode tests (0014): the hosted app in this
// process on a temporary data folder, a browser with its own cookie jar,
// Google's fake endpoints with signed ID tokens, and a fake Meta Responses
// endpoint with usage. Nothing reaches the network.
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { FetchLike } from "../src/google/http.ts";
import { readHostedConfig, type HostedConfig } from "../src/hosted/config.ts";
import { GOOGLE_JWKS_URL } from "../src/hosted/signin.ts";
import { createHostedApp } from "../server/hosted.ts";
import { FAKE_CLIENT, FakeGoogle } from "./google-fake.ts";
import { META_URL, completed, jwt, message, signingKey } from "./provider-fakes.ts";

export type Res = { status: number; body: any; text: string; headers: Record<string, string | string[] | undefined> };

// FakeGoogle, with its ID tokens signed by a key served at Google's JWKS
// address, as the account sign-in checks the signature.
export function signedGoogle() {
  const fake = new FakeGoogle();
  const key = signingKey("google-test-key");
  let resign = true;
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === GOOGLE_JWKS_URL) return Response.json({ keys: [key.jwk] }, { headers: { "cache-control": "max-age=3600" } });
    const res = await fake.fetch(input, init ?? {});
    if (resign && url === "https://oauth2.googleapis.com/token" && res.status === 200) {
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.id_token === "string") {
        const payload = JSON.parse(Buffer.from(body.id_token.split(".")[1]!, "base64url").toString("utf8"));
        body.id_token = jwt(payload, key);
      }
      return Response.json(body);
    }
    return res;
  };
  return { fake, key, fetch, unsigned: () => (resign = false) };
}

// The fake Meta endpoint. `next` answers each call. The default answers a
// short text with usage.
export type MetaCall = { body: any; authorization: string | undefined };
export function fakeMeta() {
  const calls: MetaCall[] = [];
  const state = {
    calls,
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 40 } } as Record<string, unknown>,
    // Answers by call, in order. A function is called with the call.
    script: [] as Array<(call: MetaCall) => Response | Promise<Response>>,
    text: "I can help with your appointments.",
  };
  const reply = (call: MetaCall): Response => {
    if (call.body.stream) return new Response(completed([message(state.text)], state.usage as never), { headers: { "content-type": "text/event-stream" } });
    return Response.json({ output: [message(JSON.stringify({ claims: [] }))], usage: state.usage });
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    if (String(input) !== META_URL) throw new Error(`No fake for ${String(input)}.`);
    const headers = new Headers(init.headers);
    const call = { body: JSON.parse(String(init.body)), authorization: headers.get("authorization") ?? undefined };
    calls.push(call);
    const next = state.script.shift();
    return next ? next(call) : reply(call);
  });
  return state;
}

export type Browser = {
  cookies: Map<string, string>;
  call(method: string, p: string, body?: unknown, extra?: Record<string, string>): Promise<Res>;
  // A top-level navigation, as from Google's page: no app header.
  visit(p: string): Promise<Res>;
  cookieHeader(): string;
};

export type Hosted = Awaited<ReturnType<typeof startHosted>>;

export async function startHosted(
  options: { env?: Record<string, string>; config?: Partial<HostedConfig>; serverKey?: string | null; google?: boolean; now?: () => number; maxWorkspaces?: number } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "hosted-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const google = options.google === false ? null : signedGoogle();
  const logs: string[] = [];
  // J19: hosted mode needs both caps set. The tests set them, and trust
  // Cloudflare's header from their loopback socket, unless a test says
  // otherwise.
  const config = {
    ...readHostedConfig({ APP_MODE: "hosted", APP_DAILY_COST_CAP_USD: "20", APP_JUDGE_TOTAL_CAP_USD: "100", APP_TRUSTED_PROXY: "cloudflare", ...options.env }),
    ...options.config,
  };
  const app = createHostedApp({
    config,
    port,
    extraHosts: [],
    googleClient: google ? FAKE_CLIENT : null,
    serverMetaKey: options.serverKey === undefined ? "server-meta-key-for-tests" : options.serverKey,
    ui: (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>ui</title>");
    },
    accountsFile: path.join(dir, "hosted", "accounts.sqlite"),
    workspacesDir: path.join(dir, "accounts"),
    ...(google ? { googleFetch: google.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxWorkspaces ? { maxWorkspaces: options.maxWorkspaces } : {}),
    log: (line) => logs.push(line),
  });
  const server: Server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const raw = (method: string, p: string, headers: Record<string, string>, body?: unknown): Promise<Res> =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        res.on("end", () => {
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // Not JSON, such as an event stream.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text, headers: res.headers });
        });
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });

  const browser = (): Browser => {
    const cookies = new Map<string, string>();
    const keep = (res: Res) => {
      const set = res.headers["set-cookie"];
      for (const c of Array.isArray(set) ? set : set ? [set] : []) {
        const [pair] = c.split(";");
        const eq = pair!.indexOf("=");
        const name = pair!.slice(0, eq);
        const value = pair!.slice(eq + 1);
        if (value === "" || /Max-Age=0/.test(c)) cookies.delete(name);
        else cookies.set(name, value);
      }
      return res;
    };
    const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    return {
      cookies,
      cookieHeader,
      call: async (method, p, body, extra = {}) =>
        keep(
          await raw(
            method,
            p,
            {
              ...(method === "GET" ? {} : { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, "X-Appointments-App": "1" }),
              ...(cookies.size ? { Cookie: cookieHeader() } : {}),
              ...extra,
            },
            body,
          ),
        ),
      visit: async (p) => keep(await raw("GET", p, cookies.size ? { Cookie: cookieHeader() } : {})),
    };
  };

  // Sign in with Google through the fake consent page.
  const googleSignIn = async (b: Browser, account?: { sub: string; email: string; name?: string }) => {
    if (!google) throw new Error("no Google");
    if (account) {
      google.fake.account = { sub: account.sub, email: account.email };
      google.fake.idToken = account.name ? { name: account.name } : {};
    }
    const start = await b.call("POST", "/api/session/google", {});
    if (start.status !== 200) return start;
    const back = google.fake.consent(start.body.authorizeUrl);
    return b.visit(`${back.pathname}${back.search}`);
  };

  // A judge code made through the store, as the admin command does.
  const judgeCode = (label = "Judge", capUsd = 5, days = 30) =>
    app.store.createJudgeCode({ label, capMicros: capUsd * 1_000_000, expiresAt: (options.now ?? Date.now)() + days * 86_400_000, totalCapMicros: config.judgeTotalCapMicros ?? 0 });

  return {
    dir,
    port,
    app,
    google,
    logs,
    config,
    browser,
    googleSignIn,
    judgeCode,
    raw,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The events of an SSE body.
export function sseEvents(text: string): Array<{ event: string; data: any }> {
  return text
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((b) => {
      const event = /^event: (.+)$/m.exec(b)?.[1] ?? "message";
      const data = /^data: (.+)$/m.exec(b)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}
