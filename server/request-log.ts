// A minimal request log (0017, E4): one line per API request with the
// method, the path without its query string, the status and the time in
// milliseconds. For an event stream the line gives the status the stream
// started with, when it started and when it was done, or that the client
// closed it first. Nothing else: never a body, a header, a cookie, a query
// string, a token or an email address. A path segment that is not a plain
// id is written as "*", so an address or a token put into a path cannot
// reach the log either.
//
// On by default in local mode, off by default in hosted mode.
// APP_REQUEST_LOG=1 or 0 turns it on or off in either mode.
import type { IncomingMessage, ServerResponse } from "node:http";

const LOGGED = ["/api/", "/auth/"];
const PLAIN_SEGMENT = /^[A-Za-z0-9._:-]{1,80}$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function requestLogEnabled(mode: "local" | "hosted", setting: string | undefined): boolean {
  if (setting === "1") return true;
  if (setting === "0") return false;
  return mode === "local";
}

// The path as the log writes it: no query string or fragment, and every
// segment that is not a plain id replaced by "*".
export function loggedPath(url: string | undefined): string | null {
  const raw = (url ?? "/").split(/[?#]/, 1)[0]!;
  if (!LOGGED.some((p) => raw.startsWith(p))) return null;
  const parts = raw.split("/").map((s, i) => (i === 0 || s === "" || (PLAIN_SEGMENT.test(s) && !s.includes("@")) ? s : "*"));
  return parts.join("/").slice(0, 200);
}

export type RequestLogOptions = { write: (line: string) => void; now?: () => number };

// The Content-Type among the headers given to writeHead, as an object or
// as a flat list of names and values.
function contentType(headers: unknown): string {
  if (Array.isArray(headers)) {
    const i = headers.findIndex((h, n) => n % 2 === 0 && String(h).toLowerCase() === "content-type");
    return i >= 0 ? String(headers[i + 1] ?? "") : "";
  }
  if (!headers || typeof headers !== "object") return "";
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type");
  return hit ? String(hit[1]) : "";
}

// Returns the hook the server calls first for every request.
export function requestLogger(options: RequestLogOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const now = options.now ?? (() => performance.now());
  return (req, res) => {
    const path = loggedPath(req.url);
    if (path === null) return;
    const method = METHODS.has(req.method ?? "") ? req.method! : "OTHER";
    const start = now();
    let headAt: number | null = null;
    let headStatus: number | null = null;
    let headType = "";
    const writeHead = res.writeHead;
    res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
      if (headAt === null) {
        headAt = now();
        headStatus = typeof args[0] === "number" ? args[0] : null;
        headType = contentType(args.find((a) => typeof a === "object" && a !== null));
      }
      return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
    } as ServerResponse["writeHead"];
    let done = false;
    const finish = (finished: boolean) => {
      if (done) return;
      done = true;
      const ms = Math.round(now() - start);
      const status = headStatus ?? (res.headersSent ? res.statusCode : null);
      const type = headType || String(res.getHeader("content-type") ?? "");
      if (status === null) {
        options.write(`request ${method} ${path} closed before an answer, ${ms} ms`);
      } else if (type.startsWith("text/event-stream")) {
        const startedMs = Math.round((headAt ?? start) - start);
        options.write(`request ${method} ${path} ${status} stream, started ${startedMs} ms, ${finished ? "done" : "closed by the client"} at ${ms} ms`);
      } else {
        options.write(`request ${method} ${path} ${status} ${ms} ms${finished ? "" : ", closed by the client"}`);
      }
    };
    res.once("finish", () => finish(true));
    res.once("close", () => finish(res.writableFinished));
  };
}
