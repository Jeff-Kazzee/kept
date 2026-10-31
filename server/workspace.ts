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
import { calendarCaseMark } from "../src/google/case-mark.ts";
import { GoogleCalendar } from "../src/google/calendar.ts";
import { GoogleConnection, type GoogleLink } from "../src/google/connection.ts";
import { DEMO_GOOGLE_INSTRUCTION, type DemoGoogle } from "../src/google/demo.ts";
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
import { dropGmailOffers } from "../src/google/offers.ts";
import { createGoogleRoutes } from "./google.ts";
import { API_SECURITY_HEADERS } from "./static.ts";
import { LIVE_PATH, type Live } from "./live.ts";

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
  // Hosted mode with APP_DEMO_GOOGLE (0021): the shared demo connection,
  // this account's id, and whether the account may connect its own Google
  // (not a judge, D7).
  demoGoogle?: { demo: DemoGoogle; accountId: string; ownConnect: boolean };
  logRejected?: boolean;
  log?: (line: string) => void;
};

export type Workspace = ReturnType<typeof createWorkspace>;

// A judge's Connect, while the site shares the demo Gmail and Calendar
// (0021, D7).
export const DEMO_CONNECT_REFUSED = "Judges use the demo Gmail and Calendar, a made-up account shared by judges. Connecting your own Google is not offered here. Nothing changed.";

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
  // 0021, D3: on the hosted site with APP_DEMO_GOOGLE, an account without
  // its own connection uses the shared demo one, with its own mark and
  // limits in the shared calendar (D5, D6).
  const demo = o.demoGoogle ?? null;
  const googleLink = demo ? demo.demo.linkFor(googleConnection, demo.accountId) : null;
  const link: GoogleLink = googleLink ?? googleConnection;
  const sharedCalendar = demo ? demo.demo.sharedCalendar(demo.accountId) : null;
  const googleCalendar = new GoogleCalendar(link, {
    timeZone: () => kase.timeZone(),
    caseMark: (o) => calendarCaseMark(store, o),
    ...(googleLink ? { shared: () => (googleLink.usingShared() ? sharedCalendar : null) } : {}),
  });
  const googleEvents = new GoogleCalendarEvents(googleCalendar);
  const google: GoogleServices = { connection: link, gmail: new Gmail(link), calendar: googleCalendar, events: googleEvents };
  const intake = new IntakeService(store, client);
  const kase = new CaseService(store, intake, client, { externalCalendar: () => googleEvents.snapshot(), externalVersion: () => googleEvents.version() });
  const reply = new ReplyService(store, kase, client);
  const records = new RecordsService(store, intake, kase);
  // Delete case waits for a running chat turn (0017, R1).
  let agent: CaseAgent | null = null;
  const api = createApi(
    intake,
    kase,
    {
      settings: auth.source,
      ready,
      turnRunning: () => agent?.busy ?? false,
      // D6: Delete case removes this account's events from the shared
      // calendar. Counts only in the log.
      ...(demo
        ? {
            onCaseDeleted: async () => {
              const r = await demo.demo.forget(demo.accountId);
              log(`Delete case: removed ${r.removed} event(s) from the demo calendar${r.pending ? ", and the sweep removes the rest later" : ""}.`);
              return { demoCalendar: r.pending ? ("pending" as const) : ("removed" as const) };
            },
          }
        : {}),
    },
    reply,
    { store, records, google },
  );
  // The case agent (0007).
  const chat = createChat(
    (agent = new CaseAgent(store, { intake, kase, reply, records, google }, client, {
      messageIdFor: defaultMessageId,
      ready,
      ...(o.hosted ? { admit: o.hosted.admit } : {}),
      ...(googleLink ? { extraInstructions: () => (googleLink.usingShared() ? DEMO_GOOGLE_INSTRUCTION : null) } : {}),
      ...(o.logRejected
        ? {
            onRejected: ({ turnId, rejected }: { turnId: string; rejected: Array<{ text: string; problems: string[] }> }) => {
              for (const r of rejected) log(replacedAnswerLine(turnId, r));
            },
          }
        : {}),
      // Codes only: no key, headers or message text.
      onCallError: (e) => log(`Chat model call ${e.call} (${e.kind}) failed: HTTP ${e.status ?? "none"}, type ${e.type ?? "none"}, code ${e.code ?? "none"}.`),
    })),
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
    // 0018: no email offered under the old account can be added.
    onGmailAccountChange: (reason) => dropGmailOffers(store, reason),
    ...(googleLink
      ? {
          link: googleLink,
          demo: () => {
            const view = googleLink.demoView();
            return view ? { ...view, ownConnect: demo!.ownConnect } : null;
          },
          connectRefused: () => (demo!.ownConnect ? null : DEMO_CONNECT_REFUSED),
          takeRefresh: () => !googleLink.usingShared() || demo!.demo.takeRefresh(demo!.accountId),
        }
      : {}),
  });

  return {
    store,
    secrets,
    client,
    // The case's services, with the Google connection the tools use.
    services: { intake, kase, reply, records, google },
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
      if (!o.googleClient || !link.status().calendar) return;
      const { dates, today } = caseDates();
      googleEvents.refresh(dates, today).catch((err) =>
        log(`Google Calendar read failed: ${err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "error"}.`),
      );
    },
    // A Google connect is waiting for its callback (workspaces.ts).
    pendingGoogleFlow(): boolean {
      return googleConnection.hasPendingFlow();
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
// The case's live version, as GET /api/case/version answers it.
export async function liveOf(ws: Workspace): Promise<Live> {
  return (await ws.api({ method: "GET", path: LIVE_PATH, body: undefined, generation: undefined })).body as Live;
}

// Round 2, finding 2: what the page needs for its first render, read
// together: the case (with its generation), the settings, the activity,
// Google and the stored chat. The reads are taken again when the live
// version moved while they ran, so every part is of the generation `live`
// names. The page's later reads go through the usual routes.
export const BOOT_PATH = "/api/boot";
export type Boot = { live: Live; state: unknown; settings: unknown; activity: unknown; google: unknown; chat: unknown };

export async function bootOf(ws: Workspace): Promise<Boot | null> {
  const get = async (path: string) => {
    const settings = await ws.auth.handle({ method: "GET", path, body: undefined });
    if (settings) return settings.status === 200 ? settings.body : null;
    if (ws.googleRoutes.handles(path)) {
      const g = await ws.googleRoutes.api({ method: "GET", path, body: undefined, generation: undefined, host: undefined, secure: false });
      return g.status === 200 ? g.body : null;
    }
    const r = await ws.api({ method: "GET", path, body: undefined, generation: undefined });
    return r.status === 200 ? r.body : null;
  };
  const chat = async () => {
    let body: unknown = null;
    await ws.chat.serve(
      { method: "GET", body: undefined, generation: undefined },
      { json: (status, payload) => void (body = status === 200 ? payload : null), event: () => {}, end: () => {} },
    );
    return body;
  };
  for (let attempt = 0; attempt < BOOT_ATTEMPTS; attempt++) {
    const live = await liveOf(ws);
    const [state, settings, activity, google, log] = await Promise.all([get("/api/state"), get("/api/settings"), get("/api/activity"), get("/api/google"), chat()]);
    const after = await liveOf(ws);
    // Round 2, finding 2: the calendar counter too, since the clash checks
    // in `state` read the calendar.
    if (sameLive(after, live)) return { live: after, state, settings, activity, google, chat: log };
  }
  // The case kept moving: no boot, rather than one of mixed versions. The
  // page then reads each route on its own.
  return null;
}

export const BOOT_ATTEMPTS = 5;
export const sameLive = (a: Live, b: Live) => a.generation === b.generation && a.seq === b.seq && (a.calendar ?? 0) === (b.calendar ?? 0);

export async function serveApi(ws: Workspace, req: WorkspaceRequest, res: ServerResponse): Promise<void> {
  if (req.path === BOOT_PATH) {
    if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
    const boot = await bootOf(ws);
    return boot ? send(res, 200, boot) : send(res, 503, { error: "boot_unavailable", message: "The case changed during the read. Read it again." });
  }
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
