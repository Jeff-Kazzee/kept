// Hosted mode (0014, 0020): the public site. Every person has an account,
// with an email and password (and passkeys) through Better Auth, or a
// judge code, and one workspace of their own. The server's Meta key is
// reached only through usage credits, and Sign in with ChatGPT shows as
// not available here yet (J14).
//
// Every request goes through the same host allowlist. /api/auth/* is
// Better Auth's (auth.ts): it checks the request's origin against the
// public origin itself, and the app adds a body limit, per-address limits
// on sign-in and sign-up, and the visitor's address from its own proxy
// rules. Every other /api request goes through the same source, content
// type and body checks as in local mode (http.ts). Then:
//
//   GET  /api/session              who is signed in, and the balance
//   POST /api/session/judge        { code } signs in with a judge code.
//                                  Rate-limited per address.
//   POST /api/session/signout      { } ends the session, of either kind
//   GET  /api/usage                balance, recent charges, plans, prices
//   POST /api/account/judge-code   { code } adds a judge code's credit to
//                                  the signed-in email account
//   POST /api/account/delete       { confirmation: "DELETE" }
//
// Every other /api route needs a session, and runs in that session's
// account's workspace only. A person's own Meta key and ChatGPT sign-in
// are refused here. Codes, passwords and session tokens never reach a log
// line or a JSON answer.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { DELETE_CONFIRMATION } from "../src/case/constants.ts";
import { toNodeHandler } from "better-auth/node";
import type { FetchLike } from "../src/google/http.ts";
import type { OAuthClient } from "../src/google/oauth.ts";
import { AUTH_BASE_PATH, CLIENT_ADDRESS_HEADER, PASSWORD_MIN, authPath, createAuth, type AuthConfig } from "../src/hosted/auth.ts";
import { formatBalance, formatCharge, formatUsd, type HostedConfig } from "../src/hosted/config.ts";
import { MeteredClient } from "../src/hosted/metered.ts";
import { PRICES, turnCostMicros } from "../src/hosted/prices.ts";
import { AddressLimiter, clientAddress } from "../src/hosted/rate-limit.ts";
import { AccountsBusyError, AccountsFileError, AccountsStore, JudgeCodeError, SESSION_TTL_MS, accountsPath, workspacesRoot, type Account, type ChargeRow } from "../src/hosted/store.ts";
import { META_MODELS, metaModel } from "../src/model/providers/models.ts";
import { UsageRefusedError, withUsageScope } from "../src/model/usage.ts";
import { CALLBACK_PATH } from "./auth.ts";
import { GOOGLE_CALLBACK_PATH, googleRedirectUris } from "./google.ts";
import { appHosts, hostAllowed } from "./hosts.ts";
import { apiPreamble, trustedSecure } from "./http.ts";
import { API_SECURITY_HEADERS } from "./static.ts";
import { CHATGPT_HOSTED_TEXT, MAX_BODY, createWorkspace, send, serveApi, type Workspace } from "./workspace.ts";
import { WorkspaceBusyError, Workspaces, WorkspacesFullError } from "./workspaces.ts";

export type HostedOptions = {
  config: HostedConfig;
  auth: AuthConfig;
  port: number;
  extraHosts: string[];
  googleClient: OAuthClient | null;
  serverMetaKey: string | null;
  ui: (req: IncomingMessage, res: ServerResponse) => void;
  logRejected?: boolean;
  // For tests.
  accountsFile?: string;
  authFile?: string;
  workspacesDir?: string;
  googleFetch?: FetchLike;
  metaUrl?: string;
  now?: () => number;
  // The workspace cache's size (workspaces.ts, MAX_OPEN).
  maxWorkspaces?: number;
  log?: (line: string) => void;
};

export const SIGNED_OUT_TEXT = "Sign in to use the assistant. Nothing was saved.";
export const NOT_OFFERED_TEXT = "On the hosted site the assistant uses usage credits, not your own key. Run the app on your own computer to use your own Meta key. Nothing was saved.";
export const CHATGPT_HOSTED_REFUSED_TEXT = "Sign in with ChatGPT is not available on the hosted site yet. It works when you run the app on your own computer. Nothing was changed.";
export const RATE_LIMITED_TEXT = "Too many tries from this address. Wait a few minutes and try again.";
export const AUTH_BODY_TEXT = "That request was too large, or did not say its size. Nothing was saved.";
export const ACCOUNT_BUSY_TEXT = "The accounts database is busy just now. Try again in a moment. Nothing was changed.";
export const SITE_BUSY_TEXT = "This site is busy just now. Try again in a minute. Nothing was saved.";
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

// The plans, shown as coming soon. Billing waits until after the
// hackathon (J18), so there is no payment code.
export const PLANS = [
  { id: "credit-20", usd: 20, label: "$20 of usage" },
  { id: "credit-100", usd: 100, label: "$100 of usage" },
];

const JudgeBody = z.object({ code: z.string().max(200) }).strict();
const EmptyBody = z.object({}).strict();
const DeleteBody = z.object({ confirmation: z.string().max(20) }).strict();

// The judge code session's cookie. Email accounts use Better Auth's.
export const sessionCookieName = (port: number, secure: boolean) => (secure ? "__Host-appt_session" : `appt_session_${port}`);

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

// Better Auth answers every path under /api/auth (the path Jeff set in
// its dashboard), but the app's own provider routes there, a person's
// Meta key and Sign in with ChatGPT, stay the app's: hosted mode refuses
// them with its own sentences (hostedOnly).
export const isBetterAuthPath = (p: string) =>
  (p === AUTH_BASE_PATH || p.startsWith(`${AUTH_BASE_PATH}/`)) && p !== `${AUTH_BASE_PATH}/meta-key` && p !== `${AUTH_BASE_PATH}/chatgpt` && !p.startsWith(`${AUTH_BASE_PATH}/chatgpt/`);

// One line per turn: a chat turn's calls together, every other call on
// its own. Charges come newest first.
export type UsageLine = { at: number; what: string; model: string; modelLabel: string; costMicros: number; cost: string; calls: number };

export function usageLines(charges: ChargeRow[]): UsageLine[] {
  const lines: Array<UsageLine & { turn: string | null }> = [];
  for (const c of charges) {
    const last = lines.at(-1);
    if (c.turn && last && last.turn === c.turn) {
      last.costMicros += c.amountMicros;
      last.cost = formatCharge(last.costMicros);
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
      cost: formatCharge(c.amountMicros),
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

export async function createHostedApp(o: HostedOptions) {
  const log = o.log ?? ((line: string) => console.error(line));
  const { config, port, extraHosts } = o;
  const now = o.now ?? Date.now;
  // The public origin's host, with its port when it has one, such as
  // name.ts.net:10000, is always allowed (0020, B11).
  const local = o.auth.rpId === "localhost";
  const allowed = appHosts(port, local || extraHosts.includes(o.auth.host) ? extraHosts : [...extraHosts, o.auth.host]);
  const store = new AccountsStore(o.accountsFile ?? accountsPath(), { now });
  // 0020: per address, on top of Better Auth's own limits. A sign-in try
  // is a password or a passkey. Sign-ups are fewer.
  const signinLimit = new AddressLimiter({ limit: 20, windowMs: 10 * 60_000, now });
  const signupLimit = new AddressLimiter({ limit: 10, windowMs: 60 * 60_000, now });
  const judgeLimit = new AddressLimiter({ limit: 10, windowMs: 15 * 60_000, now });
  const serverKey = config.serverKeyOn ? o.serverMetaKey : null;

  // A refusal before a turn starts, so a person with no credit has
  // nothing saved (agent.ts, admit).
  const admit = (accountId: string) => () => {
    if (serverKey === null) throw new UsageRefusedError("server_key_off");
    if (config.dailyCapMicros === null) throw new UsageRefusedError("server_key_off");
    if (store.dayCost() >= config.dailyCapMicros) throw new UsageRefusedError("daily_cap");
    if (store.balance(accountId) <= 0) throw new UsageRefusedError("credits_exhausted");
  };

  const workspaces = new Workspaces({
    root: o.workspacesDir ?? workspacesRoot(),
    now,
    ...(o.maxWorkspaces ? { max: o.maxWorkspaces } : {}),
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

  // Removes an account's workspace and closes the account. Throws
  // WorkspaceBusyError while a request runs in it, before anything
  // changes (review round 1, finding 3). Only then is the Google grant
  // revoked.
  const removeAccount = async (id: string) => {
    const claim = workspaces.claim(id);
    try {
      const g = claim.ws.googleConnection.status();
      if (g.connected || g.needsReconnect) await claim.ws.googleConnection.disconnect(g.version).catch(() => {});
      claim.remove();
    } finally {
      claim.release();
    }
    store.deleteAccount(id);
  };

  const auth = await createAuth({
    config: o.auth,
    file: o.authFile ?? authPath(),
    port,
    log,
    // A user deleted outside Delete account, such as from Better Auth's
    // dashboard: the app's account goes too. A busy workspace is closed
    // later by hand, and the account is closed at once either way.
    onUserDeleted: (userId) => {
      const account = store.accountOfUser(userId);
      if (!account) return;
      removeAccount(account.id).catch((err) => {
        if (err instanceof WorkspaceBusyError) {
          store.deleteAccount(account.id);
          log("A deleted user's workspace was busy, so its files stay until the account folder is removed by hand.");
        } else log("A deleted user's account could not be closed.");
      });
    },
  });
  const authHandler = toNodeHandler(auth.auth);

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

  // `dashboard` lets the sign-in page say that sign-in events also go to
  // Better Auth's dashboard (B7).
  const signedOutView = () => ({ mode: "hosted" as const, signedIn: false, passwordMin: PASSWORD_MIN, dashboard: auth.dashboardOn });

  const accountView = (account: Account, expiresAt: number) => {
    const balance = store.balance(account.id);
    return {
      mode: "hosted" as const,
      signedIn: true,
      account: { kind: account.kind, email: account.email, name: account.name },
      balanceMicros: balance,
      balance: formatBalance(balance),
      expiresAt,
      passwordMin: PASSWORD_MIN,
      dashboard: auth.dashboardOn,
    };
  };

  const usageView = (account: Account) => {
    const balance = store.balance(account.id);
    return {
      balanceMicros: balance,
      balance: formatBalance(balance),
      markup: (config.markupHundredths / 100).toString(),
      charges: usageLines(store.charges(account.id, 100)).slice(0, 30),
      plans: PLANS.map((p) => ({ ...p, available: false })),
      models: META_MODELS.map((m) => ({ id: m.id, label: m.label, turnCost: turnCostWords(m.id, config.markupHundredths) })),
      prices: PRICES.map((p) => ({ model: p.model, inputPerMillion: formatUsd(p.input), cachedInputPerMillion: formatUsd(p.cachedInput), outputPerMillion: formatUsd(p.output) })),
      canAddCode: account.kind !== "judge",
    };
  };

  const headersOf = (req: IncomingMessage) => {
    const h = new Headers();
    const cookie = req.headers.cookie;
    if (typeof cookie === "string") h.set("cookie", cookie);
    return h;
  };

  type Who = { account: Account; expiresAt: number; authUser: string | null };

  // The request's session (0020, B5 and B6). A Better Auth session comes
  // first, and its user's account is made the first time it is seen. Then
  // a judge code session, in both cookie forms, the __Host- one first
  // (final review, finding 3), so no claimed scheme hides or picks one.
  // A cookie Better Auth refreshed is set on the answer.
  const sessionOf = async (req: IncomingMessage, res: ServerResponse | null): Promise<Who | null> => {
    const ba = await auth.session(headersOf(req));
    if (ba) {
      if (res) for (const c of ba.setCookie) res.appendHeader("Set-Cookie", c);
      const account = store.userAccount({ userId: ba.user.id, email: ba.user.email, name: ba.user.name });
      return { account, expiresAt: ba.expiresAt, authUser: ba.user.id };
    }
    for (const secureForm of [true, false]) {
      const session = store.session(cookieOf(req.headers.cookie, sessionCookieName(port, secureForm)));
      if (session) return { ...session, authUser: null };
    }
    return null;
  };

  // Review round 1, finding 6: sign-in and sign-out never trust the
  // request's claim of HTTPS to pick a cookie. They end the judge session
  // of either cookie form the browser sent, and clear both forms, and end
  // the Better Auth session too.
  const endJudge = (req: IncomingMessage) => {
    for (const secureForm of [true, false]) {
      const t = cookieOf(req.headers.cookie, sessionCookieName(port, secureForm));
      if (t) store.endSession(t);
    }
  };
  const clearJudge = () => [sessionCookie(port, true, "", 0), sessionCookie(port, false, "", 0)];
  const endAll = async (req: IncomingMessage, res: ServerResponse) => {
    endJudge(req);
    const cleared = req.headers.cookie?.includes(auth.sessionCookieName) ? await auth.signOut(headersOf(req)) : [];
    for (const c of [...clearJudge(), ...cleared]) res.appendHeader("Set-Cookie", c);
  };

  const startJudgeSession = async (req: IncomingMessage, res: ServerResponse, secure: boolean, account: Account) => {
    await endAll(req, res);
    const { token } = store.createSession(account.id);
    res.appendHeader("Set-Cookie", sessionCookie(port, secure, token, Math.floor(SESSION_TTL_MS / 1000)));
  };

  const judgeFailure = (err: JudgeCodeError) => ({ status: err.code === "not_found" ? 404 : 409, body: { error: `judge_${err.code}`, message: err.message } });

  // Better Auth's routes. The app adds what Better Auth leaves to the
  // server: the API security headers, a bounded body with a stated size,
  // the visitor's address from the trusted proxy, and per-address limits
  // on sign-in and sign-up. Better Auth checks the origin itself.
  async function authRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) res.setHeader(name, value);
    res.setHeader("Cache-Control", "no-store");
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const stated = req.headers["content-length"];
      if (req.headers["transfer-encoding"] !== undefined || stated === undefined || !/^\d{1,9}$/.test(stated) || Number(stated) > MAX_BODY) {
        return send(res, 413, { error: "body_refused", message: AUTH_BODY_TEXT });
      }
    }
    const address = clientAddress(req.headers, req.socket.remoteAddress, config.trustedProxy);
    // Only the app says who the visitor is. The dashboard's visitor
    // headers are dropped, so nothing a client sends makes Better Auth
    // call out.
    for (const h of [CLIENT_ADDRESS_HEADER, "x-request-id", "x-visitor-id", "x-forwarded-for", "cf-connecting-ip", "true-client-ip"]) delete req.headers[h];
    req.headers[CLIENT_ADDRESS_HEADER] = address;
    if (method === "POST") {
      const sub = path.slice(AUTH_BASE_PATH.length);
      const limiter = sub.startsWith("/sign-up") ? signupLimit : sub.startsWith("/sign-in") || sub === "/passkey/verify-authentication" ? signinLimit : null;
      const limit = limiter?.take(address);
      if (limit && !limit.ok) return send(res, 429, { error: "rate_limited", message: RATE_LIMITED_TEXT, retryAfterSeconds: limit.retryAfterSeconds });
    }
    await authHandler(req, res);
  }

  // The account routes. False for any other path.
  async function accountRoute(req: IncomingMessage, res: ServerResponse, path: string, body: unknown, secure: boolean): Promise<boolean> {
    const method = req.method ?? "GET";
    const address = clientAddress(req.headers, req.socket.remoteAddress, config.trustedProxy);
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
      case "/api/session": {
        if (!only("GET")) return true;
        const who = await sessionOf(req, res);
        send(res, 200, who ? accountView(who.account, who.expiresAt) : signedOutView());
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
          await startJudgeSession(req, res, secure, account);
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
        await endAll(req, res);
        send(res, 200, signedOutView());
        return true;
      case "/api/usage": {
        if (!only("GET")) return true;
        const who = await sessionOf(req, res);
        if (!who) return send(res, 401, { error: "signed_out", message: SIGNED_OUT_TEXT }), true;
        send(res, 200, usageView(who.account));
        return true;
      }
      case "/api/account/judge-code": {
        if (!only("POST")) return true;
        const who = await sessionOf(req, res);
        if (!who) return send(res, 401, { error: "signed_out", message: SIGNED_OUT_TEXT }), true;
        const b = parsed(JudgeBody, body);
        if (!b) return true;
        const limit = judgeLimit.take(address);
        if (!limit.ok) return send(res, 429, { error: "rate_limited", message: RATE_LIMITED_TEXT, retryAfterSeconds: limit.retryAfterSeconds }), true;
        try {
          store.redeemJudgeCode(b.code.trim(), who.account.id);
          send(res, 200, usageView(who.account));
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
        const who = await sessionOf(req, res);
        if (!who) return send(res, 401, { error: "signed_out", message: SIGNED_OUT_TEXT }), true;
        const b = parsed(DeleteBody, body);
        if (!b) return true;
        if (b.confirmation !== DELETE_CONFIRMATION) {
          send(res, 422, { error: "confirmation_mismatch", message: `Type ${DELETE_CONFIRMATION} to delete your account. Nothing was deleted.` });
          return true;
        }
        try {
          await removeAccount(who.account.id);
        } catch (err) {
          if (err instanceof WorkspaceBusyError) return send(res, 409, { error: "account_busy", message: DELETE_ACCOUNT_BUSY_TEXT }), true;
          throw err;
        }
        // The Better Auth user goes last, with its password, passkeys and
        // every session. Its delete hook finds no account left to close.
        if (who.authUser) await auth.deleteUser(who.authUser);
        endJudge(req);
        for (const c of [...clearJudge(), auth.clearCookie()]) res.appendHeader("Set-Cookie", c);
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
    const secure = trustedSecure(req);
    const redirect = (location: string, setCookie?: string[]) => {
      res.writeHead(303, { ...API_SECURITY_HEADERS, Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(setCookie ? { "Set-Cookie": setCookie } : {}) });
      res.end();
    };
    try {
      if (isBetterAuthPath(url.pathname)) return await authRoute(req, res, url.pathname);
      if (url.pathname === GOOGLE_CALLBACK_PATH) {
        if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
        // The Gmail and Calendar connection, in the signed-in account's own
        // workspace. The flow it finishes lives there, so a callback in
        // another account's session finds no flow and is refused.
        const who = await sessionOf(req, null);
        if (!who) return redirect("/?google_error=signed_out");
        const { location, setCookie } = await workspaces.use(who.account.id, (ws) => ws.googleRoutes.callback(url, req.headers.cookie));
        return redirect(location, setCookie);
      }
      if (url.pathname === CALLBACK_PATH) return redirect("/?signInError=chatgpt_not_available_here");
      if (!url.pathname.startsWith("/api/")) return o.ui(req, res);
      const input = await apiPreamble(req, res, allowed.origins);
      if (!input) return;
      if (await accountRoute(req, res, url.pathname, input.body, secure)) return;
      const who = await sessionOf(req, res);
      if (!who) return send(res, 401, { error: "signed_out", message: SIGNED_OUT_TEXT });
      const accountId = who.account.id;
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
      // Every open workspace is working (final review, finding 2).
      if (err instanceof WorkspacesFullError) return send(res, 503, { error: "site_busy", retryable: true, message: SITE_BUSY_TEXT });
      // The account is being deleted.
      if (err instanceof WorkspaceBusyError) return send(res, 409, { error: "account_busy", message: DELETE_ACCOUNT_BUSY_TEXT });
      if (err instanceof AccountsFileError) log(err.message);
      send(res, 500, { error: "server_error", message: "The server could not complete the request." });
    }
  }

  return {
    handle,
    store,
    auth,
    workspaces,
    startLines(): string[] {
      const cap = (v: number | null) => (v === null ? "not set" : formatUsd(v));
      const lines = [
        `Usage credits at ${config.markupHundredths / 100} times model cost. Daily model cost cap ${cap(config.dailyCapMicros)}. Judge codes total cap ${cap(config.judgeTotalCapMicros)}.`,
        // J19: no cap has a default.
        ...config.missing.map((name) => `${name} is not set, so the server key is off. Set it to turn the server key on.`),
        serverKey ? "The server key is on, reached only through usage credits." : "The server key is off or not set, so every assistant step is refused with a plain message.",
      ];
      if (extraHosts.length > 0) lines.push(`Also answers to: ${extraHosts.join(", ")}`);
      // Never the secret or the key.
      lines.push(`Accounts sign in with an email and password, a passkey or a judge code, through Better Auth at ${o.auth.origin}${AUTH_BASE_PATH}.`);
      lines.push(auth.dashboardOn ? "The Better Auth dashboard plugin is on: sign-in events go to Better Auth's dashboard (docs/hosted.md)." : "The Better Auth dashboard plugin is off. Set BETTER_AUTH_API_KEY to turn it on.");
      if (o.googleClient) lines.push(`Gmail and Calendar redirect URIs, for test accounts: ${googleRedirectUris(port, extraHosts).join(" ")}`);
      return lines;
    },
    close(): void {
      clearInterval(timer);
      workspaces.closeAll();
      store.close();
      auth.close();
    },
  };
}
