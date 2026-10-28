// Serves the production build of the UI (`pnpm build`, then `pnpm start`).
// Every file is read into memory at start, with the brotli and gzip copies
// the build wrote beside it. Hashed files under /assets/ never change, so
// they are cached for a year. index.html is revalidated on every load, so a
// new build shows at the next reload. Every response carries a strict
// Content-Security-Policy: scripts and styles only from this origin, no
// inline scripts, and requests only to this origin.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export const IMMUTABLE = "public, max-age=31536000, immutable";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

type Entry = { type: string; etag: string; cache: string; raw: Buffer; br?: Buffer; gzip?: Buffer };

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const rel = `${prefix}/${name}`;
    return statSync(full).isDirectory() ? walk(full, rel) : [rel];
  });
}

// Reads the build in `root` into memory. Throws when there is no build, so
// `pnpm start` without `pnpm build` stops with a clear message.
export function loadBuild(root: string): Map<string, Entry> {
  if (!existsSync(path.join(root, "index.html"))) {
    throw new Error(`No production build in ${root}. Run pnpm build first.`);
  }
  const files = new Map<string, Entry>();
  const all = walk(root);
  for (const rel of all) {
    if (rel.endsWith(".br") || rel.endsWith(".gz")) continue;
    const raw = readFileSync(path.join(root, rel));
    const read = (suffix: string) => (all.includes(rel + suffix) ? readFileSync(path.join(root, rel + suffix)) : undefined);
    files.set(rel, {
      type: TYPES[path.extname(rel)] ?? "application/octet-stream",
      etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 27)}"`,
      cache: rel.startsWith("/assets/") ? IMMUTABLE : "no-cache",
      raw,
      br: read(".br"),
      gzip: read(".gz"),
    });
  }
  return files;
}

// Picks brotli, then gzip, as the browser accepts them.
export function pickEncoding(acceptEncoding: string | undefined, entry: Pick<Entry, "br" | "gzip">): "br" | "gzip" | null {
  const accepted = new Set(
    (acceptEncoding ?? "")
      .split(",")
      .map((part) => part.trim().split(";"))
      .filter(([, q]) => q === undefined || !/^\s*q=0(\.0*)?\s*$/.test(q))
      .map(([name]) => name!.trim().toLowerCase()),
  );
  if (entry.br && accepted.has("br")) return "br";
  if (entry.gzip && accepted.has("gzip")) return "gzip";
  return null;
}

// A request handler for every path outside /api/. A path with no file
// extension that is not a file gets index.html, so the app can own its
// paths. A missing file with an extension is a 404.
export function createStaticHandler(root: string) {
  const files = loadBuild(root);
  const index = files.get("/index.html")!;
  return function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method not allowed.");
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://app.invalid").pathname);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad request.");
      return;
    }
    // Only names from the build map are served, so a path cannot leave the
    // build folder.
    const entry = files.get(pathname === "/" ? "/index.html" : pathname) ?? (path.extname(pathname) === "" ? index : undefined);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
      res.end("Not found.");
      return;
    }
    const headers: Record<string, string> = { "Content-Type": entry.type, "Cache-Control": entry.cache, ETag: entry.etag, Vary: "Accept-Encoding" };
    if (req.headers["if-none-match"] === entry.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const encoding = pickEncoding(req.headers["accept-encoding"], entry);
    const body = encoding === "br" ? entry.br! : encoding === "gzip" ? entry.gzip! : entry.raw;
    if (encoding) headers["Content-Encoding"] = encoding;
    headers["Content-Length"] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  };
}
