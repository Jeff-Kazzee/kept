// The routes of the agent-first contract (ui/contract.ts): settings, the
// time zone, the model provider, sign-in, activity and undo. Every write
// carries the app header and the case generation, like every other write
// (api.ts). A route the server does not have yet answers 404, and the page
// says the part is not available in this build.
import { ApiError, request } from "./api.ts";
import type { ActivityLog, GoogleStatus, Provider, Settings } from "./contract.ts";

export type AgentBackend = {
  kind: "real" | "fake";
  // Null when this build has no settings route yet.
  settings(): Promise<Settings | null>;
  // `from` says the browser sent its own zone on first load. The real
  // route takes only the zone and the version (see 0011, U12).
  setTimezone(timezone: string, expectedVersion: number, from?: "browser" | "you"): Promise<unknown>;
  setProvider(provider: Provider, expectedVersion: number): Promise<unknown>;
  setModel(model: string, expectedVersion: number): Promise<unknown>;
  // The key goes to the server once. The page never keeps or reads it back.
  saveMetaKey(key: string): Promise<unknown>;
  removeMetaKey(): Promise<unknown>;
  chatgptStart(): Promise<{ authorizeUrl: string }>;
  chatgptSignOut(): Promise<unknown>;
  // Null when this build has no activity route yet.
  activity(): Promise<ActivityLog | null>;
  undo(id: string, expectedVersion: number): Promise<unknown>;
  // Null when this build has no Google route yet.
  google(): Promise<GoogleStatus | null>;
  googleConnect(): Promise<{ authorizeUrl: string }>;
  googleDisconnect(): Promise<unknown>;
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

export const realBackend: AgentBackend = {
  kind: "real",
  settings: () => orNull(() => request<Settings>("GET", "/api/settings")),
  setTimezone: (timezone, expectedVersion) => request("PUT", "/api/settings/timezone", { timezone, expectedVersion }),
  setProvider: (provider, expectedVersion) => request("PUT", "/api/settings/provider", { provider, expectedVersion }),
  setModel: (model, expectedVersion) => request("PUT", "/api/settings/model", { model, expectedVersion }),
  saveMetaKey: (key) => request("POST", "/api/auth/meta-key", { key }),
  removeMetaKey: () => request("DELETE", "/api/auth/meta-key"),
  chatgptStart: () => request<{ authorizeUrl: string }>("POST", "/api/auth/chatgpt/start", {}),
  chatgptSignOut: () => request("POST", "/api/auth/chatgpt/signout", {}),
  activity: () => orNull(() => request<ActivityLog>("GET", "/api/activity")),
  undo: (id, expectedVersion) => request("POST", `/api/activity/${encodeURIComponent(id)}/undo`, { expectedVersion }),
  google: () => orNull(() => request<GoogleStatus>("GET", "/api/google")),
  googleConnect: () => request<{ authorizeUrl: string }>("POST", "/api/google/connect", {}),
  googleDisconnect: () => request("POST", "/api/google/disconnect", {}),
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
