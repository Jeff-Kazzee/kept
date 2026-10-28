// Local server for the UI. Binds to 127.0.0.1 only. `pnpm dev` serves the
// UI through Vite in middleware mode. `pnpm start` (--static) serves the
// production build from dist/ui (see static.ts). Every model call goes to
// the provider chosen in the app's settings (0010): the user's Meta key,
// the server's MODEL_API_KEY, or Sign in with ChatGPT. There is no recorded
// mode (J12): with no provider ready, the chat and every model step answer
// a fixed sentence that links to Settings, and nothing is replayed.
//
// APP_MODE=hosted runs the hosted site instead (0014, server/hosted.ts):
// accounts that sign in with Google or a judge code, one workspace each,
// and the server's key reached only through usage credits.
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
//   APP_ALLOWED_HOSTS  more host names, comma-separated, for a private
//                      proxy such as Tailscale serve (see hosts.ts)
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//                      the Google OAuth client, for the built-in Gmail and
//                      Calendar connection (docs/google.md), and in hosted
//                      mode for Sign in with Google
//   APP_MODE, APP_MARKUP, APP_DAILY_COST_CAP_USD, APP_JUDGE_TOTAL_CAP_USD,
//   APP_SERVER_KEY     hosted mode (src/hosted/config.ts, docs/hosted.md)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { clientFromEnv } from "../src/google/connection.ts";
import { ConfigError, readHostedConfig } from "../src/hosted/config.ts";
import { appSecretsPath } from "../src/model/providers/secrets.ts";
import { appDbPath, fromPackage } from "../src/paths.ts";
import { CALLBACK_PATH } from "./auth.ts";
import { GOOGLE_CALLBACK_PATH } from "./google.ts";
import { createHostedApp } from "./hosted.ts";
import { AllowedHostsError, appHosts, hostAllowed, parseAllowedHosts } from "./hosts.ts";
import { apiPreamble, secureRequest } from "./http.ts";
import { API_SECURITY_HEADERS, createStaticHandler } from "./static.ts";
import { createWorkspace, send, serveApi } from "./workspace.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.APP_PORT ?? 5180);
const serveBuild = process.argv.includes("--static");

let extraHosts: string[];
let config: ReturnType<typeof readHostedConfig>;
try {
  extraHosts = parseAllowedHosts(process.env.APP_ALLOWED_HOSTS);
  config = readHostedConfig();
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
// The production build, or Vite for development. Vite is loaded only for
// development, so `pnpm start` does not need it.
let ui: (req: IncomingMessage, res: ServerResponse) => void;
let closeUi = async () => {};
if (serveBuild) {
  try {
    ui = createStaticHandler(fromPackage("dist/ui"));
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

let closeApp: () => void;
let started: () => void;

if (config.mode === "hosted") {
  const hosted = createHostedApp({ config, port: PORT, extraHosts, googleClient, serverMetaKey, ui, logRejected: process.env.APP_LOG_REJECTED === "1" });
  server.on("request", hosted.handle);
  closeApp = hosted.close;
  started = () => {
    console.log(`Appointment change assistant, hosted mode, on http://${HOST}:${PORT}`);
    for (const line of hosted.startLines()) console.log(line);
  };
} else {
  const ws = createWorkspace({ dbPath: appDbPath(), secretsPath: appSecretsPath(), port: PORT, extraHosts, googleClient, serverMetaKey, logRejected: process.env.APP_LOG_REJECTED === "1" });
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
    await serveApi(ws, { method: req.method ?? "GET", path: url.pathname, body: input.body, generation: input.generation, host: req.headers.host, secure: secureRequest(req) }, res);
  });
  started = () => {
    console.log(`Appointment change assistant on http://${HOST}:${PORT} (model: ${ws.client.ready() ? ws.client.label : "none ready, add one in Connections"})`);
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
