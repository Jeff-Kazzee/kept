// A minimal request log (0017, E4): one line per API request with the
// method, the path without its query string, the status and the time in
// milliseconds. For an event stream the line gives the status the stream
// started with, when it started and when it was done, or that the client
// closed it first. Nothing else: never a body, a header, a cookie, a query
// string, a token or an email address. A path segment that is not one of
// the app's route words, or an id of the app's own shape where a route
// takes one, is written as "*", so an address or a token put into a path
// cannot reach the log either. The page's 2-second poll is left out unless
// it fails.
//
// On by default in local mode, off by default in hosted mode.
// APP_REQUEST_LOG=1 or 0 turns it on or off in either mode.
import type { IncomingMessage, ServerResponse } from "node:http";

const LOGGED = ["/api/", "/auth/"];
// Fix round 1, R3: the page asks GET /api/case/version every 2 seconds. Its
// answers are not logged unless they fail, so the log keeps the requests a
// person made.
const POLLS = new Set(["GET /api/case/version"]);
// Fix round 1, R4: the words of the app's own routes. Any other segment is
// "*", unless it sits where a route takes an id and has the shape of an id
// the app makes.
const ROUTE_WORDS = new Set(
  (
    "api auth activity undo calendar case delete version conflicts explain evidence accept reject fixtures messages extract manual own-report " +
    "profile name questions answer next records archive unarchive reply drafts approve discard edit suggest settings timezone model provider state " +
    "account judge-code chatgpt signout start meta-key chat google refresh connect disconnect session judge usage callback signin gmail add"
  ).split(" "),
);
// Fix round 2, F5: a message id can hold words a person or an email chose,
// and a fact id holds its message's id, so both are always "*". The ids
// kept are made by the server from numbers and dates only.
const SLOT = String.raw`\d{8}(?:-\d{4})?`;
const ID_AFTER: Record<string, RegExp> = {
  conflicts: new RegExp(`^(?:both-held|change-proposed|unknown-order|possibly-stale|location-mismatch|incomplete-slot)-${SLOT}(?:_${SLOT})*(?:-change)?$`),
  questions: /^q\d{1,4}$/,
  drafts: /^d\d{1,4}$/,
  records: /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/,
  activity: /^a\d{1,6}$/,
};
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function requestLogEnabled(mode: "local" | "hosted", setting: string | undefined): boolean {
  if (setting === "1") return true;
  if (setting === "0") return false;
  return mode === "local";
}

// The path as the log writes it: no query string or fragment, the app's
// route words as they are, an id of the app's own shape where the route
// takes one, and "*" for every other segment.
export function loggedPath(url: string | undefined): string | null {
  const raw = (url ?? "/").split(/[?#]/, 1)[0]!;
  if (!LOGGED.some((p) => raw.startsWith(p))) return null;
  const parts = raw.split("/");
  const out = parts.map((s, i) => {
    if (i === 0 || s === "") return s;
    if (ROUTE_WORDS.has(s)) return s;
    const shape = ID_AFTER[parts[i - 1]!];
    let decoded = s;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      return "*";
    }
    return shape && shape.test(decoded) ? decoded : "*";
  });
  return out.join("/").slice(0, 200);
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
      if (POLLS.has(`${method} ${path}`) && status !== null && status < 400) return;
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
