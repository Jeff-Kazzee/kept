// The request checks every /api route runs before it, in local and hosted
// mode alike: the API security headers, the same-origin and app header
// guard (guard.ts), the JSON content type and a bounded body. The host
// allowlist runs first, in the server itself (hosts.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { APP_HEADER, requestSourceProblem } from "./guard.ts";
import { API_SECURITY_HEADERS } from "./static.ts";
import { MAX_BODY, send } from "./workspace.ts";

export function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body_too_large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

export const headerOf = (req: IncomingMessage) => (name: string) => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

// The page reached the app over HTTPS, directly or through a proxy such as
// Tailscale serve or a Cloudflare Tunnel.
export const secureRequest = (req: IncomingMessage) => {
  const h = headerOf(req);
  return (h("origin") ?? "").startsWith("https://") || h("x-forwarded-proto") === "https";
};

export type ApiInput = { body: unknown; generation: number | undefined };

// Runs the checks. Answers the request and returns null when one fails.
export async function apiPreamble(req: IncomingMessage, res: ServerResponse, appOrigins: readonly string[]): Promise<ApiInput | null> {
  // Set before any route runs, so a route that writes its own response,
  // such as the chat's event stream, carries them too.
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) res.setHeader(name, value);
  const h = headerOf(req);
  // Defense in depth. See guard.ts.
  const problem = requestSourceProblem({ method: req.method ?? "GET", secFetchSite: h("sec-fetch-site"), origin: h("origin"), appHeader: h(APP_HEADER) }, appOrigins);
  if (problem) {
    send(res, 403, { error: "forbidden_source", message: problem });
    return null;
  }
  const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
  if (hasBody && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    send(res, 415, { error: "json_required" });
    return null;
  }
  let body: unknown;
  try {
    body = hasBody ? await readBody(req) : undefined;
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : "bad_body" });
    return null;
  }
  const header = req.headers["x-case-generation"];
  // A missing or malformed header leaves it undefined, and the API refuses
  // the write.
  const generation = typeof header === "string" && /^\d{1,15}$/.test(header) ? Number(header) : undefined;
  return { body, generation };
}
