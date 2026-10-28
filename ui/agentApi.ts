// The routes of the agent-first contract (ui/contract.ts): settings, the
// time zone, the model provider and model (sprint 10), sign-in, activity
// and undo. Every write
// carries the app header and the case generation, like every other write
// (api.ts). A route the server does not have yet answers 404, and the page
// says the part is not available in this build.
import { ApiError, request } from "./api.ts";
import type { ActivityLog, GoogleStatus, Provider, Settings } from "./contract.ts";

export type AgentBackend = {
  kind: "real" | "fake";
  // Null when this build has no settings route yet.
  settings(): Promise<Settings | null>;
  // `from` says the browser sent its own zone on first load. The route
  // then records it as the browser's (0009, contract, `source`).
  setTimezone(timezone: string, expectedVersion: number, from?: "browser" | "you"): Promise<unknown>;
  setProvider(provider: Provider, expectedVersion: number): Promise<unknown>;
  setModel(model: string, expectedVersion: number): Promise<unknown>;
  // The key goes to the server once. The page never keeps or reads it back.
  // Every change states the settings version it was shown at.
  saveMetaKey(key: string, expectedVersion: number): Promise<unknown>;
  removeMetaKey(expectedVersion: number): Promise<unknown>;
  chatgptStart(): Promise<{ authorizeUrl: string }>;
  // Answers the settings and, when ChatGPT did not confirm, a notice.
  chatgptSignOut(expectedVersion: number): Promise<{ notice?: string | null } | unknown>;
  // Null when this build has no activity route yet.
  activity(): Promise<ActivityLog | null>;
  undo(id: string, expectedVersion: number): Promise<unknown>;
  // Null when this build has no Google route yet.
  google(): Promise<GoogleStatus | null>;
  googleConnect(): Promise<{ authorizeUrl: string }>;
  // States the Google connection version it was shown at.
  googleDisconnect(expectedVersion: number): Promise<unknown>;
};

const missing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405);

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

// A settings or sign-in write that met another window holding the
// settings (503 settings_busy, retryable) is tried once more, after a short
// wait. Nothing was written the first time (0010).
export async function retryBusy<T>(write: () => Promise<T>, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 503 && e.body.retryable === true)) throw e;
    await wait(400);
    return write();
  }
}

// What the sign-out answers: the settings, and a notice when ChatGPT did
// not confirm the sign-out on its side.
export type SignOutAnswer = Settings & { notice: string | null };

export const realBackend: AgentBackend = {
  kind: "real",
  settings: async () => {
    const raw = await orNull(() => request<Settings>("GET", "/api/settings"));
    return raw ? { ...raw, modelNotice: raw.modelNotice ?? null } : null;
  },
  setTimezone: (timezone, expectedVersion, from) =>
    retryBusy(() => request("PUT", "/api/settings/timezone", { timezone, expectedVersion, ...(from === "browser" ? { source: "browser" } : {}) })),
  setProvider: (provider, expectedVersion) => retryBusy(() => request("PUT", "/api/settings/provider", { provider, expectedVersion })),
  setModel: (model, expectedVersion) => retryBusy(() => request("PUT", "/api/settings/model", { model, expectedVersion })),
  saveMetaKey: (key, expectedVersion) => retryBusy(() => request("POST", "/api/auth/meta-key", { key, expectedVersion })),
  removeMetaKey: (expectedVersion) => retryBusy(() => request("DELETE", "/api/auth/meta-key", { expectedVersion })),
  chatgptStart: () => retryBusy(() => request<{ authorizeUrl: string }>("POST", "/api/auth/chatgpt/start", {})),
  chatgptSignOut: (expectedVersion) => retryBusy(() => request<SignOutAnswer>("POST", "/api/auth/chatgpt/signout", { expectedVersion })),
  activity: () => orNull(() => request<ActivityLog>("GET", "/api/activity")),
  undo: (id, expectedVersion) => request("POST", `/api/activity/${encodeURIComponent(id)}/undo`, { expectedVersion }),
  google: () => orNull(() => request<GoogleStatus>("GET", "/api/google")),
  googleConnect: () => request<{ authorizeUrl: string }>("POST", "/api/google/connect", {}),
  googleDisconnect: (expectedVersion) => request("POST", "/api/google/disconnect", { expectedVersion }),
};

// Where the sign-in page may send the browser: this app's own origin, or
// an https page. Anything else is refused, so a bad answer cannot open a
// javascript: or data: address.
export function safeAuthorizeUrl(url: string, origin: string): string | null {
  try {
    const u = new URL(url, origin);
    if (u.origin === origin || u.protocol === "https:") return u.href;
    return null;
  } catch {
    return null;
  }
}
