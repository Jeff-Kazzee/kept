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
  judgeSignIn: (code: string) => call<SessionInfo>("POST", "/api/session/judge", { code }),
  signOut: () => call<SessionInfo>("POST", "/api/session/signout", {}),
  usage: () => call<UsageView>("GET", "/api/usage"),
  addJudgeCode: (code: string) => call<UsageView>("POST", "/api/account/judge-code", { code }),
  deleteAccount: (confirmation: string) => call<{ deleted: true }>("POST", "/api/account/delete", { confirmation }),
};

// The request was refused because the session ended. The page shows the
// sign-in screen again.
export const signedOut = (e: unknown) => e instanceof ApiError && e.status === 401 && e.body.error === "signed_out";

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
