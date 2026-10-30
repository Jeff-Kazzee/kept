// Sprint 7B: the production build is served from memory with precompressed
// files, cache headers that fit hashed and unhashed files, and a strict
// Content-Security-Policy. Run against a small build made in a temporary
// folder, so the test needs no `pnpm build`.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JS_BUDGET_BYTES, firstLoadScripts, precompress } from "../scripts/precompress.ts";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { BuildError, CONTENT_SECURITY_POLICY, FIRST_LOAD_READS, IMMUTABLE, createStaticHandler, loadBuild, pickEncoding, readBuildFile, withPreloads } from "../server/static.ts";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const INDEX = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-abc123.js"></script><link rel="modulepreload" href="/assets/vendor-def456.js"><link rel="stylesheet" href="/assets/index-abc123.css"></head><body><div id="root"></div></body></html>';

function build() {
  const dir = mkdtempSync(path.join(tmpdir(), "static-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), INDEX);
  writeFileSync(path.join(dir, "assets/index-abc123.js"), "console.log('app');".repeat(200));
  writeFileSync(path.join(dir, "assets/vendor-def456.js"), "export const x = 1;".repeat(200));
  writeFileSync(path.join(dir, "assets/index-abc123.css"), "body{margin:0}".repeat(100));
  writeFileSync(path.join(dir, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return dir;
}

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

async function serve(dir: string, preload: readonly string[] = []) {
  const handler = createStaticHandler(dir, { preload });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return (p: string, headers: Record<string, string> = {}, method = "GET") =>
    new Promise<Res>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
}

describe("production build serving", () => {
  it("precompresses text files and measures the scripts index.html loads", () => {
    const dir = build();
    const out = precompress(dir);
    expect(out.map((c) => c.file).sort()).toEqual(["assets/index-abc123.css", "assets/index-abc123.js", "assets/vendor-def456.js", "icon.svg", "index.html"]);
    for (const c of out) expect(c.br).toBeLessThanOrEqual(c.raw + 20);
    expect(firstLoadScripts(INDEX)).toEqual(["assets/index-abc123.js", "assets/vendor-def456.js"]);
    // 0019, P18: the budget tightened from 150 KB to 100 KB.
    expect(JS_BUDGET_BYTES).toBe(100 * 1024);
  });

  it("sends brotli or gzip as accepted, immutable caching on hashed assets and no-cache on index.html", async () => {
    const dir = build();
    precompress(dir);
    const get = await serve(dir);
    const js = await get("/assets/index-abc123.js", { "Accept-Encoding": "gzip, deflate, br" });
    expect(js.status).toBe(200);
    expect(js.headers["content-encoding"]).toBe("br");
    expect(js.headers["cache-control"]).toBe(IMMUTABLE);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers.vary).toBe("Accept-Encoding");
    expect((await get("/assets/index-abc123.js", { "Accept-Encoding": "gzip" })).headers["content-encoding"]).toBe("gzip");
    expect((await get("/assets/index-abc123.js", { "Accept-Encoding": "br;q=0, gzip" })).headers["content-encoding"]).toBe("gzip");
    const plain = await get("/assets/index-abc123.js");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body.toString()).toContain("console.log('app');");

    const index = await get("/", { "Accept-Encoding": "br" });
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
    const etag = String(index.headers.etag);
    expect((await get("/", { "If-None-Match": etag })).status).toBe(304);
    // A path the app owns gets index.html. A missing file is a 404.
    expect((await get("/schedule")).body.toString()).toBe(INDEX);
    expect((await get("/assets/missing.js")).status).toBe(404);
    expect((await get("/icon.svg")).headers["cache-control"]).toBe("no-cache");
    expect((await get("/", {}, "HEAD")).body.length).toBe(0);
    expect((await get("/", {}, "POST")).status).toBe(405);
  });

  it("sends a strict Content-Security-Policy and the other security headers on every response", async () => {
    const get = await serve(build());
    for (const p of ["/", "/assets/index-abc123.js", "/nope.js"]) {
      const res = await get(p);
      expect(res.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  });

  it("serves only files of the build, whatever the path says", async () => {
    const get = await serve(build());
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/assets/..%2f..%2fpackage.json", "/%2e%2e%2fserver%2fmain.ts"]) {
      const res = await get(p);
      expect([200, 404]).toContain(res.status);
      // Paths with no extension fall back to index.html, never to a file
      // outside the build.
      if (res.status === 200) expect(res.body.toString()).toBe(INDEX);
    }
    expect(pickEncoding(undefined, { br: Buffer.from("x") })).toBeNull();
  });

  it("stops with a clear message when there is no build", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "static-empty-"));
    dirs.push(dir);
    expect(() => loadBuild(dir)).toThrow(/Run pnpm build first/);
  });

  it("review 1, finding 3: refuses a build with a symlink, so no file outside the build is read or served", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "static-outside-"));
    dirs.push(outside);
    writeFileSync(path.join(outside, "secret.txt"), "outside the build");
    // A file symlink, a precompressed copy that is a symlink, and a folder symlink.
    for (const plant of [
      (dir: string) => symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "assets/leak.js")),
      (dir: string) => symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "assets/index-abc123.js.br")),
      (dir: string) => symlinkSync(outside, path.join(dir, "assets/more")),
    ]) {
      const dir = build();
      plant(dir);
      expect(() => loadBuild(dir)).toThrow(BuildError);
      expect(() => createStaticHandler(dir)).toThrow(/symlink/);
    }
    // The build folder itself may be reached through a symlink.
    const real = build();
    const link = path.join(mkdtempSync(path.join(tmpdir(), "static-link-")), "ui");
    dirs.push(path.dirname(link));
    symlinkSync(real, link);
    expect([...loadBuild(link).keys()]).toContain("/index.html");
  });

  it("review 2, B1: each file is read through one handle that refuses a symlink and a folder", () => {
    const dir = build();
    expect(readBuildFile(dir, "/index.html").toString()).toBe(INDEX);
    // A symlink swapped in after the walk: O_NOFOLLOW refuses it.
    const outside = mkdtempSync(path.join(tmpdir(), "static-swap-"));
    dirs.push(outside);
    writeFileSync(path.join(outside, "secret.txt"), "outside the build");
    symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "assets/swapped.js"));
    expect(() => readBuildFile(dir, "/assets/swapped.js")).toThrow(BuildError);
    expect(() => readBuildFile(dir, "/assets/swapped.js")).toThrow(/ELOOP/);
    // A folder is not a regular file.
    expect(() => readBuildFile(dir, "/assets")).toThrow(/not a regular file/);
  });
});

describe("0019, P17: the first reads start with the page", () => {
  it("local mode's index.html preloads each first read as a fetch, in every encoding, and the CSP is unchanged", async () => {
    const dir = build();
    precompress(dir);
    const get = await serve(dir, FIRST_LOAD_READS);
    expect(FIRST_LOAD_READS).toEqual(["/api/session", "/api/boot"]);
    const plain = (await get("/")).body.toString("utf8");
    for (const read of FIRST_LOAD_READS) expect(plain).toContain(`<link rel="preload" href="${read}" as="fetch" crossorigin>`);
    // Before </head>, so the browser starts them before the script runs.
    expect(plain.indexOf('rel="preload"')).toBeLessThan(plain.indexOf("</head>"));
    const br = await get("/", { "Accept-Encoding": "br" });
    expect(br.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(br.body).toString("utf8")).toBe(plain);
    const gz = await get("/", { "Accept-Encoding": "gzip" });
    expect(gunzipSync(gz.body).toString("utf8")).toBe(plain);
    // A path the app owns gets the same page.
    expect((await get("/connections")).body.toString("utf8")).toBe(plain);
    expect((await get("/")).headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    // The ETag is the page's own, so a cached copy without the preloads is replaced.
    const bare = await serve(dir);
    expect((await get("/")).headers.etag).not.toBe((await bare("/")).headers.etag);
  });

  it("the hosted site has none: its reads need a session first", async () => {
    const dir = build();
    precompress(dir);
    const get = await serve(dir);
    expect((await get("/")).body.toString("utf8")).not.toContain('rel="preload"');
    expect(withPreloads(INDEX, [])).toBe(INDEX);
  });

  it("main.ts passes the preloads only in local mode", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("../server/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/createStaticHandler\(fromPackage\("dist\/ui"\), \{ preload: config\.mode === "local" \? FIRST_LOAD_READS : \[\] \}\)/);
  });
});

