// Local server for the UI. Binds to 127.0.0.1 only and serves the UI
// through Vite in middleware mode. Uses recorded model responses unless
// APP_LIVE_MODEL=1 is set, which also needs MODEL_API_KEY.
//
// Environment:
//   APP_PORT        port, default 5180
//   APP_DB          event log file, default data/app.sqlite in the package
//   APP_LIVE_MODEL  set to 1 for the live model
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { createServer as createVite } from "vite";
import { CaseService } from "../src/case/service.ts";
import { IntakeService } from "../src/intake/service.ts";
import { MetaResponsesClient, type ModelClient } from "../src/model/client.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { PACKAGE_ROOT, fromPackage } from "../src/paths.ts";
import { EventStore } from "../src/store/event-log.ts";
import { createApi } from "./api.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.APP_PORT ?? 5180);
const MAX_BODY = 64 * 1024;
const live = process.env.APP_LIVE_MODEL === "1";

let client: ModelClient;
if (live) {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    console.error("APP_LIVE_MODEL=1 needs MODEL_API_KEY in the environment.");
    process.exit(2);
  }
  client = new MetaResponsesClient({ apiKey });
} else {
  client = RecordedModelClient.fromDirectory();
}

const dbPath = path.resolve(PACKAGE_ROOT, process.env.APP_DB ?? "data/app.sqlite");
mkdirSync(path.dirname(dbPath), { recursive: true });
const store = new EventStore(dbPath);
const intake = new IntakeService(store, client);
const api = createApi(intake, new CaseService(store, intake, client), { mode: live ? "live" : "recorded" });

const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

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
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer();
const vite = await createVite({
  root: fromPackage("ui"),
  configFile: false,
  appType: "spa",
  logLevel: "warn",
  server: { middlewareMode: true, hmr: { server } },
});

server.on("request", async (req, res) => {
  // Refuse requests addressed to any other host name, so a page on another
  // site cannot reach this server through DNS rebinding.
  if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, { error: "forbidden_host" });
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (!url.pathname.startsWith("/api/")) return vite.middlewares(req, res);
  if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return send(res, 415, { error: "json_required" });
  }
  let body: unknown;
  try {
    body = req.method === "POST" ? await readBody(req) : undefined;
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : "bad_body" });
  }
  const result = await api({ method: req.method ?? "GET", path: url.pathname, body });
  send(res, result.status, result.body);
});

server.listen(PORT, HOST, () => {
  console.log(`Appointment change assistant on http://${HOST}:${PORT} (model: ${live ? "live" : "recorded responses"})`);
});

const shutdown = async () => {
  await vite.close();
  server.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
