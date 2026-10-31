// Hosted mode on the page (0014, design item 6): who is signed in, the
// usage page's data, and the account routes. In local mode GET
// /api/session answers { mode: "local" } and none of this shows. The
// account routes need no case generation, so they send the app header
// only. A judge code goes to the server once and is never kept.
//
// 0020: email and password, and passkeys, go to Better Auth at
// /api/auth/*. Its session lives in an HttpOnly cookie the page never
// reads, and no answer the page gets holds its token. A password goes to
// the server once and is never kept.
import { ApiError } from "../api.ts";

// "google" is an account from before 0020. It can no longer sign in.
// `owner`: an opaque key of the app account, the same for every session of
// it, for the page's per-account caches (sprint 19 round 2). Not a secret.
// `pool`: a judge account made by a shared judge pass (0023). Its
// workspace is reached only through this browser's session.
export type HostedAccount = { kind: "user" | "judge" | "google"; email: string | null; name: string | null; owner?: string; pool?: boolean };

export type SessionInfo =
  | { mode: "local" }
  | { mode: "hosted"; signedIn: false; passwordMin: number; dashboard?: boolean; publicSignup?: boolean; waitlistUrl?: string | null }
  | { mode: "hosted"; signedIn: true; account: HostedAccount; balanceMicros: number; balance: string; expiresAt: number; passwordMin: number; dashboard?: boolean; publicSignup?: boolean; waitlistUrl?: string | null };

export type SignedInSession = Extract<SessionInfo, { signedIn: true }>;

export type UsageLine = { at: number; what: string; model: string; modelLabel: string; costMicros: number; cost: string; calls: number };

export type UsageView = {
  balanceMicros: number;
  balance: string;
  markup: string;
  charges: UsageLine[];
  plans: Array<{ id: string; usd: number; label: string; available: boolean }>;
  models: Array<{ id: string; label: string; turnCost: string | null }>;
  prices: Array<{ model: string; inputPerMillion: string; cachedInputPerMillion: string; outputPerMillion: string }>;
  canAddCode: boolean;
};

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Appointments-App": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = {};
  try {
    json = await res.json();
  } catch {
    // Not JSON. The status says enough.
  }
  if (!res.ok) throw new ApiError(res.status, json as ApiError["body"]);
  return json as T;
}

export const hostedApi = {
  // A server without the route is a local app from before sprint 13.
  session: async (): Promise<SessionInfo> => {
    try {
      return await call<SessionInfo>("GET", "/api/session");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return { mode: "local" };
      throw e;
    }
  },
  judgeSignIn: (code: string, key?: string) => call<SessionInfo>("POST", "/api/session/judge", key ? { code, key } : { code }),
  signOut: () => call<SessionInfo>("POST", "/api/session/signout", {}),
  usage: () => call<UsageView>("GET", "/api/usage"),
  addJudgeCode: (code: string) => call<UsageView>("POST", "/api/account/judge-code", { code }),
  deleteAccount: (confirmation: string) => call<{ deleted: true }>("POST", "/api/account/delete", { confirmation }),
};

// The request was refused because the session ended. The page shows the
// sign-in screen again.
export const signedOut = (e: unknown) => e instanceof ApiError && e.status === 401 && e.body.error === "signed_out";

// 0023, fix round 1: the key this browser sends with a judge code, so a
// retried or doubled sign-in with a shared pass opens the account the first
// one made. 32 random bytes in base64url. Without storage, one key for this
// page. Fix round 2: the key lasts only while this browser holds that
// account's session. Sign-out, Delete account, an email or passkey sign-in,
// and a judge sign-in that ends in another account forget it, and the next
// sign-in makes a new one. The server forgets it at the same steps.
export const SIGNIN_KEY_STORAGE = "kept.judge-signin-key";
export const SIGNIN_OWNER_STORAGE = "kept.judge-signin-owner";
const SIGNIN_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
let pageKey: string | null = null;
export function judgeSigninKey(): string {
  try {
    const kept = window.localStorage.getItem(SIGNIN_KEY_STORAGE);
    if (kept && SIGNIN_KEY_SHAPE.test(kept)) return kept;
  } catch {
    // No storage: the page's own key below.
  }
  if (pageKey === null) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    pageKey = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  try {
    window.localStorage.setItem(SIGNIN_KEY_STORAGE, pageKey);
  } catch {
    // Kept for this page only.
  }
  return pageKey;
}

export function forgetJudgeSigninKey(): void {
  pageKey = null;
  try {
    window.localStorage.removeItem(SIGNIN_KEY_STORAGE);
    window.localStorage.removeItem(SIGNIN_OWNER_STORAGE);
  } catch {
    // Nothing kept.
  }
}

// After a judge code sign-in: the key stays only for the shared pass's
// account it opened first. Any other account forgets it.
export function noteJudgeSignIn(s: SessionInfo): void {
  const owner = s.mode === "hosted" && s.signedIn && s.account.pool ? (s.account.owner ?? null) : null;
  let kept: string | null = null;
  try {
    kept = window.localStorage.getItem(SIGNIN_OWNER_STORAGE);
  } catch {
    // No storage: the page's key only.
  }
  if (owner === null || (kept !== null && kept !== owner)) return forgetJudgeSigninKey();
  try {
    window.localStorage.setItem(SIGNIN_OWNER_STORAGE, owner);
  } catch {
    // Kept for this page only.
  }
}

// Who the account menu names.
export function accountLabel(a: HostedAccount): string {
  if (a.kind === "judge") return "Judge account";
  return a.name ?? a.email ?? "Your account";
}

// A sign-in that ends on /?signInError=<code>. Only Sign in with ChatGPT
// comes back that way on the hosted site now.
const SIGN_IN_ERRORS: Record<string, string> = {
  chatgpt_not_available_here: "Sign in with ChatGPT is not available on the hosted site yet.",
};

export const hostedSignInError = (code: string) => SIGN_IN_ERRORS[code] ?? "That sign-in did not finish. Nothing changed. Try again.";

// The time of a usage line, in the person's own clock.
export function usageTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
