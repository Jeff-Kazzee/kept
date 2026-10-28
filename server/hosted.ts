// Hosted mode (0014): the public site. Every person has an account, signed
// in with Google or with a judge code, and one workspace of their own. The
// server's Meta key is reached only through usage credits, and Sign in
// with ChatGPT shows as not available here yet (J14).
//
// Every request goes through the same host allowlist, and every /api
// request through the same source, content type and body checks as in
// local mode (http.ts). Then:
//
//   GET  /api/session              who is signed in, and the balance
//   POST /api/session/google       { } -> { authorizeUrl }, starts Sign in
//                                  with Google. Rate-limited per address.
//   POST /api/session/judge        { code } signs in with a judge code.
//                                  Rate-limited per address.
//   POST /api/session/signout      { } ends the session
//   GET  /api/usage                balance, recent charges, plans, prices
//   POST /api/account/judge-code   { code } adds a judge code's credit to
//                                  the signed-in Google account
//   POST /api/account/delete       { confirmation: "DELETE" }
//   GET  /auth/signin/callback     Google returns the browser here
//
// Every other /api route needs a session, and runs in that session's
// account's workspace only. A person's own Meta key and ChatGPT sign-in
// are refused here. Codes and session tokens never reach a log line.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { DELETE_CONFIRMATION } from "../src/case/constants.ts";
import type { FetchLike } from "../src/google/http.ts";
import { OAuthError, type OAuthClient } from "../src/google/oauth.ts";
import { formatUsd, type HostedConfig } from "../src/hosted/config.ts";
import { MeteredClient } from "../src/hosted/metered.ts";
import { PRICES, turnCostMicros } from "../src/hosted/prices.ts";
import { AddressLimiter, clientAddress } from "../src/hosted/rate-limit.ts";
import { GoogleSignIn, SIGNIN_CALLBACK_PATH, SIGNIN_TTL_MS } from "../src/hosted/signin.ts";
import { AccountsBusyError, AccountsFileError, AccountsStore, JudgeCodeError, SESSION_TTL_MS, accountsPath, workspacesRoot, type Account, type ChargeRow } from "../src/hosted/store.ts";
import { META_MODELS, metaModel } from "../src/model/providers/models.ts";
import { UsageRefusedError, withUsageScope } from "../src/model/usage.ts";
import { CALLBACK_PATH } from "./auth.ts";
import { GOOGLE_CALLBACK_PATH, googleRedirectUris } from "./google.ts";
import { appHosts, hostAllowed } from "./hosts.ts";
import { apiPreamble, secureRequest } from "./http.ts";
import { API_SECURITY_HEADERS } from "./static.ts";
import { CHATGPT_HOSTED_TEXT, createWorkspace, send, serveApi, type Workspace } from "./workspace.ts";
import { WorkspaceBusyError, Workspaces } from "./workspaces.ts";

export type HostedOptions = {
  config: HostedConfig;
  port: number;
  extraHosts: string[];
  googleClient: OAuthClient | null;
  serverMetaKey: string | null;
  ui: (req: IncomingMessage, res: ServerResponse) => void;
  logRejected?: boolean;
  // For tests.
  accountsFile?: string;
  workspacesDir?: string;
  googleFetch?: FetchLike;
  metaUrl?: string;
  now?: () => number;
  log?: (line: string) => void;
};

export const SIGNED_OUT_TEXT = "Sign in to use the assistant. Nothing was saved.";
export const NOT_OFFERED_TEXT = "On the hosted site the assistant uses usage credits, not your own key. Run the app on your own computer to use your own Meta key. Nothing was saved.";
export const CHATGPT_HOSTED_REFUSED_TEXT = "Sign in with ChatGPT is not available on the hosted site yet. It works when you run the app on your own computer. Nothing was changed.";
export const RATE_LIMITED_TEXT = "Too many tries from this address. Wait a few minutes and try again.";
export const SIGNIN_UNAVAILABLE_TEXT = "Sign in with Google is not set up on this site yet. Use a judge code, or try again later.";
export const ACCOUNT_BUSY_TEXT = "The accounts database is busy just now. Try again in a moment. Nothing was changed.";
export const DELETE_ACCOUNT_BUSY_TEXT = "The assistant is still working on something for this account. Wait for it to finish, then delete the account again. Nothing was deleted.";

// What the usage page calls each route's model calls.
export const ROUTE_WORDS: Record<string, string> = {
  chat: "Chat turn",
  extract: "Read a message",
  explain: "Explain a disagreement",
  question: "Next question",
  reply: "Suggest a reply",
  other: "Assistant step",
};

const routeOf = (path: string): string => {
  if (path === "/api/chat") return "chat";
  if (/^\/api\/messages\/[^/]+\/extract$/.test(path)) return "extract";
  if (/^\/api\/conflicts\/[^/]+\/explain$/.test(path)) return "explain";
  if (path === "/api/questions/next") return "question";
  if (path === "/api/reply/suggest") return "reply";
  return "other";
};

// The plans sprint 14 sells through Stripe. Shown as coming soon.
export const PLANS = [
  { id: "credit-20", usd: 20, label: "$20 of usage" },
  { id: "credit-100", usd: 100, label: "$100 of usage" },
];

const JudgeBody = z.object({ code: z.string().max(200) }).strict();
const EmptyBody = z.object({}).strict();
const DeleteBody = z.object({ confirmation: z.string().max(20) }).strict();

export const sessionCookieName = (port: number, secure: boolean) => (secure ? "__Host-appt_session" : `appt_session_${port}`);
const signinCookieName = (port: number, secure: boolean) => (secure ? "__Host-appt_signin" : `appt_signin_${port}`);

function cookieOf(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// HttpOnly, SameSite=Lax. Over HTTPS: the __Host- name, Secure and Path=/.
export function sessionCookie(port: number, secure: boolean, value: string, maxAgeSeconds: number): string {
  return `${sessionCookieName(port, secure)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

const signinCookie = (port: number, secure: boolean, value: string, maxAgeSeconds: number) =>
  secure
    ? `${signinCookieName(port, true)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}; Secure`
    : `${signinCookieName(port, false)}=${value}; Path=/auth/signin; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

// Where Google returns the browser: the app's loopback address, or the
// HTTPS address of an APP_ALLOWED_HOSTS name.
export function signinRedirectUris(port: number, extraHosts: readonly string[]): string[] {
  return [`http://127.0.0.1:${port}${SIGNIN_CALLBACK_PATH}`, `http://localhost:${port}${SIGNIN_CALLBACK_PATH}`, ...extraHosts.map((h) => `https://${h}${SIGNIN_CALLBACK_PATH}`)];
}

function signinRedirectFor(host: string | undefined, secure: boolean, port: number, extraHosts: readonly string[]): string | null {
  const h = (host ?? "").toLowerCase();
  const uri = h === `127.0.0.1:${port}` || h === `localhost:${port}` ? `http://${h}${SIGNIN_CALLBACK_PATH}` : secure ? `https://${h.replace(/:443$/, "")}${SIGNIN_CALLBACK_PATH}` : null;
  return uri !== null && signinRedirectUris(port, extraHosts).includes(uri) ? uri : null;
}

// One line per turn: a chat turn's calls together, every other call on
// its own. Charges come newest first.
export type UsageLine = { at: number; what: string; model: string; modelLabel: string; costMicros: number; cost: string; calls: number };

export function usageLines(charges: ChargeRow[]): UsageLine[] {
  const lines: Array<UsageLine & { turn: string | null }> = [];
  for (const c of charges) {
    const last = lines.at(-1);
    if (c.turn && last && last.turn === c.turn) {
      last.costMicros += c.amountMicros;
      last.cost = formatUsd(last.costMicros);
      last.calls++;
      last.at = Math.max(last.at, c.at);
      continue;
    }
    lines.push({
      turn: c.turn,
      at: c.at,
      what: ROUTE_WORDS[c.route] ?? ROUTE_WORDS.other!,
      model: c.model,
      modelLabel: META_MODELS.find((m) => m.id === c.model)?.label ?? c.model,
      costMicros: c.amountMicros,
      cost: formatUsd(c.amountMicros),
      calls: 1,
    });
  }
  return lines.map(({ turn: _turn, ...line }) => line);
}

// A rough figure, to the nearest cent.
export const turnCostWords = (model: string, markup: number) => {
  const micros = turnCostMicros(model, markup);
  if (micros === null) return null;
  const cents = Math.round(micros / 10_000);
  return cents < 1 ? "less than $0.01 a turn" : `about ${formatUsd(cents * 10_000)} a turn`;
};

export function createHostedApp(o: HostedOptions) {
  const log = o.log ?? ((line: string) => console.error(line));
  const { config, port, extraHosts } = o;
  const now = o.now ?? Date.now;
  const allowed = appHosts(port, extraHosts);
  const store = new AccountsStore(o.accountsFile ?? accountsPath(), { now });
  const signIn = new GoogleSignIn({ client: o.googleClient, ...(o.googleFetch ? { fetch: o.googleFetch } : {}), now });
  const signinLimit = new AddressLimiter({ limit: 10, windowMs: 10 * 60_000, now });
  const judgeLimit = new AddressLimiter({ limit: 10, windowMs: 15 * 60_000, now });
  const serverKey = config.serverKeyOn ? o.serverMetaKey : null;

  // A refusal before a turn starts, so a person with no credit has
  // nothing saved (agent.ts, admit).
  const admit = (accountId: string) => () => {
    if (serverKey === null) throw new UsageRefusedError("server_key_off");
    if (store.dayCost() >= config.dailyCapMicros) throw new UsageRefusedError("daily_cap");
    if (store.balance(accountId) <= 0) throw new UsageRefusedError("credits_exhausted");
  };

  const workspaces = new Workspaces({
    root: o.workspacesDir ?? workspacesRoot(),
    now,
    build: (accountId, files) =>
      createWorkspace({
        ...files,
        port,
        extraHosts,
        googleClient: o.googleClient,
        ...(o.googleFetch ? { googleFetch: o.googleFetch } : {}),
        serverMetaKey: null,
        hosted: {
          metered: (secrets) =>
            new MeteredClient({ store, accountId, workspace: accountId, config, serverKey, model: () => metaModel(secrets.read()), ...(o.metaUrl ? { metaUrl: o.metaUrl } : {}) }),
          admit: admit(accountId),
        },
        logRejected: o.logRejected ?? false,
        log,
      }),
  });

  // Holds left open by a stopped process are charged in full, then every
  // minute idle workspaces close and expired sessions go.
  try {
    const n = store.settleStaleHolds();
    if (n > 0) log(`Charged ${n} usage hold(s) left open by an earlier run.`);
  } catch (err) {
    if (err instanceof AccountsFileError) log(err.message);
    else throw err;
  }
  const timer = setInterval(() => {
    try {
      workspaces.sweep();
      store.settleStaleHolds();
      store.sweepSessions();
    } catch {
      // The next sweep tries again.
    }
  }, 60_000);
  timer.unref();

  const accountView = (account: Account, expiresAt: number) => {
    const balance = store.balance(account.id);
    return {
      mode: "hosted" as const,
      signedIn: true,
      account: { kind: account.kind, email: account.email, name: account.name },
      balanceMicros: balance,
      balance: formatUsd(balance),
      expiresAt,
      googleSignIn: signIn.configured,
    };
  };

  const usageView = (account: Account) => {
    const balance = store.balance(account.id);
    return {
      balanceMicros: balance,
      balance: formatUsd(balance),
      markup: (config.markupHundredths / 100).toString(),
      charges: usageLines(store.charges(account.id, 100)).slice(0, 30),
      plans: PLANS.map((p) => ({ ...p, available: false })),
      models: META_MODELS.map((m) => ({ id: m.id, label: m.label, turnCost: turnCostWords(m.id, config.markupHundredths) })),
      prices: PRICES.map((p) => ({ model: p.model, inputPerMillion: formatUsd(p.input), cachedInputPerMillion: formatUsd(p.cachedInput), outputPerMillion: formatUsd(p.output) })),
      canAddCode: account.kind === "google",
    };
  };

  const sessionOf = (req: IncomingMessage, secure: boolean) => {
    const token = cookieOf(req.headers.cookie, sessionCookieName(port, secure));
    return { token, session: store.session(token) };
  };

  const startSession = (res: ServerResponse, secure: boolean, account: Account) => {
    const { token } = store.createSession(account.id);
    res.setHeader("Set-Cookie", sessionCookie(port, secure, token, Math.floor(SESSION_TTL_MS / 1000)));
  };

  const judgeFailure = (err: JudgeCodeError) => ({ status: err.code === "not_found" ? 404 : 409, body: { error: `judge_${err.code}`, message: err.message } });

  // The account routes. Null for any other path.
  async function accountRoute(req: IncomingMessage, res: ServerResponse, path: string, body: unknown, secure: boolean): Promise<boolean> {
    const method = req.method ?? "GET";
    const address = clientAddress(req.headers, req.socket.remoteAddress);
    const { token, session } = sessionOf(req, secure);
    const only = (m: string) => {
      if (method === m) return true;
      send(res, 405, { error: "method_not_allowed" });
      return false;
    };
    const parsed = <T>(schema: z.ZodType<T>, value: unknown): T | null => {
      const r = schema.safeParse(value ?? {});
      if (r.success) return r.data;
      send(res, 400, { error: "invalid_body", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      return null;
    };
    switch (path) {
      case "/api/session":
        if (!only("GET")) return true;
        if (!session) send(res, 200, { mode: "hosted", signedIn: false, googleSignIn: signIn.configured });
        else send(res, 200, accountView(session.account, session.expiresAt));
        return true;
      case "/api/session/google": {
        if (!only("POST") || parsed(EmptyBody, body) === null) return true;
        if (!signIn.configured) return send(res, 503, { error: "sign_in_unavailable", message: SIGNIN_UNAVAILABLE_TEXT }), true;
        const limit = signinLimit.take(address);
        if (!limit.ok) return send(res, 429, { error: "rate_limited", message: RATE_LIMITED_TEXT, retryAfterSeconds: limit.retryAfterSeconds }), true;
        const redirectUri = signinRedirectFor(req.headers.host, secure, port, extraHosts);
        if (!redirectUri) {
          send(res, 422, { error: "redirect_unavailable", message: "Google can return only to this site's own address. Open the site at its address and try again." });
          return true;
        }
        const { authorizeUrl, cookie } = signIn.start(redirectUri);
        res.setHeader("Set-Cookie", signinCookie(port, redirectUri.startsWith("https://"), cookie, SIGNIN_TTL_MS / 1000));
        send(res, 200, { authorizeUrl });
        return true;
      }
      case "/api/session/judge": {
        if (!only("POST")) return true;
        const b = parsed(JudgeBody, body);
        if (!b) return true;
        const limit = judgeLimit.take(address);
        if (!limit.ok) return send(res, 429, { error: "rate_limited", message: RATE_LIMITED_TEXT, retryAfterSeconds: limit.retryAfterSeconds }), true;
        try {
          const account = store.redeemJudgeCode(b.code.trim());
          if (token) store.endSession(token);
          startSession(res, secure, account);
          send(res, 200, accountView(account, now() + SESSION_TTL_MS));
        } catch (err) {
          if (err instanceof JudgeCodeError) {
            const f = judgeFailure(err);
            send(res, f.status, f.body);
          } else throw err;
        }
        return true;
      }
      case "/api/session/signout":
        if (!only("POST") || parsed(EmptyBody, body) === null) return true;
        store.endSession(token);
        res.setHeader("Set-Cookie", sessionCookie(port, secure, "", 0));
        send(res, 200, { mode: "hosted", signedIn: false, googleSignIn: signIn.configured });
        return true;
      case "/api/usage":
        if (!only("GET")) return true;
        if (!session) return send(res, 401, { error: "signed_out", message: SIGNED_OUT_TEXT }), true;
        send(res, 200, usageView(session.account));
        return true;
      case "/api/account/judge-code": {
        if (!only("POST")) return true;
        if (!session) return send(res, 401, { error: "signed_out", message: SIGNED_OUT_TEXT }), true;
        const b = parsed(JudgeBody, body);
        if (!b) return true;
        const limit = judgeLimit.take(address);
        if (!limit.ok) return send(res, 429, { error: "rate_limited", message: RATE_LIMITED_TEXT, retryAfterSeconds: limit.retryAfterSeconds }), true;
        try {
          store.redeemJudgeCode(b.code.trim(), session.account.id);
          send(res, 200, usageView(session.account));
        } catch (err) {
          if (err instanceof JudgeCodeError) {
            const f = judgeFailure(err);
            send(res, f.status, f.body);
          } else throw err;
        }
        return true;
      }
      case "/api/account/delete": {
        if (!only("POST")) return true;
        if (!session) return send(res, 401, { error: "signed_out", message: SIGNED_OUT_TEXT }), true;
        const b = parsed(DeleteBody, body);
        if (!b) return true;
        if (b.confirmation !== DELETE_CONFIRMATION) {
          send(res, 422, { error: "confirmation_mismatch", message: `Type ${DELETE_CONFIRMATION} to delete your account. Nothing was deleted.` });
          return true;
        }
        const id = session.account.id;
        // The Google grant is revoked first, when there is one.
        try {
          await workspaces.use(id, async (ws) => {
            const g = ws.googleConnection.status();
            if (g.connected || g.needsReconnect) await ws.googleConnection.disconnect(g.version).catch(() => {});
          });
          workspaces.remove(id);
        } catch (err) {
          if (err instanceof WorkspaceBusyError) return send(res, 409, { error: "account_busy", message: DELETE_ACCOUNT_BUSY_TEXT }), true;
          throw err;
        }
        store.deleteAccount(id);
        res.setHeader("Set-Cookie", sessionCookie(port, secure, "", 0));
        send(res, 200, { deleted: true });
        return true;
      }
    }
    return false;
  }

  // The routes a hosted workspace does not offer, or answers its own way.
  async function hostedOnly(ws: Workspace, req: IncomingMessage, res: ServerResponse, path: string, input: { body: unknown; generation: number | undefined }): Promise<boolean> {
    const method = req.method ?? "GET";
    if (path === "/api/auth/meta-key") {
      send(res, 403, { error: "not_offered", message: NOT_OFFERED_TEXT });
      return true;
    }
    if (path === "/api/auth/chatgpt/start" || (path === "/api/settings/provider" && method === "PUT" && (input.body as { provider?: unknown } | null)?.provider === "chatgpt")) {
      send(res, 422, { error: "chatgpt_unavailable", message: CHATGPT_HOSTED_REFUSED_TEXT });
      return true;
    }
    if (path === "/api/settings" && method === "GET") {
      const r = await ws.api({ method, path, body: undefined });
      if (r.status !== 200) return send(res, r.status, r.body), true;
      const view = r.body as { models: Array<{ id: string }> } & Record<string, unknown>;
      send(res, 200, {
        ...view,
        hosted: { chatgptAvailable: false, chatgptText: CHATGPT_HOSTED_TEXT },
        models: view.models.map((m) => ({ ...m, turnCost: turnCostWords(m.id, config.markupHundredths) })),
      });
      return true;
    }
    return false;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Refuse requests addressed to any other host name.
    if (!hostAllowed(allowed, req.headers.host)) return send(res, 403, { error: "forbidden_host" });
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const secure = secureRequest(req);
    const redirect = (location: string, setCookie?: string[]) => {
      res.writeHead(303, { ...API_SECURITY_HEADERS, Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(setCookie ? { "Set-Cookie": setCookie } : {}) });
      res.end();
    };
    try {
      if (url.pathname === SIGNIN_CALLBACK_PATH) {
        if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
        const q = url.searchParams;
        const clear = [signinCookie(port, true, "", 0), signinCookie(port, false, "", 0)];
        try {
          const who = await signIn.finish({ state: q.get("state"), code: q.get("code"), error: q.get("error"), cookie: cookieOf(req.headers.cookie, signinCookieName(port, secure)) });
          const account = store.googleAccount(who);
          const old = cookieOf(req.headers.cookie, sessionCookieName(port, secure));
          if (old) store.endSession(old);
          const { token } = store.createSession(account.id);
          return redirect("/?signedIn=google", [...clear, sessionCookie(port, secure, token, Math.floor(SESSION_TTL_MS / 1000))]);
        } catch (err) {
          const code = err instanceof OAuthError ? err.code : "server_error";
          log(`Sign in with Google failed: ${code}.`);
          return redirect(`/?signInError=${encodeURIComponent(code)}`, clear);
        }
      }
      if (url.pathname === GOOGLE_CALLBACK_PATH) {
        if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
        // The Gmail and Calendar connection, in the signed-in account's own
        // workspace. The flow it finishes lives there, so a callback in
        // another account's session finds no flow and is refused.
        const { session } = sessionOf(req, secure);
        if (!session) return redirect("/?google_error=signed_out");
        const { location, setCookie } = await workspaces.use(session.account.id, (ws) => ws.googleRoutes.callback(url, req.headers.cookie));
        return redirect(location, setCookie);
      }
      if (url.pathname === CALLBACK_PATH) return redirect("/?signInError=chatgpt_not_available_here");
      if (!url.pathname.startsWith("/api/")) return o.ui(req, res);
      const input = await apiPreamble(req, res, allowed.origins);
      if (!input) return;
      if (await accountRoute(req, res, url.pathname, input.body, secure)) return;
      const { session } = sessionOf(req, secure);
      if (!session) return send(res, 401, { error: "signed_out", message: SIGNED_OUT_TEXT });
      const accountId = session.account.id;
      await workspaces.use(accountId, async (ws) => {
        if (await hostedOnly(ws, req, res, url.pathname, input)) return;
        await withUsageScope({ route: routeOf(url.pathname), turn: null }, () =>
          serveApi(ws, { method: req.method ?? "GET", path: url.pathname, body: input.body, generation: input.generation, host: req.headers.host, secure }, res),
        );
      });
    } catch (err) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (err instanceof AccountsBusyError) return send(res, 503, { error: "accounts_busy", retryable: true, message: ACCOUNT_BUSY_TEXT });
      if (err instanceof AccountsFileError) log(err.message);
      send(res, 500, { error: "server_error", message: "The server could not complete the request." });
    }
  }

  return {
    handle,
    store,
    workspaces,
    startLines(): string[] {
      const lines = [
        `Usage credits at ${config.markupHundredths / 100} times model cost. Daily model cost cap ${formatUsd(config.dailyCapMicros)}. Judge codes total cap ${formatUsd(config.judgeTotalCapMicros)}.`,
        serverKey ? "The server key is on, reached only through usage credits." : "The server key is off or not set, so every assistant step is refused with a plain message.",
      ];
      if (extraHosts.length > 0) lines.push(`Also answers to: ${extraHosts.join(", ")}`);
      if (o.googleClient) {
        lines.push(`Sign in with Google redirect URIs: ${signinRedirectUris(port, extraHosts).join(" ")}`);
        lines.push(`Gmail and Calendar redirect URIs: ${googleRedirectUris(port, extraHosts).join(" ")}`);
      } else {
        lines.push("No Google client is set, so only judge codes can sign in.");
      }
      return lines;
    },
    close(): void {
      clearInterval(timer);
      workspaces.closeAll();
      store.close();
    },
  };
}
