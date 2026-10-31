// Local server for the UI. Binds to 127.0.0.1 only. `pnpm dev` serves the
// UI through Vite in middleware mode. `pnpm start` (--static) serves the
// production build from dist/ui (see static.ts). Every model call goes to
// the provider chosen in the app's settings (0010): the user's Meta key,
// the server's MODEL_API_KEY, or Sign in with ChatGPT. There is no recorded
// mode (J12): with no provider ready, the chat and every model step answer
// a fixed sentence that links to Settings, and nothing is replayed.
//
// APP_MODE=hosted runs the hosted site instead (0014, 0020,
// server/hosted.ts): accounts that sign in with an email and password, a
// passkey or a judge code, one workspace each, and the server's key
// reached only through usage credits.
//
// Environment:
//   APP_PORT           port, default 5180
//   APP_DB             event log file, default data/app.sqlite in the package.
//                      Hosted mode keeps its data in the same folder.
//   MODEL_API_KEY      the server's Meta key, used when the user set none.
//                      In hosted mode, the key usage credits pay for.
//   APP_LOG_REJECTED   set to 1 to write each answer the checks refused,
//                      with its problems, to stderr. Only `pnpm demo:check`
//                      sets it, for its temporary app. Model output about
//                      the case, never a key.
//   APP_REQUEST_LOG    1 or 0 turns the request log on or off: one line per
//                      API request with the method, the path, the status and
//                      the time, never a body, header, query or address.
//                      On by default in local mode, off in hosted mode.
//   APP_ALLOWED_HOSTS  more host names, comma-separated, for a private
//                      proxy such as Tailscale serve (see hosts.ts)
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//                      the Google OAuth client, for the built-in Gmail and
//                      Calendar connection (docs/google.md)
//   APP_MODE, APP_MARKUP, APP_DAILY_COST_CAP_USD, APP_JUDGE_TOTAL_CAP_USD,
//   APP_SERVER_KEY, APP_TRUSTED_PROXY, APP_DEMO_GOOGLE
//                      hosted mode (src/hosted/config.ts, docs/hosted.md)
//   BETTER_AUTH_SECRET, BETTER_AUTH_URL, BETTER_AUTH_API_KEY
//                      hosted mode's accounts (src/hosted/auth.ts). The
//                      public origin's host is added to the allowed hosts.
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { clientFromEnv } from "../src/google/connection.ts";
import { AuthFileError, readAuthConfig, type AuthConfig } from "../src/hosted/auth.ts";
import { ConfigError, readHostedConfig } from "../src/hosted/config.ts";
import { AccountsFileError } from "../src/hosted/store.ts";
import { appSecretsPath } from "../src/model/providers/secrets.ts";
import { appDbPath, fromPackage } from "../src/paths.ts";
import { CALLBACK_PATH } from "./auth.ts";
import { GOOGLE_CALLBACK_PATH } from "./google.ts";
import { createHostedApp } from "./hosted.ts";
import { AllowedHostsError, appHosts, hostAllowed, parseAllowedHosts } from "./hosts.ts";
import { apiPreamble, secureRequest } from "./http.ts";
import { requestLogEnabled, requestLogger } from "./request-log.ts";
import { API_SECURITY_HEADERS, FIRST_LOAD_READS, createStaticHandler } from "./static.ts";
import { LIVE_PATH, parseSince, waitForChange } from "./live.ts";
import { bootOf, createWorkspace, liveOf, send, serveApi, type Boot, type Workspace } from "./workspace.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.APP_PORT ?? 5180);
const serveBuild = process.argv.includes("--static");

let extraHosts: string[];
let config: ReturnType<typeof readHostedConfig>;
let authConfig: AuthConfig | null = null;
try {
  extraHosts = parseAllowedHosts(process.env.APP_ALLOWED_HOSTS);
  config = readHostedConfig();
  if (config.mode === "hosted") {
    authConfig = readAuthConfig();
    // The public origin's host, with its port when it has one (0020, B11).
    const publicHost = authConfig.host;
    if (!["localhost", "127.0.0.1"].includes(authConfig.rpId) && !extraHosts.includes(publicHost)) extraHosts.push(publicHost);
  }
} catch (err) {
  if (!(err instanceof AllowedHostsError) && !(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(2);
}

const allowed = appHosts(PORT, extraHosts);
const appOrigins = allowed.origins;
const googleClient = clientFromEnv();
const serverMetaKey = process.env.MODEL_API_KEY || null;

const server = createServer();
// 0017, E4: registered first, so it sees every request.
if (requestLogEnabled(config.mode, process.env.APP_REQUEST_LOG)) server.on("request", requestLogger({ write: (line) => console.log(line) }));
// The production build, or Vite for development. Vite is loaded only for
// development, so `pnpm start` does not need it.
let ui: (req: IncomingMessage, res: ServerResponse) => void;
let closeUi = async () => {};
if (serveBuild) {
  try {
    // 0019, P17: local mode starts its first reads with the page. P30: and
    // renders the case screen on the server when the build has the
    // renderer (dist/ssr). The hosted site does neither.
    const local = config.mode === "local";
    const ssrEntry = fromPackage("dist/ssr/entry-server.js");
    const ssr = local && existsSync(ssrEntry) ? ((await import(pathToFileURL(ssrEntry).href)) as { renderCase: (boot: Boot & { view: "phone" | "laptop" }) => Promise<string> }) : null;
    ui = createStaticHandler(fromPackage("dist/ui"), {
      preload: local ? FIRST_LOAD_READS : [],
      ...(ssr
        ? {
            render: async (req) => {
              if (!renderWorkspace || !hostAllowed(allowed, req.headers.host)) return null;
              const boot = await bootOf(renderWorkspace);
              // A case that kept moving during the read is not rendered: the
              // page reads it on its own.
              if (!boot) return null;
              // 0019, round 3: the browser's mobile hint (sent by default)
              // picks the layout the screen is rendered in.
              const view: "phone" | "laptop" = req.headers["sec-ch-ua-mobile"] === "?1" ? "phone" : "laptop";
              const shown = { ...boot, view };
              return { html: await ssr.renderCase(shown), boot: shown };
            },
          }
        : {}),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
} else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    configFile: fromPackage("vite.config.ts"),
    logLevel: "warn",
    server: { middlewareMode: true, hmr: { server }, allowedHosts: allowed.names },
  });
  ui = vite.middlewares;
  closeUi = () => vite.close();
}

// The local workspace the server renders the case screen from (P30).
let renderWorkspace: Workspace | null = null;
let closeApp: () => void;
let started: () => void;

if (config.mode === "hosted") {
  let hosted: Awaited<ReturnType<typeof createHostedApp>>;
  try {
    hosted = await createHostedApp({ config, auth: authConfig!, port: PORT, extraHosts, googleClient, serverMetaKey, ui, logRejected: process.env.APP_LOG_REJECTED === "1" });
  } catch (err) {
    if (!(err instanceof AuthFileError) && !(err instanceof AccountsFileError)) throw err;
    console.error(err.message);
    process.exit(2);
  }
  server.on("request", hosted.handle);
  closeApp = hosted.close;
  started = () => {
    console.log(`Kept, hosted mode, on http://${HOST}:${PORT}`);
    for (const line of hosted.startLines()) console.log(line);
  };
} else {
  const ws = createWorkspace({ dbPath: appDbPath(), secretsPath: appSecretsPath(), port: PORT, extraHosts, googleClient, serverMetaKey, logRejected: process.env.APP_LOG_REJECTED === "1" });
  renderWorkspace = ws;
  closeApp = ws.close;
  server.on("request", async (req, res) => {
    // Refuse requests addressed to any other host name, so a page on another
    // site cannot reach this server through DNS rebinding.
    if (!hostAllowed(allowed, req.headers.host)) return send(res, 403, { error: "forbidden_host" });
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    if (url.pathname === CALLBACK_PATH) {
      const result = await ws.auth.callback(req.method ?? "GET", url.searchParams);
      res.writeHead(result.status, { ...API_SECURITY_HEADERS, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(result.location ? { Location: result.location } : {}) });
      return res.end();
    }
    if (url.pathname === GOOGLE_CALLBACK_PATH) {
      if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      const { location, setCookie } = await ws.googleRoutes.callback(url, req.headers.cookie);
      res.writeHead(303, { ...API_SECURITY_HEADERS, Location: location, "Set-Cookie": setCookie, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      return res.end();
    }
    if (!url.pathname.startsWith("/api/")) return ui(req, res);
    // No pairing or session (0009, J3): the host check above and the
    // same-origin and app header checks keep other sites out.
    const input = await apiPreamble(req, res, appOrigins);
    if (!input) return;
    // Local mode has no accounts. The page asks, and learns it.
    if (url.pathname === "/api/session") {
      if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      return send(res, 200, { mode: "local" });
    }
    // Round 2, finding 4: the held live read.
    const since = req.method === "GET" && url.pathname === LIVE_PATH ? parseSince(url.search) : null;
    if (since) {
      const live = await waitForChange(() => liveOf(ws), since, { closed: () => res.destroyed || res.writableEnded });
      if (live) send(res, 200, live);
      return;
    }
    await serveApi(ws, { method: req.method ?? "GET", path: url.pathname, body: input.body, generation: input.generation, host: req.headers.host, secure: secureRequest(req) }, res);
  });
  started = () => {
    console.log(`Kept on http://${HOST}:${PORT} (model: ${ws.client.ready() ? ws.client.label : "none ready, add one in Connections"})`);
    console.log("The model provider is chosen in the app's settings. ChatGPT sign-in finishes only in a browser on this computer, or through an SSH tunnel to this port.");
    if (extraHosts.length > 0) console.log(`Also answers to: ${extraHosts.join(", ")}`);
    if (googleClient) {
      console.log(`Google redirect URIs for the OAuth client: ${ws.googleRoutes.redirectUris().join(" ")}`);
      ws.refreshCalendar();
    }
  };
}

server.listen(PORT, HOST, () => {
  started();
  // Last, so a script that waits for this line has read the others.
  console.log(serveBuild ? "Serving the production build from dist/ui." : "Serving the UI through Vite for development.");
});

const shutdown = async () => {
  await closeUi();
  server.close();
  closeApp();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
