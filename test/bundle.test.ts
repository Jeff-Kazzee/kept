// Sprint 7B review round 1, finding 1: the scripted chat makes real case
// writes, so the production bundle must not contain it. A development
// build keeps it, which shows the search can find it.
//
// Each build runs in its own process with a hard time limit, so a stuck
// build fails this test instead of holding the test run open.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MOCK_MARKER } from "../ui/chat/mockStream.ts";
import { fromPackage } from "../src/paths.ts";

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
    const child = spawn(process.execPath, args, { cwd: fromPackage(), env: { ...process.env, NODE_ENV: mode }, stdio: ["ignore", "ignore", "pipe"] });
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
      const assets = path.join(outDir, "assets");
      resolve(
        readdirSync(assets)
          .filter((f) => f.endsWith(".js"))
          .map((f) => readFileSync(path.join(assets, f), "utf8"))
          .join("\n"),
      );
    });
  });
}

describe("production bundle", () => {
  it("has no scripted chat code, while a development build has it", async () => {
    const prod = await bundle("production");
    expect(prod).not.toContain(MOCK_MARKER);
    expect(prod).not.toContain("Checking the change against your messages");
    const dev = await bundle("development");
    expect(dev).toContain(MOCK_MARKER);
  }, 2 * BUILD_LIMIT_MS + 10_000);
});
