// Hosted accounts through Better Auth (0020): email and password, and
// passkeys, in data/hosted/auth.sqlite on Node's own node:sqlite. Better
// Auth keeps users, password hashes, passkeys and sessions there. The
// app's own accounts store (store.ts) keeps credits, judge codes and each
// account's link to its Better Auth user, and nothing of Better Auth's
// reaches it but that user id.
//
// Settings, read in hosted mode only:
//   BETTER_AUTH_SECRET   signs the session cookie. Required, at least 32
//                        bytes. Never logged or returned.
//   BETTER_AUTH_URL      the site's public origin, such as
//                        https://the-little-ai-co.tail374dd0.ts.net:10000.
//                        Required. It is the only trusted origin, the
//                        passkey origin, and its host name is the passkey
//                        relying party. https, or http on localhost only.
//   BETTER_AUTH_API_KEY  turns the Better Auth dashboard plugin on (B7).
//                        Optional, off without it. Never logged.
//   BETTER_AUTH_API_URL, BETTER_AUTH_KV_URL
//                        the dashboard's addresses, when not Better Auth's
//                        defaults. Optional. Jeff keeps the dashboard off for
//                        the hackathon (0020, K6).
//   APP_PUBLIC_SIGNUP    on lets anyone make an account with an email and
//                        password. off, the default (0020, K7), refuses
//                        sign-up on the server: judges come in with their
//                        codes, and accounts made with `pnpm admin users
//                        create` still sign in.
//   APP_WAITLIST_URL     the waitlist on Kept's marketing page (K9),
//                        linked from the sign-in screen while public
//                        sign-up is off. Optional, https. Unset hides it.
//
// Better Auth's telemetry is off. Its log lines go through `log` with
// every email address cut out and no extra values.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dash } from "@better-auth/infra";
import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { appDbPath } from "../paths.ts";
import { ConfigError } from "./config.ts";
import { checkPrivateFile } from "./db-file.ts";

export const AUTH_FILE_NAME = "auth.sqlite";
export const AUTH_BASE_PATH = "/api/auth";
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export const AUTH_SESSION_DAYS = 30;
// The app writes the visitor's address here, from its own trusted-proxy
// rules, and removes any copy a client sent. Better Auth's rate limits
// read it and nothing else (0020, B2 and B11).
export const CLIENT_ADDRESS_HEADER = "x-appt-client-address";
export const APP_NAME = "Kept";

// data/hosted/auth.sqlite, beside the accounts database.
export function authPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(appDbPath(env)), "hosted", AUTH_FILE_NAME);
}

export class AuthFileError extends Error {
  override name = "AuthFileError";
}

export type AuthConfig = {
  secret: string;
  // The public origin, such as https://name.ts.net:10000.
  origin: string;
  // The Host header the public origin sends: the name, with its port when
  // it is not the scheme's own.
  host: string;
  // The passkey relying party: the origin's host name, without a port.
  rpId: string;
  secure: boolean;
  // K7: false refuses email sign-up on the server.
  publicSignup: boolean;
  // K9: the marketing page's waitlist, linked from the sign-in screen
  // while public sign-up is off. Null hides the line.
  waitlistUrl: string | null;
  dashboard: { apiKey: string; apiUrl: string | null; kvUrl: string | null } | null;
};

const LOCAL_NAMES = new Set(["localhost", "127.0.0.1"]);

function httpsUrl(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an https address.`);
  }
  if (u.protocol !== "https:" || u.username || u.password) throw new ConfigError(`${name} must be an https address.`);
  return u.toString().replace(/\/$/, "");
}

// The Better Auth settings of hosted mode. A missing or bad value stops
// the app. No message holds the secret or the key.
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.trim() === "") throw new ConfigError("BETTER_AUTH_SECRET is not set. Hosted mode needs it to sign sessions. Set it to at least 32 random bytes, such as the output of: openssl rand -base64 32");
  if (Buffer.byteLength(secret, "utf8") < 32) throw new ConfigError("BETTER_AUTH_SECRET is shorter than 32 bytes. Set it to at least 32 random bytes, such as the output of: openssl rand -base64 32");
  const rawUrl = (env.BETTER_AUTH_URL ?? "").trim();
  if (rawUrl === "") throw new ConfigError("BETTER_AUTH_URL is not set. Set it to the site's public origin, such as https://the-little-ai-co.tail374dd0.ts.net:10000.");
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ConfigError(`BETTER_AUTH_URL must be an origin, such as https://name.example:10000. It is "${rawUrl}".`);
  }
  const plain = u.username === "" && u.password === "" && (u.pathname === "/" || u.pathname === "") && u.search === "" && u.hash === "";
  const local = LOCAL_NAMES.has(u.hostname);
  if (!plain || (u.protocol !== "https:" && !(u.protocol === "http:" && local))) {
    throw new ConfigError(`BETTER_AUTH_URL must be an https origin with no path, such as https://name.example:10000 (http only for localhost). It is "${rawUrl}".`);
  }
  if (local && u.hostname === "127.0.0.1") throw new ConfigError("BETTER_AUTH_URL cannot use 127.0.0.1: a passkey needs a host name. Use http://localhost:<port> instead.");
  const apiKey = (env.BETTER_AUTH_API_KEY ?? "").trim();
  const signupRaw = (env.APP_PUBLIC_SIGNUP ?? "").trim().toLowerCase();
  if (signupRaw !== "" && signupRaw !== "on" && signupRaw !== "off") throw new ConfigError(`APP_PUBLIC_SIGNUP must be on or off. It is "${env.APP_PUBLIC_SIGNUP}".`);
  return {
    secret,
    origin: u.origin,
    host: u.host.toLowerCase(),
    rpId: u.hostname.toLowerCase(),
    secure: u.protocol === "https:",
    publicSignup: signupRaw === "on",
    waitlistUrl: httpsUrl(env, "APP_WAITLIST_URL"),
    dashboard: apiKey === "" ? null : { apiKey, apiUrl: httpsUrl(env, "BETTER_AUTH_API_URL"), kvUrl: httpsUrl(env, "BETTER_AUTH_KV_URL") },
  };
}

// The routes the site does not offer: the ones for email it cannot send,
// social sign-in, and the account changes the app makes itself or does
// not have yet. Each answers 404.
export const DISABLED_PATHS = [
  // Fix round 1, item 1: the page signs out through the app's own
  // /api/session/signout, which ends a judge session too.
  "/sign-out",
  "/sign-in/social",
  "/callback/:id",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/account-info",
  "/refresh-token",
  "/get-access-token",
  "/update-user",
  "/delete-user",
  "/delete-user/callback",
  "/change-email",
  "/change-password",
  "/set-password",
  "/verify-password",
  "/verify-email",
  "/send-verification-email",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/:token",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/passkey/update-passkey",
];

// Fix round 1, item 4: the Better Auth routes the site serves. Every other
// path under /api/auth answers 404 before Better Auth sees it, so a route
// a later version or plugin adds is never served by accident. The
// dashboard's routes only while its plugin is on (K6: off).
const AUTH_ROUTES = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/get-session",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
  "/passkey/list-user-passkeys",
  "/passkey/delete-passkey",
]);

export function authRouteServed(subpath: string, dashboardOn: boolean): boolean {
  return AUTH_ROUTES.has(subpath) || (dashboardOn && /^\/dash\/[a-z0-9/-]+$/.test(subpath));
}

const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g;
// A Better Auth log line, with every email address cut out and no extra
// values, which may hold a request's body.
export const authLogLine = (level: string, message: string) => `Better Auth ${level}: ${String(message).replace(EMAIL, "[email]").replace(/\s+/g, " ").slice(0, 300)}`;

// A session token never reaches the page's script: it lives in the
// HttpOnly cookie only (0020, B6). Better Auth's JSON answers carry it for
// bearer clients, which this site does not have.
function withoutTokens(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete out.token;
  if (out.session && typeof out.session === "object") {
    const s = { ...(out.session as Record<string, unknown>) };
    delete s.token;
    out.session = s;
  }
  return out;
}

// Fix round 1, item 5: a DISABLED_PATHS entry with a :param, such as
// /callback/:id, never matches Better Auth's literal disabledPaths check.
// This plugin answers 404 for any path of that shape, before any route.
function disabledPatterns(patterns: string[]) {
  const res = patterns.map((p) => new RegExp(`^${AUTH_BASE_PATH}${p.replace(/:[a-z]+/gi, "[^/]+")}/?$`));
  return {
    id: "appt-disabled-patterns",
    onRequest: async (request: Request) => (res.some((re) => re.test(new URL(request.url).pathname)) ? { response: new Response("Not Found", { status: 404 }) } : undefined),
  };
}

// Better Auth's rate limits, kept per instance, so two apps in one
// process, such as tests, never share counts.
function memoryRateLimit() {
  const counts = new Map<string, { count: number; at: number }>();
  return {
    async consume(key: string, rule: { window: number; max: number }) {
      const now = Date.now();
      if (counts.size > 50_000) for (const [k, v] of counts) if (now - v.at >= 3_600_000) counts.delete(k);
      const e = counts.get(key);
      if (!e || now - e.at >= rule.window * 1000) {
        counts.set(key, { count: 1, at: now });
        return { allowed: true, retryAfter: null };
      }
      if (e.count >= rule.max) return { allowed: false, retryAfter: Math.max(1, Math.ceil((e.at + rule.window * 1000 - now) / 1000)) };
      e.count++;
      return { allowed: true, retryAfter: null };
    },
  };
}

export type AuthUser = { id: string; email: string; name: string | null };
export type AuthSession = { user: AuthUser; expiresAt: number; setCookie: string[] };

export type CreateAuthOptions = {
  config: AuthConfig;
  file: string;
  // Each Better Auth cookie's name carries this, so a hosted app on
  // another port of the same host keeps its own cookies.
  port: number;
  log: (line: string) => void;
  // A Better Auth user was deleted, by Delete account or the dashboard.
  onUserDeleted?: (userId: string) => void;
};

export function authOptions(o: CreateAuthOptions, db: DatabaseSync): BetterAuthOptions {
  const { config } = o;
  return {
    appName: APP_NAME,
    baseURL: config.origin,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database: db,
    trustedOrigins: [config.origin],
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      autoSignIn: true,
      requireEmailVerification: false,
    },
    session: { expiresIn: AUTH_SESSION_DAYS * 86_400, updateAge: 86_400 },
    rateLimit: { enabled: true, window: 60, max: 100, customStorage: memoryRateLimit() as never },
    // Better Auth matches disabledPaths as literal paths, so the entries
    // with a :param are refused by the disabledPatterns plugin below.
    disabledPaths: config.publicSignup ? DISABLED_PATHS : [...DISABLED_PATHS, "/sign-up/email"],
    advanced: {
      // __Secure-appt.session_token over HTTPS. Over plain http on
      // localhost, a name with the port in it.
      cookiePrefix: config.secure ? "appt" : `appt-${o.port}`,
      useSecureCookies: config.secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: config.secure, path: "/" },
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
      // Better Auth turns its origin and CSRF checks off by itself when
      // NODE_ENV is test or TEST is set. They stay on whatever the
      // environment says (0020, B6).
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    logger: {
      level: "warn",
      log: (level, message) => o.log(authLogLine(level, message)),
    },
    databaseHooks: {
      user: {
        delete: {
          after: async (user) => {
            o.onUserDeleted?.(user.id);
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned as unknown;
        // Fix round 1, item 6: a refused sign-up says only that the email
        // cannot be used, not that an account has it.
        if (returned instanceof APIError && /^USER_ALREADY_EXISTS/.test(String((returned.body as { code?: unknown } | undefined)?.code ?? ""))) {
          throw new APIError("UNPROCESSABLE_ENTITY", { code: "EMAIL_UNAVAILABLE", message: "That email cannot be used here." });
        }
        if (!returned || typeof returned !== "object" || returned instanceof Response || returned instanceof Error) return;
        const wrapped = (returned as { _flag?: unknown; body?: unknown })._flag === "json";
        const body = wrapped ? (returned as { body: unknown }).body : returned;
        if (!body || typeof body !== "object" || !("token" in body || ("session" in body && (body as { session?: unknown }).session))) return;
        return ctx.json(withoutTokens(body) as Record<string, unknown>);
      }),
    },
    plugins: [
      disabledPatterns(DISABLED_PATHS.filter((p) => p.includes(":"))),
      passkey({ rpID: config.rpId, rpName: APP_NAME, origin: config.origin }),
      ...(config.dashboard
        ? [
            dash({
              apiKey: config.dashboard.apiKey,
              ...(config.dashboard.apiUrl ? { apiUrl: config.dashboard.apiUrl } : {}),
              ...(config.dashboard.kvUrl ? { kvUrl: config.dashboard.kvUrl } : {}),
            }),
          ]
        : []),
    ],
  };
}

// Opens auth.sqlite with the accounts database's checks, runs Better
// Auth's migrations, and returns the instance.
export async function createAuth(o: CreateAuthOptions) {
  const fail = (m: string) => new AuthFileError(m);
  checkPrivateFile(o.file, "The sign-in database", true, fail);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(o.file, { timeout: 5_000 });
  } catch (err) {
    throw new AuthFileError(`The sign-in database could not be opened (${(err as { code?: string }).code ?? "unknown"}): ${o.file}`);
  }
  try {
    checkPrivateFile(o.file, "The sign-in database", false, fail);
    // Deleting a user deletes its sessions, accounts and passkeys.
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  } catch (err) {
    db.close();
    throw err;
  }
  const options = authOptions(o, db);
  try {
    const { runMigrations } = await getMigrations(options);
    await runMigrations();
  } catch (err) {
    db.close();
    throw new AuthFileError(`The sign-in database could not be brought up to date: ${o.file} (${err instanceof Error ? err.name : "error"})`);
  }
  const auth = betterAuth(options);
  const context = await auth.$context;
  const cookies = context.authCookies;

  return {
    auth,
    db,
    dashboardOn: o.config.dashboard !== null,
    // The session cookie's names, for clearing and for tests.
    sessionCookieName: cookies.sessionToken.name,
    // A request's Better Auth session, or null. Headers Better Auth wants
    // set, such as a refreshed cookie, come back in setCookie.
    async session(headers: Headers): Promise<AuthSession | null> {
      const r = await auth.api.getSession({ headers, returnHeaders: true });
      const value = r.response as { user?: { id?: unknown; email?: unknown; name?: unknown }; session?: { expiresAt?: unknown } } | null;
      if (!value?.user || typeof value.user.id !== "string" || typeof value.user.email !== "string") return null;
      const expiresAt = new Date(value.session?.expiresAt as string | number | Date).getTime();
      return {
        user: { id: value.user.id, email: value.user.email, name: typeof value.user.name === "string" ? value.user.name : null },
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now(),
        setCookie: r.headers.getSetCookie(),
      };
    },
    // Ends the request's Better Auth session, and returns the cookies that
    // clear it.
    async signOut(headers: Headers): Promise<string[]> {
      try {
        const r = await auth.api.signOut({ headers, returnHeaders: true });
        return r.headers.getSetCookie();
      } catch {
        return [this.clearCookie()];
      }
    },
    clearCookie(): string {
      const a = cookies.sessionToken.attributes;
      return `${cookies.sessionToken.name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${a.secure ? "; Secure" : ""}`;
    },
    // Deletes a user and, through the database's foreign keys, its
    // sessions, password and passkeys. The delete hook runs.
    async deleteUser(userId: string): Promise<void> {
      await context.internalAdapter.deleteUser(userId);
    },
    close(): void {
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
