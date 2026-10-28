// Local server for the UI. Binds to 127.0.0.1 only. `pnpm dev` serves the
// UI through Vite in middleware mode. `pnpm start` (--static) serves the
// production build from dist/ui (see static.ts). Uses recorded model
// responses unless APP_LIVE_MODEL=1 is set, which also needs MODEL_API_KEY.
//
// Environment:
//   APP_PORT           port, default 5180
//   APP_DB             event log file, default data/app.sqlite in the package
//   APP_LIVE_MODEL     set to 1 for the live model
//   APP_ALLOWED_HOSTS  more host names, comma-separated, for a private
//                      proxy such as Tailscale serve (see hosts.ts)
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { CaseService } from "../src/case/service.ts";
import { loadCaseProfile } from "../src/fixtures/load.ts";
import { IntakeService } from "../src/intake/service.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { MetaResponsesClient, type ModelClient } from "../src/model/client.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { appDbPath, fromPackage } from "../src/paths.ts";
import { EventStore } from "../src/store/event-log.ts";
import { createApi } from "./api.ts";
import { CHAT_PATH, createChat, sseFrame } from "./chat.ts";
import { CaseAgent } from "../src/agent/agent.ts";
import { defaultMessageId } from "../src/agent/tools.ts";
import { RecordedChatClient, fixtureMessageIds } from "../src/agent/recorded.ts";
import type { ToolModelClient } from "../src/model/responses.ts";
import { APP_HEADER, requestSourceProblem } from "./guard.ts";
import { AllowedHostsError, appHosts, hostAllowed, parseAllowedHosts } from "./hosts.ts";
import { API_SECURITY_HEADERS, createStaticHandler } from "./static.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.APP_PORT ?? 5180);
const MAX_BODY = 64 * 1024;
const live = process.env.APP_LIVE_MODEL === "1";
const serveBuild = process.argv.includes("--static");

let extraHosts: string[];
try {
  extraHosts = parseAllowedHosts(process.env.APP_ALLOWED_HOSTS);
} catch (err) {
  if (!(err instanceof AllowedHostsError)) throw err;
  console.error(err.message);
  process.exit(2);
}

let client: ModelClient;
let chatClient: ToolModelClient;
if (live) {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    console.error("APP_LIVE_MODEL=1 needs MODEL_API_KEY in the environment.");
    process.exit(2);
  }
  const meta = new MetaResponsesClient({ apiKey });
  client = meta;
  chatClient = meta;
} else {
  client = RecordedModelClient.fromDirectory();
  chatClient = RecordedChatClient.fromDirectory();
}

const dbPath = appDbPath();
mkdirSync(path.dirname(dbPath), { recursive: true });
const store = new EventStore(dbPath);
// Finish a Delete case that stopped before it cleared the file.
try {
  if (store.finishPendingErase()) console.log("Finished clearing a deleted case from the database file.");
} catch (err) {
  console.error(`Could not finish clearing a deleted case from the database file: ${err instanceof Error ? err.message : String(err)}`);
}
const intake = new IntakeService(store, client);
const kase = new CaseService(store, intake, client, { userName: loadCaseProfile().user_name });
const reply = new ReplyService(store, kase, client);
const records = new RecordsService(store, intake, kase);
const api = createApi(intake, kase, { mode: live ? "live" : "recorded" }, reply, { store, records });
// The case agent (0007). In recorded mode a pasted fixture message keeps
// its fixture id, so its extraction recording replays.
const chat = createChat(
  new CaseAgent(store, { intake, kase, reply, records }, chatClient, {
    messageIdFor: live ? defaultMessageId : fixtureMessageIds(defaultMessageId),
    // Codes only: no key, headers or message text.
    onCallError: (e) =>
      console.error(`Chat model call ${e.call} (${e.kind}) failed: HTTP ${e.status ?? "none"}, type ${e.type ?? "none"}, code ${e.code ?? "none"}.`),
  }),
);

const allowed = appHosts(PORT, extraHosts);
const appOrigins = allowed.origins;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body_too_large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...API_SECURITY_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

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

server.on("request", async (req, res) => {
  // Refuse requests addressed to any other host name, so a page on another
  // site cannot reach this server through DNS rebinding.
  if (!hostAllowed(allowed, req.headers.host)) return send(res, 403, { error: "forbidden_host" });
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (!url.pathname.startsWith("/api/")) return ui(req, res);
  // Set before any route runs, so a route that writes its own response,
  // such as the chat's event stream, carries them too.
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) res.setHeader(name, value);
  const headerOf = (name: string) => {
    const v = req.headers[name];
    return typeof v === "string" ? v : undefined;
  };
  // Defense in depth. See guard.ts.
  const problem = requestSourceProblem(
    { method: req.method ?? "GET", secFetchSite: headerOf("sec-fetch-site"), origin: headerOf("origin"), appHeader: headerOf(APP_HEADER) },
    appOrigins,
  );
  if (problem) return send(res, 403, { error: "forbidden_source", message: problem });
  // No pairing or session (0009, J3): the host check above and the
  // same-origin and app header checks keep other sites out.
  const hasBody = req.method === "POST" || req.method === "PUT";
  if (hasBody && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return send(res, 415, { error: "json_required" });
  }
  let body: unknown;
  try {
    body = hasBody ? await readBody(req) : undefined;
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : "bad_body" });
  }
  const header = req.headers["x-case-generation"];
  // A missing or malformed header leaves it undefined, and the API refuses
  // the write.
  const generation = typeof header === "string" && /^\d{1,15}$/.test(header) ? Number(header) : undefined;
  if (url.pathname === CHAT_PATH) {
    // The turn runs to its end even if the page goes away, so its writes
    // and the stored chat stay whole. Events after a disconnect are dropped.
    res.on("error", () => {});
    const open = () => !res.writableEnded && !res.destroyed;
    try {
      await chat.serve(
        { method: req.method ?? "GET", body, generation },
        {
          json: (status, payload) => send(res, status, payload),
          event: (e) => {
            if (!res.headersSent) {
              res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
            }
            if (open()) res.write(sseFrame(e));
          },
          end: () => {
            if (open()) res.end();
          },
        },
      );
    } catch {
      if (!res.headersSent) send(res, 500, { error: "server_error", message: "The server could not complete the request." });
      else if (open()) res.end();
    }
    return;
  }
  const result = await api({ method: req.method ?? "GET", path: url.pathname, body, generation });
  send(res, result.status, result.body);
});

server.listen(PORT, HOST, () => {
  console.log(`Appointment change assistant on http://${HOST}:${PORT} (model: ${live ? "live" : "recorded responses"})`);
  console.log(serveBuild ? "Serving the production build from dist/ui." : "Serving the UI through Vite for development.");
  if (extraHosts.length > 0) console.log(`Also answers to: ${extraHosts.join(", ")}`);
});

const shutdown = async () => {
  await closeUi();
  server.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
