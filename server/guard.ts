// Request checks for the local HTTP API (0009, J3). The server binds
// 127.0.0.1 and answers only to its own host names (hosts.ts), so it is
// reachable from this computer and, through a private proxy, from the
// owner's Tailscale devices. There is no pairing code or session: a
// process that runs as the same OS user can open the database file
// anyway. Every request that changes state must come from the app's own
// page: a browser sends Sec-Fetch-Site: same-origin, or an Origin equal to
// the app's origin, and the page sends X-Appointments-App: 1. That keeps a
// page on another site from writing through the browser (CSRF).

export const APP_HEADER = "x-appointments-app";

export type RequestSource = { method: string; secFetchSite?: string; origin?: string; appHeader?: string };

// Why a request may not change state, or null when it may. GET and HEAD
// only read.
export function requestSourceProblem(req: RequestSource, appOrigins: readonly string[]): string | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const sameSite = req.secFetchSite === "same-origin" || (req.origin !== undefined && appOrigins.includes(req.origin));
  if (!sameSite) return "This request did not come from the app's own page: its Sec-Fetch-Site or Origin header is not the app's. Nothing was saved.";
  if (req.appHeader !== "1") return "This request does not carry the app's request header. Nothing was saved.";
  return null;
}
