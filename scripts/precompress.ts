// Runs after `vite build` (see `pnpm build`). Writes a brotli (.br) and a
// gzip (.gz) copy beside every text file of the UI build, so the server
// sends them without compressing on each request. Then it checks the
// JavaScript budget: the scripts index.html loads must stay under 100 KB (0019, P18)
// gzipped. Over budget, it exits 1.
//
//   node scripts/precompress.ts [dir]    dir defaults to dist/ui
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { fromPackage } from "../src/paths.ts";

export const JS_BUDGET_BYTES = 100 * 1024;
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json", ".txt", ".webmanifest"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

export type Compressed = { file: string; raw: number; gzip: number; br: number };

export function precompress(dir: string): Compressed[] {
  const out: Compressed[] = [];
  for (const file of files(dir)) {
    if (!COMPRESSIBLE.has(path.extname(file))) continue;
    const raw = readFileSync(file);
    const gz = gzipSync(raw, { level: 9 });
    const br = brotliCompressSync(raw, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
    });
    writeFileSync(`${file}.gz`, gz);
    writeFileSync(`${file}.br`, br);
    out.push({ file: path.relative(dir, file), raw: raw.length, gzip: gz.length, br: br.length });
  }
  return out;
}

// The scripts the page loads before it can run: the entry module and every
// module it preloads, as index.html names them.
export function firstLoadScripts(indexHtml: string): string[] {
  const found = new Set<string>();
  for (const m of indexHtml.matchAll(/<script[^>]*\bsrc="([^"]+\.js)"/g)) found.add(m[1]!);
  for (const m of indexHtml.matchAll(/<link[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+\.js)"/g)) found.add(m[1]!);
  return [...found].map((p) => p.replace(/^\//, ""));
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

if (import.meta.main) {
  const dir = path.resolve(process.argv[2] ?? fromPackage("dist/ui"));
  const done = precompress(dir);
  for (const c of done) console.log(`${c.file.padEnd(40)} ${kb(c.raw).padStart(10)}  gzip ${kb(c.gzip).padStart(9)}  br ${kb(c.br).padStart(9)}`);
  const scripts = firstLoadScripts(readFileSync(path.join(dir, "index.html"), "utf8"));
  const sizes = new Map(done.map((c) => [c.file.split(path.sep).join("/"), c]));
  const total = scripts.reduce((sum, s) => sum + (sizes.get(s)?.gzip ?? 0), 0);
  const css = done.filter((c) => c.file.endsWith(".css")).reduce((sum, c) => sum + c.gzip, 0);
  console.log(`JavaScript on first load: ${kb(total)} gzipped in ${scripts.length} file(s), budget ${kb(JS_BUDGET_BYTES)}. CSS: ${kb(css)} gzipped.`);
  if (scripts.length === 0) {
    console.error("index.html loads no script. The build looks wrong.");
    process.exit(1);
  }
  if (total > JS_BUDGET_BYTES) {
    console.error("Over the JavaScript budget.");
    process.exit(1);
  }
}
