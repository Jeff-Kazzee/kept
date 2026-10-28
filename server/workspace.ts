// One workspace: every service of one case, built from its event log path
// and its secrets path (0014, design item 2). Local mode builds one, at
// data/app.sqlite and data/app-secrets.sqlite. Hosted mode builds one per
// account, under data/accounts/<account id>/, so no store, connection,
// client or route of one account can reach another's.
//
// `serveApi` answers an /api request for a workspace after the server ran
// its host, source, content type and body checks. Local mode and hosted
// mode share it, so a route behaves the same in both.
import { mkdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { CaseActions } from "../src/actions/service.ts";
import { CaseAgent, replacedAnswerLine } from "../src/agent/agent.ts";
import { defaultMessageId } from "../src/agent/tools.ts";
import { CaseService } from "../src/case/service.ts";
import { localDate } from "../src/domain/zone.ts";
import { loadCaseProfile } from "../src/fixtures/load.ts";
import { GoogleCalendar } from "../src/google/calendar.ts";
import { GoogleConnection } from "../src/google/connection.ts";
import { GoogleCalendarEvents } from "../src/google/events.ts";
import { Gmail } from "../src/google/gmail.ts";
import type { FetchLike } from "../src/google/http.ts";
import type { OAuthClient } from "../src/google/oauth.ts";
import type { GoogleServices } from "../src/google/tools.ts";
import { IntakeService } from "../src/intake/service.ts";
import { ChatGptAuth } from "../src/model/providers/chatgpt-auth.ts";
import { ProviderModelClient, createProviderClient, type LiveClient, type ProviderDefinition } from "../src/model/providers/factory.ts";
import { providerError } from "../src/model/providers/messages.ts";
import { SecretsStore } from "../src/model/providers/secrets.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { timezoneSettings } from "../src/settings/events.ts";
import { EventStore } from "../src/store/event-log.ts";
import { createApi } from "./api.ts";
import { createAuth } from "./auth.ts";
import { CHAT_PATH, createChat, sseFrame } from "./chat.ts";
import { createGoogleRoutes } from "./google.ts";
import { API_SECURITY_HEADERS } from "./static.ts";

// Hosted mode's provider part: the metered client on the server key, and
// the sentence ChatGPT answers on the hosted site (J14).
export type HostedProvider = {
  // The metered client for this workspace. `model` reads the Muse model
  // the person chose.
  metered: (secrets: SecretsStore) => LiveClient;
  // Throws a UsageRefusedError when no call could run (agent.ts, admit).
  admit: () => void;
};

// What the settings view says about the server key in hosted mode: it is
// there, and reached only through credits. Never a key.
export const HOSTED_CREDITS_MARKER = "hosted-credits";

export const CHATGPT_HOSTED_TEXT =
  "Sign in with ChatGPT is not available on the hosted site yet. Use usage credits for Meta models, or run the app on your own computer to use ChatGPT. Nothing in your case changed.";

export type WorkspaceOptions = {
  dbPath: string;
  secretsPath: string;
  port: number;
  extraHosts: string[];
  googleClient: OAuthClient | null;
  googleFetch?: FetchLike;
  // Local mode: the server's MODEL_API_KEY, used when the person set no
  // key. Hosted mode passes `hosted` instead.
  serverMetaKey: string | null;
  hosted?: HostedProvider;
  logRejected?: boolean;
  log?: (line: string) => void;
};

export type Workspace = ReturnType<typeof createWorkspace>;

export function createWorkspace(o: WorkspaceOptions) {
  const log = o.log ?? ((line: string) => console.error(line));
  // Provider settings and secrets, beside the event log (0010).
  const secrets = new SecretsStore(o.secretsPath);
  const chatgptAuth = new ChatGptAuth({ store: secrets, port: o.port });
  const serverMetaKey = o.hosted ? HOSTED_CREDITS_MARKER : o.serverMetaKey || null;

  // Every model call goes to the provider chosen in settings, and only to
  // it. In hosted mode Meta is the metered server key, and ChatGPT is not
  // offered (J14).
  let client: ProviderModelClient;
  if (o.hosted) {
    const metered = o.hosted.metered(secrets);
    const credits: ProviderDefinition = { kind: "meta", unavailable: () => null, client: () => metered };
    const chatgpt: ProviderDefinition = {
      kind: "chatgpt",
      unavailable: () => CHATGPT_HOSTED_TEXT,
      client: () => {
        throw providerError(CHATGPT_HOSTED_TEXT, { type: "provider", code: "chatgpt_unavailable" });
      },
    };
    client = new ProviderModelClient({ store: secrets, serverMetaKey, providers: [credits, chatgpt] });
  } else {
    client = createProviderClient({ store: secrets, auth: chatgptAuth, serverMetaKey });
  }
  const ready = () => client.ready();

  mkdirSync(path.dirname(o.dbPath), { recursive: true });
  const store = new EventStore(o.dbPath);
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
  // The Google connection (0012). Its tokens are the `google` row of this
  // workspace's secrets database, outside the event log. The calendar
  // works in the case's time zone, and the events it last read join the
  // case's clash checks.
  const googleConnection = new GoogleConnection({ client: o.googleClient, store: secrets, ...(o.googleFetch ? { fetch: o.googleFetch } : {}) });
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
      ...(o.hosted ? { admit: o.hosted.admit } : {}),
      ...(o.logRejected
        ? {
            onRejected: ({ turnId, rejected }: { turnId: string; rejected: Array<{ text: string; problems: string[] }> }) => {
              for (const r of rejected) log(replacedAnswerLine(turnId, r));
            },
          }
        : {}),
      // Codes only: no key, headers or message text.
      onCallError: (e) => log(`Chat model call ${e.call} (${e.kind}) failed: HTTP ${e.status ?? "none"}, type ${e.type ?? "none"}, code ${e.code ?? "none"}.`),
    }),
  );
  // Closes the open Google intents when the connection changes.
  const googleActions = new CaseActions(store, { intake, kase, reply, records, google });
  const caseDates = () => ({ dates: kase.view().slots.map((s) => s.date), today: localDate(new Date().toISOString(), kase.timeZone()) });
  const googleRoutes = createGoogleRoutes({
    connection: googleConnection,
    generation: () => kase.generation(),
    port: o.port,
    extraHosts: o.extraHosts,
    onCallbackError: (code) => log(`Google connect failed: ${code}.`),
    events: googleEvents,
    caseDates,
    onConnectionChange: (reason) => googleActions.closeGoogleIntents(reason),
  });

  return {
    store,
    secrets,
    client,
    auth,
    kase,
    api,
    chat,
    googleConnection,
    googleEvents,
    googleRoutes,
    // A connection from an earlier run: read its calendar for the clash
    // checks. Codes only on failure.
    refreshCalendar(): void {
      if (!o.googleClient || !googleConnection.status().calendar) return;
      const { dates, today } = caseDates();
      googleEvents.refresh(dates, today).catch((err) =>
        log(`Google Calendar read failed: ${err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "error"}.`),
      );
    },
    close(): void {
      store.close();
      secrets.close();
    },
  };
}

export const MAX_BODY = 64 * 1024;

export function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...API_SECURITY_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export type WorkspaceRequest = {
  method: string;
  path: string;
  body: unknown;
  // From X-Case-Generation. Undefined when missing or malformed, and the
  // API refuses the write.
  generation: number | undefined;
  host: string | undefined;
  secure: boolean;
};

// An /api request for one workspace, after the server's checks.
export async function serveApi(ws: Workspace, req: WorkspaceRequest, res: ServerResponse): Promise<void> {
  // App settings and sign-in. They need no case generation.
  const settingsResult = await ws.auth.handle({ method: req.method, path: req.path, body: req.body });
  if (settingsResult) return send(res, settingsResult.status, settingsResult.body);
  if (req.path === CHAT_PATH) {
    // The turn runs to its end even if the page goes away, so its writes
    // and the stored chat stay whole. Events after a disconnect are dropped.
    res.on("error", () => {});
    const open = () => !res.writableEnded && !res.destroyed;
    try {
      await ws.chat.serve(
        { method: req.method, body: req.body, generation: req.generation },
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
  if (ws.googleRoutes.handles(req.path)) {
    const g = await ws.googleRoutes.api({ method: req.method, path: req.path, body: req.body, generation: req.generation, host: req.host, secure: req.secure });
    if (g.setCookie) res.setHeader("Set-Cookie", g.setCookie);
    return send(res, g.status, g.body);
  }
  const result = await ws.api({ method: req.method, path: req.path, body: req.body, generation: req.generation });
  send(res, result.status, result.body);
}
