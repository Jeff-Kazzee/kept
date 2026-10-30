// Serves the production build of the UI (`pnpm build`, then `pnpm start`).
// Every file is read into memory at start, with the brotli and gzip copies
// the build wrote beside it. Hashed files under /assets/ never change, so
// they are cached for a year. index.html is revalidated on every load, so a
// new build shows at the next reload. Every response carries a strict
// Content-Security-Policy: scripts and styles only from this origin, no
// inline scripts, and requests only to this origin.
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
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

// Every /api response: JSON or an event stream, never a page. Nothing in it
// may be sniffed as another type or run as a page.
export const API_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
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

export class BuildError extends Error {}

// Every regular file under `dir`, as "/assets/x.js". A symlink stops the
// start, because it could point outside the build. Each file's real path
// must stay inside the build root's real path.
function walk(dir: string, realRoot: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const rel = `${prefix}/${name}`;
    const info = lstatSync(full);
    if (info.isSymbolicLink()) throw new BuildError(`The build has a symlink at ${rel}. The app serves only regular files from dist/ui. Run pnpm build again.`);
    if (!realpathSync(full).startsWith(realRoot + path.sep)) throw new BuildError(`The build file ${rel} is outside the build folder.`);
    if (info.isDirectory()) return walk(full, realRoot, rel);
    if (!info.isFile()) throw new BuildError(`The build has ${rel}, which is not a regular file.`);
    return [rel];
  });
}

// Reads one build file through a single open handle. O_NOFOLLOW refuses a
// symlink put in place after the walk, and fstat checks the file that was
// opened, so a swap between the check and the read cannot serve another
// file.
export function readBuildFile(realRoot: string, rel: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path.join(realRoot, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    throw new BuildError(`The build file ${rel} could not be opened as a regular file (${(err as NodeJS.ErrnoException).code ?? "error"}). Run pnpm build again.`);
  }
  try {
    if (!fstatSync(fd).isFile()) throw new BuildError(`The build has ${rel}, which is not a regular file.`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Reads the build in `root` into memory. Throws when there is no build, so
// `pnpm start` without `pnpm build` stops with a clear message.
export function loadBuild(root: string): Map<string, Entry> {
  if (!existsSync(path.join(root, "index.html"))) {
    throw new BuildError(`No production build in ${root}. Run pnpm build first.`);
  }
  const realRoot = realpathSync(root);
  const files = new Map<string, Entry>();
  const all = walk(realRoot, realRoot);
  for (const rel of all) {
    if (rel.endsWith(".br") || rel.endsWith(".gz")) continue;
    const raw = readBuildFile(realRoot, rel);
    const read = (suffix: string) => (all.includes(rel + suffix) ? readBuildFile(realRoot, rel + suffix) : undefined);
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

// 0019, P17: the reads the page makes before it can show the case. In
// local mode index.html asks for them as preloads, so they run while the
// script loads instead of after it. GET routes need no header (guard.ts),
// so the page's own fetch takes the preloaded answer. The hosted site has
// none: its reads need a session first.
// Round 2, finding 2: only the session and the first render's data, read
// together and naming its generation (GET /api/boot).
export const FIRST_LOAD_READS = ["/api/session", "/api/boot"] as const;

// index.html with a preload link for each read, before </head>.
export function withPreloads(html: string, reads: readonly string[]): string {
  if (reads.length === 0) return html;
  const links = reads.map((r) => `<link rel="preload" href="${r}" as="fetch" crossorigin>`).join("\n    ");
  return html.replace("</head>", `  ${links}\n  </head>`);
}

// 0019, P30: the server-rendered case screen. `render` gives the case's
// HTML and the boot data it was rendered from, or null to serve the plain
// page. Local mode only (server/main.ts).
export type Rendered = { html: string; boot: unknown };
export type StaticOptions = { preload?: readonly string[]; render?: (req: IncomingMessage) => Promise<Rendered | null> };

// The boot data as a JSON block. Data, not code, so the CSP's script-src
// 'self' holds. Every "<" is escaped, so no "</script>" or "<!--" in a
// message can end the block, and the two line separators JSON allows but
// some parsers do not are escaped too.
export function bootBlock(boot: unknown): string {
  const json = JSON.stringify(boot).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<script id="boot" type="application/json">${json}</script>`;
}

// index.html with the rendered case in #root and the boot block after it.
export function withRendered(html: string, rendered: Rendered): string {
  return html.replace('<div id="root"></div>', () => `<div id="root" data-server-rendered="">${rendered.html}</div>${bootBlock(rendered.boot)}`);
}

// A request handler for every path outside /api/. A path with no file
// extension that is not a file gets index.html, so the app can own its
// paths. A missing file with an extension is a 404.
export function createStaticHandler(root: string, options: StaticOptions = {}) {
  const files = loadBuild(root);
  if (options.preload && options.preload.length > 0) {
    const raw = Buffer.from(withPreloads(files.get("/index.html")!.raw.toString("utf8"), options.preload));
    files.set("/index.html", {
      ...files.get("/index.html")!,
      raw,
      etag: `"${createHash("sha256").update(raw).digest("base64url").slice(0, 27)}"`,
      br: brotliCompressSync(raw),
      gzip: gzipSync(raw, { level: 9 }),
    });
  }
  const index = files.get("/index.html")!;
  // The page without preloads, for the rendered case: its data is inline.
  const template = loadBuild(root).get("/index.html")!.raw.toString("utf8");
  // A page the server rendered holds this moment's case, so it is never
  // stored. It is compressed as it is sent.
  const sendRendered = (req: IncomingMessage, res: ServerResponse, rendered: Rendered) => {
    const raw = Buffer.from(withRendered(template, rendered));
    const accepted = (req.headers["accept-encoding"] ?? "").toString();
    const br = /\bbr\b/.test(accepted);
    const gz = !br && /\bgzip\b/.test(accepted);
    const body = br ? brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }) : gz ? gzipSync(raw, { level: 6 }) : raw;
    const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Encoding", "Content-Length": String(body.length) };
    if (br) headers["Content-Encoding"] = "br";
    if (gz) headers["Content-Encoding"] = "gzip";
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  };
  return function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    void serve(req, res);
  };
  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    // The scripted chat of a check build (?mockchat=1) renders on its own.
    if (entry === index && options.render && !new URL(req.url ?? "/", "http://app.invalid").searchParams.has("mockchat")) {
      let rendered: Rendered | null = null;
      try {
        rendered = await options.render(req);
      } catch (err) {
        console.error(`The case screen could not be rendered on the server (${err instanceof Error ? err.name : "error"}). The page renders it itself.`);
      }
      if (rendered) return sendRendered(req, res, rendered);
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
  }
}
