// Local server for the UI. Binds to 127.0.0.1 only. `pnpm dev` serves the
// UI through Vite in middleware mode. `pnpm start` (--static) serves the
// production build from dist/ui (see static.ts). Every model call goes to
// the provider chosen in the app's settings (0010): the user's Meta key,
// the server's MODEL_API_KEY, or Sign in with ChatGPT. There is no recorded
// mode (J12): with no provider ready, the chat and every model step answer
// a fixed sentence that links to Settings, and nothing is replayed.
//
// Environment:
//   APP_PORT           port, default 5180
//   APP_DB             event log file, default data/app.sqlite in the package
//   MODEL_API_KEY      the server's Meta key, used when the user set none
//   APP_LOG_REJECTED   set to 1 to write each answer the checks refused,
//                      with its problems, to stderr. Only `pnpm demo:check`
//                      sets it, for its temporary app. Model output about
//                      the case, never a key.
//   APP_ALLOWED_HOSTS  more host names, comma-separated, for a private
//                      proxy such as Tailscale serve (see hosts.ts)
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//                      the Google OAuth client, for the built-in Gmail and
//                      Calendar connection (docs/google.md)
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { CaseService } from "../src/case/service.ts";
import { loadCaseProfile } from "../src/fixtures/load.ts";
import { IntakeService } from "../src/intake/service.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { ChatGptAuth } from "../src/model/providers/chatgpt-auth.ts";
import { createProviderClient } from "../src/model/providers/factory.ts";
import { SecretsStore, appSecretsPath } from "../src/model/providers/secrets.ts";
import { appDbPath, fromPackage } from "../src/paths.ts";
import { EventStore } from "../src/store/event-log.ts";
import { createApi } from "./api.ts";
import { CALLBACK_PATH, createAuth } from "./auth.ts";
import { timezoneSettings } from "../src/settings/events.ts";
import { CHAT_PATH, createChat, sseFrame } from "./chat.ts";
import { CaseAgent, replacedAnswerLine } from "../src/agent/agent.ts";
import { defaultMessageId } from "../src/agent/tools.ts";
import { APP_HEADER, requestSourceProblem } from "./guard.ts";
import { AllowedHostsError, appHosts, hostAllowed, parseAllowedHosts } from "./hosts.ts";
import { API_SECURITY_HEADERS, createStaticHandler } from "./static.ts";
import { CaseActions } from "../src/actions/service.ts";
import { GoogleCalendar } from "../src/google/calendar.ts";
import { GoogleConnection, clientFromEnv } from "../src/google/connection.ts";
import { GoogleCalendarEvents } from "../src/google/events.ts";
import { Gmail } from "../src/google/gmail.ts";
import type { GoogleServices } from "../src/google/tools.ts";
import { localDate } from "../src/domain/zone.ts";
import { GOOGLE_CALLBACK_PATH, createGoogleRoutes } from "./google.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.APP_PORT ?? 5180);
const MAX_BODY = 64 * 1024;
const serveBuild = process.argv.includes("--static");

let extraHosts: string[];
try {
  extraHosts = parseAllowedHosts(process.env.APP_ALLOWED_HOSTS);
} catch (err) {
  if (!(err instanceof AllowedHostsError)) throw err;
  console.error(err.message);
  process.exit(2);
}

// Provider settings and secrets, beside the event log (0010).
const secrets = new SecretsStore(appSecretsPath());
const chatgptAuth = new ChatGptAuth({ store: secrets, port: PORT });
const serverMetaKey = process.env.MODEL_API_KEY || null;

// Every model call goes to the provider chosen in settings, and only to it.
const client = createProviderClient({ store: secrets, auth: chatgptAuth, serverMetaKey });
const ready = () => client.ready();

const dbPath = appDbPath();
mkdirSync(path.dirname(dbPath), { recursive: true });
const store = new EventStore(dbPath);
// Finish a Delete case that stopped before it cleared the file.
try {
  if (store.finishPendingErase()) console.log("Finished clearing a deleted case from the database file.");
} catch (err) {
  console.error(`Could not finish clearing a deleted case from the database file: ${err instanceof Error ? err.message : String(err)}`);
}
// The settings routes: the time zone part from the settings stream
// (sprint 8), the provider part from the secrets database (0010), one
// settingsVersion for both.
const auth = createAuth({
  store: secrets,
  auth: chatgptAuth,
  serverMetaKey,
  timezone: () => {
    const tz = timezoneSettings(store);
    return { timezone: tz.timezone, timezoneSource: tz.timezoneSource, version: tz.settingsVersion };
  },
});
// The Google connection (0012). Its tokens are the `google` row of the
// secrets database, outside the event log. The calendar works in the case's
// time zone, and the events it last read join the case's clash checks.
const googleConnection = new GoogleConnection({ client: clientFromEnv(), store: secrets });
const googleCalendar = new GoogleCalendar(googleConnection, { timeZone: () => kase.timeZone() });
const googleEvents = new GoogleCalendarEvents(googleCalendar);
const google: GoogleServices = { connection: googleConnection, gmail: new Gmail(googleConnection), calendar: googleCalendar, events: googleEvents };
const intake = new IntakeService(store, client);
const kase = new CaseService(store, intake, client, { userName: loadCaseProfile().user_name, externalCalendar: () => googleEvents.snapshot() });
const reply = new ReplyService(store, kase, client);
const records = new RecordsService(store, intake, kase);
const api = createApi(intake, kase, { settings: auth.source, ready }, reply, { store, records, google });
// The case agent (0007).
const chat = createChat(
  new CaseAgent(store, { intake, kase, reply, records, google }, client, {
    messageIdFor: defaultMessageId,
    ready,
    ...(process.env.APP_LOG_REJECTED === "1"
      ? { onRejected: ({ turnId, rejected }: { turnId: string; rejected: Array<{ text: string; problems: string[] }> }) => {
          for (const r of rejected) console.error(replacedAnswerLine(turnId, r));
        } }
      : {}),
    // Codes only: no key, headers or message text.
    onCallError: (e) =>
      console.error(`Chat model call ${e.call} (${e.kind}) failed: HTTP ${e.status ?? "none"}, type ${e.type ?? "none"}, code ${e.code ?? "none"}.`),
  }),
);

const allowed = appHosts(PORT, extraHosts);
// Closes the open Google intents when the connection changes.
const googleActions = new CaseActions(store, { intake, kase, reply, records, google });
const googleRoutes = createGoogleRoutes({
  connection: googleConnection,
  generation: () => kase.generation(),
  port: PORT,
  extraHosts,
  onCallbackError: (code) => console.error(`Google connect failed: ${code}.`),
  events: googleEvents,
  caseDates: () => ({ dates: kase.view().slots.map((s) => s.date), today: localDate(new Date().toISOString(), kase.timeZone()) }),
  onConnectionChange: (reason) => googleActions.closeGoogleIntents(reason),
});
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
  if (url.pathname === CALLBACK_PATH) {
    const result = await auth.callback(req.method ?? "GET", url.searchParams);
    res.writeHead(result.status, { ...API_SECURITY_HEADERS, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(result.location ? { Location: result.location } : {}) });
    return res.end();
  }
  if (url.pathname === GOOGLE_CALLBACK_PATH) {
    if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
    const { location, setCookie } = await googleRoutes.callback(url, req.headers.cookie);
    res.writeHead(303, { ...API_SECURITY_HEADERS, Location: location, "Set-Cookie": setCookie, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    return res.end();
  }
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
  const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
  if (hasBody && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return send(res, 415, { error: "json_required" });
  }
  let body: unknown;
  try {
    body = hasBody ? await readBody(req) : undefined;
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : "bad_body" });
  }
  // App settings and sign-in. They need no case generation.
  const settingsResult = await auth.handle({ method: req.method ?? "GET", path: url.pathname, body });
  if (settingsResult) return send(res, settingsResult.status, settingsResult.body);
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
  if (googleRoutes.handles(url.pathname)) {
    const secure = (headerOf("origin") ?? "").startsWith("https://") || headerOf("x-forwarded-proto") === "https";
    const g = await googleRoutes.api({ method: req.method ?? "GET", path: url.pathname, body, generation, host: headerOf("host"), secure });
    if (g.setCookie) res.setHeader("Set-Cookie", g.setCookie);
    return send(res, g.status, g.body);
  }
  const result = await api({ method: req.method ?? "GET", path: url.pathname, body, generation });
  send(res, result.status, result.body);
});

server.listen(PORT, HOST, () => {
  console.log(`Appointment change assistant on http://${HOST}:${PORT} (model: ${client.ready() ? client.label : "none ready, add one in Settings"})`);
  console.log("The model provider is chosen in the app's settings. ChatGPT sign-in finishes only in a browser on this computer, or through an SSH tunnel to this port.");
  if (extraHosts.length > 0) console.log(`Also answers to: ${extraHosts.join(", ")}`);
  if (clientFromEnv()) {
    console.log(`Google redirect URIs for the OAuth client: ${googleRoutes.redirectUris().join(" ")}`);
    // A connection from an earlier run: read its calendar for the clash
    // checks. Codes only on failure.
    if (googleConnection.status().calendar) {
      googleEvents.refresh(kase.view().slots.map((s) => s.date), localDate(new Date().toISOString(), kase.timeZone())).catch((err) =>
        console.error(`Google Calendar read failed: ${err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "error"}.`),
      );
    }
  }
  // Last, so a script that waits for this line has read the others.
  console.log(serveBuild ? "Serving the production build from dist/ui." : "Serving the UI through Vite for development.");
});

const shutdown = async () => {
  await closeUi();
  server.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
