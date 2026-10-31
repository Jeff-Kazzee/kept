// HTTP routes for the Google connection (0012). Kept free of sockets so
// tests can call them directly. main.ts runs the /api/google routes behind
// the same checks as every other /api route (host allowlist, same-origin
// guard, app header, paired session), and these routes add the expected
// version and the case generation for each write.
//
//   GET  /api/google              status, never a token
//   POST /api/google/connect      { expectedVersion, gmail?, calendar?, calendarId? } -> { authorizeUrl }
//                                 Both permissions and the primary calendar
//                                 unless the body says otherwise. The version
//                                 is the one GET /api/google answered (review
//                                 round 3, finding 8).
//   POST /api/google/disconnect   { expectedVersion } -> status and { revoked }
//   POST /api/google/calendar/refresh  {} -> { events, read }  reads Google
//                                 Calendar again for the case's clash checks.
//                                 `read` is the read's time, count and window
//                                 (0016, H2), also in GET /api/google as
//                                 `calendarRead`.
//   GET  /auth/google/callback    Google sends the browser here. Redirects to
//                                 /?connected=google, or /?google_error=<code>.
//
// The callback is a top-level navigation from Google, so it carries no app
// header. The single-use `state` and an HttpOnly cookie set by the connect
// route bind it to the browser that started the flow.
import { z } from "zod";
import { CalendarId, DEFAULT_CALENDAR_ID, type GoogleConnection, type GoogleLink } from "../src/google/connection.ts";
import { GoogleError } from "../src/google/http.ts";
import type { GoogleCalendarEvents } from "../src/google/events.ts";
import { FLOW_TTL_MS, OAuthError } from "../src/google/oauth.ts";

export const GOOGLE_CALLBACK_PATH = "/auth/google/callback";
// The flow cookie's name carries the app's port, so two apps on one host
// do not share it, and over HTTPS it has the __Host- prefix, so only this
// host, over HTTPS, at Path=/ can set it (review round 1, finding 7).
// Cookies are not separated by port, so a page on another port of the same
// host can still set the plain name. The state the server keeps is the
// second factor: a cookie alone finishes no flow.
export const flowCookieName = (port: number, secure: boolean) => `${secure ? "__Host-" : ""}appt_google_flow_${port}`;

export type GoogleRouteRequest = {
  method: string;
  path: string;
  body: unknown;
  generation?: number;
  // The Host header, already checked against the allowlist.
  host: string | undefined;
  // The page was reached over HTTPS, through a private proxy.
  secure: boolean;
};
export type GoogleRouteResponse = { status: number; body: unknown; setCookie?: string };

const Version = z.number().int().nonnegative();
const ConnectBody = z
  .object({ expectedVersion: Version, gmail: z.boolean().default(true), calendar: z.boolean().default(true), calendarId: CalendarId.optional() })
  .strict()
  .refine((b) => b.gmail || b.calendar, "Turn on Gmail, Calendar or both.");
const DisconnectBody = z.object({ expectedVersion: Version }).strict();
const RefreshBody = z.object({}).strict();

// The redirect URIs to register in the Google OAuth client: the app's own
// loopback addresses, and the HTTPS address of each APP_ALLOWED_HOSTS name.
export function googleRedirectUris(port: number, extraHosts: readonly string[]): string[] {
  return [
    `http://127.0.0.1:${port}${GOOGLE_CALLBACK_PATH}`,
    `http://localhost:${port}${GOOGLE_CALLBACK_PATH}`,
    ...extraHosts.map((h) => `https://${h}${GOOGLE_CALLBACK_PATH}`),
  ];
}

// The callback on the same host the page uses, so the browser sends the flow
// cookie back. Google allows plain http only for loopback addresses.
export function redirectUriFor(host: string | undefined, secure: boolean, port: number, extraHosts: readonly string[]): string | null {
  const h = (host ?? "").toLowerCase();
  const registered = googleRedirectUris(port, extraHosts);
  const uri = h === `127.0.0.1:${port}` || h === `localhost:${port}` ? `http://${h}${GOOGLE_CALLBACK_PATH}` : secure ? `https://${h.replace(/:443$/, "")}${GOOGLE_CALLBACK_PATH}` : null;
  return uri !== null && registered.includes(uri) ? uri : null;
}

function cookieOf(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const flowCookie = (port: number, value: string, secure: boolean, maxAge: number) =>
  secure
    ? `${flowCookieName(port, true)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Secure`
    : `${flowCookieName(port, false)}=${value}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

const STATUS_OF: Partial<Record<GoogleError["code"], number>> = {
  google_not_configured: 503,
  google_stale: 409,
  google_unavailable: 503,
};

export type GoogleRoutesOptions = {
  connection: GoogleConnection;
  // The current case generation.
  generation: () => number;
  port: number;
  extraHosts: readonly string[];
  // Codes only, never a token or a query string.
  onCallbackError?: (code: string) => void;
  // The Google Calendar events of the case's clash checks, and the dates
  // their window starts from: the case's appointments and today.
  events?: GoogleCalendarEvents;
  caseDates?: () => { dates: string[]; today: string };
  // Called after a disconnect, and after a connect that names another
  // account or calendar, to close the open Google intents (CaseActions).
  onConnectionChange?: (reason: "disconnected" | "account_changed") => void;
  // Called after a disconnect, and after a connect as another Google
  // account, to drop the Gmail offers (0018, fix round 2, F4).
  onGmailAccountChange?: (reason: "disconnected" | "account_changed") => void;
  // The connection the tools use, when it is not `connection` alone: on
  // the hosted site with APP_DEMO_GOOGLE, the shared demo connection for an
  // account without its own (0021, D3). Connect and disconnect still act on
  // `connection`.
  link?: GoogleLink;
  // While the account uses the shared demo connection: whether it is
  // connected, for Connections' one line (D7). Never its address.
  demo?: () => { connected: boolean; ownConnect: boolean } | null;
  // A sentence refusing Connect for this account, or null (D7: judges).
  connectRefused?: () => string | null;
};

export function createGoogleRoutes(options: GoogleRoutesOptions) {
  const { connection, port, extraHosts } = options;
  const link = options.link ?? connection;

  // Reads the window of the case's clash checks again. Nothing to do
  // without the events or the calendar permission.
  const refreshEvents = async (): Promise<number> => {
    if (!options.events || !options.caseDates || !link.status().calendar) return 0;
    const { dates, today } = options.caseDates();
    await options.events.refresh(dates, today);
    return options.events.status().events;
  };
  const readStatus = () => (options.events && link.status().calendar ? { calendarRead: options.events.status(), calendarOwn: options.events.ownSeen() } : {});
  const demoStatus = () => {
    const demo = options.demo?.() ?? null;
    return demo ? { demo } : {};
  };

  const fail = (err: unknown): GoogleRouteResponse => {
    if (err instanceof GoogleError) {
      const body: Record<string, unknown> = { error: err.code, message: err.message };
      if (err.code === "google_stale") body.current = connection.status();
      return { status: STATUS_OF[err.code] ?? 502, body };
    }
    if (err instanceof z.ZodError) {
      return { status: 400, body: { error: "invalid_body", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } };
    }
    return { status: 500, body: { error: "server_error", message: "The server could not complete the request." } };
  };

  const routes: Record<string, { method: string; run: (req: GoogleRouteRequest) => Promise<GoogleRouteResponse> | GoogleRouteResponse }> = {
    "/api/google": { method: "GET", run: () => ({ status: 200, body: { ...connection.status(), ...readStatus(), ...demoStatus() } }) },
    "/api/google/connect": {
      method: "POST",
      run: (req) => {
        const body = ConnectBody.parse(req.body);
        const refused = options.connectRefused?.() ?? null;
        if (refused !== null) return { status: 403, body: { error: "connect_not_offered", message: refused } };
        const redirectUri = redirectUriFor(req.host, req.secure, port, extraHosts);
        if (redirectUri === null) {
          return {
            status: 422,
            body: { error: "redirect_unavailable", message: "Google can return only to this app on 127.0.0.1, localhost or an HTTPS address in APP_ALLOWED_HOSTS. Open the app at one of those and try again." },
          };
        }
        const { authorizeUrl, cookie } = connection.startConnect({
          expectedVersion: body.expectedVersion,
          features: { gmail: body.gmail, calendar: body.calendar },
          calendarId: body.calendarId ?? DEFAULT_CALENDAR_ID,
          redirectUri,
        });
        // Review round 3, finding 6: the clash checks drop the current
        // events as a connect starts, so another account's events never
        // stay. Only once the connect started (review round 4, item 6).
        options.events?.clear();
        return { status: 200, body: { authorizeUrl }, setCookie: flowCookie(port, cookie, redirectUri.startsWith("https://"), FLOW_TTL_MS / 1000) };
      },
    },
    "/api/google/disconnect": {
      method: "POST",
      run: async (req) => {
        const { expectedVersion } = DisconnectBody.parse(req.body);
        const { revoked } = await connection.disconnect(expectedVersion);
        options.events?.clear();
        // Review round 4, item 3: open Google intents end with the
        // connection they were made for.
        options.onConnectionChange?.("disconnected");
        options.onGmailAccountChange?.("disconnected");
        return { status: 200, body: { ...connection.status(), revoked } };
      },
    },
    "/api/google/calendar/refresh": {
      method: "POST",
      run: async (req) => {
        RefreshBody.parse(req.body ?? {});
        const events = await refreshEvents();
        return { status: 200, body: { events, ...(options.events ? { read: options.events.status() } : {}) } };
      },
    },
  };

  return {
    handles: (path: string) => path === "/api/google" || path.startsWith("/api/google/"),
    redirectUris: () => googleRedirectUris(port, extraHosts),

    async api(req: GoogleRouteRequest): Promise<GoogleRouteResponse> {
      const route = routes[req.path];
      if (!route) return { status: 404, body: { error: "not_found" } };
      if (req.method !== route.method) return { status: 405, body: { error: "method_not_allowed" } };
      if (route.method !== "GET") {
        if (!(Number.isSafeInteger(req.generation) && req.generation! >= 0)) {
          return {
            status: 400,
            body: { error: "generation_required", message: "This request does not say which case it was made for. Reload the page and try again. Nothing was saved." },
          };
        }
        if (req.generation !== options.generation()) {
          return { status: 409, body: { error: "case_deleted", message: "The case was deleted since this page read it. Reload the page. Nothing was saved." } };
        }
      }
      try {
        return await route.run(req);
      } catch (err) {
        return fail(err);
      }
    },

    // GET /auth/google/callback. Returns where to send the browser and the
    // cookies that clear the flow cookie. Only the cookie form the flow was
    // started with is read: the __Host- one for an HTTPS flow, the plain one
    // for a loopback flow.
    async callback(url: URL, cookieHeader: string | undefined): Promise<{ location: string; setCookie: string[] }> {
      const q = url.searchParams;
      const clear = [flowCookie(port, "", true, 0), flowCookie(port, "", false, 0)];
      const cookie = (secure: boolean) => cookieOf(cookieHeader, flowCookieName(port, secure));
      try {
        const before = link.accountKey();
        // Fix round 2, F4: the Gmail offers go only when the account
        // itself changes, not the calendar or a reconnect of the same one.
        const accountBefore = link.storedAccount();
        await connection.finishConnect({ state: q.get("state"), code: q.get("code"), error: q.get("error"), cookie });
        if (link.accountKey() !== before) options.onConnectionChange?.("account_changed");
        if (link.storedAccount() !== accountBefore) options.onGmailAccountChange?.("account_changed");
        // The clash checks read the new calendar. A failure here leaves them
        // as they were, and the connect still stands.
        await refreshEvents().catch(() => {});
        return { location: "/?connected=google", setCookie: clear };
      } catch (err) {
        const code = err instanceof OAuthError ? err.code : err instanceof GoogleError ? err.code : "server_error";
        options.onCallbackError?.(code);
        return { location: `/?google_error=${encodeURIComponent(code)}`, setCookie: clear };
      }
    },
  };
}
