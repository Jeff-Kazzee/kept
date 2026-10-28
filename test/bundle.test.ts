// Sprint 7B review round 1, finding 1: the scripted chat makes real case
// writes, so the production bundle must not contain it. A development
// build keeps it, which shows the search can find it.
//
// Each build runs in its own process with a hard time limit, so a stuck
// build fails this test instead of holding the test run open.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { precompress } from "../scripts/precompress.ts";
import { fromPackage } from "../src/paths.ts";

// The scripted chat's marker, read from its source rather than imported, so
// the root typecheck does not compile the UI's files (sprint 8).
const MOCK_MARKER = /export const MOCK_MARKER = "([^"]+)";/.exec(readFileSync(fromPackage("ui/chat/mockStream.ts"), "utf8"))![1]!;
const FAKES_MARKER = /export const FAKES_MARKER = "([^"]+)";/.exec(readFileSync(fromPackage("ui/dev/fakeBackend.ts"), "utf8"))![1]!;

const BUILD_LIMIT_MS = 60_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function bundle(mode: "production" | "development"): Promise<string> {
  const outDir = mkdtempSync(path.join(tmpdir(), `bundle-${mode}-`));
  dirs.push(outDir);
  const args = [fromPackage("node_modules/vite/bin/vite.js"), "build", "--config", fromPackage("vite.config.ts"), "--mode", mode, "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"];
  if (mode === "development") args.push("--minify", "false");
  return new Promise((resolve, reject) => {
    // Vite reads NODE_ENV, which vitest sets to "test". Build as pnpm
    // build and pnpm dev would.
    // APP_UI_FAKES makes a check build with the fakes (vite.config.ts), so
    // it is cleared here.
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: mode };
    delete env.APP_UI_FAKES;
    const child = spawn(process.execPath, args, { cwd: fromPackage(), env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`vite build (${mode}) did not finish in ${BUILD_LIMIT_MS / 1000} s`));
    }, BUILD_LIMIT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`vite build (${mode}) exited ${code}: ${err}`));
      // As pnpm build does, then every emitted file, in every folder:
      // scripts, styles, maps, HTML and the decompressed .br and .gz copies.
      precompress(outDir);
      resolve(emitted(outDir));
    });
  });
}

// The text of every file under `dir`, compressed copies decompressed.
export function emitted(dir: string): string {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  expect(files.length).toBeGreaterThan(3);
  return files
    .map((e) => {
      const bytes = readFileSync(path.join(e.parentPath, e.name));
      if (e.name.endsWith(".br")) return brotliDecompressSync(bytes).toString("utf8");
      if (e.name.endsWith(".gz")) return gunzipSync(bytes).toString("utf8");
      return bytes.toString("utf8");
    })
    .join("\n");
}

describe("production bundle", () => {
  it("review 2, B7: the scan reads nested files, maps and compressed copies", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-scan-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "assets/deep"), { recursive: true });
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "assets/deep/a.js.map"), JSON.stringify({ sourcesContent: [`const k = "${MOCK_MARKER}";`] }));
    writeFileSync(path.join(dir, "assets/b.js.br"), brotliCompressSync(Buffer.from(`brotli ${MOCK_MARKER}`)));
    writeFileSync(path.join(dir, "assets/c.js.gz"), gzipSync(Buffer.from("gzip only-in-gz")));
    const text = emitted(dir);
    expect(text).toContain(`const k = \\"${MOCK_MARKER}\\";`);
    expect(text).toContain(`brotli ${MOCK_MARKER}`);
    expect(text).toContain("gzip only-in-gz");
  });

  it("has no scripted chat code and no route fakes, while a development build has both", async () => {
    const prod = await bundle("production");
    expect(prod).not.toContain(MOCK_MARKER);
    expect(prod).not.toContain(FAKES_MARKER);
    expect(prod).not.toContain("Checking the change against your messages");
    expect(prod).not.toContain("sample.person@example.com");
    const dev = await bundle("development");
    expect(dev).toContain(MOCK_MARKER);
    expect(dev).toContain(FAKES_MARKER);
  }, 2 * BUILD_LIMIT_MS + 10_000);
});
