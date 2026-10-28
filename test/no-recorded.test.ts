// J12: recorded answers never reach a person using the app. The recorded
// and fault clients are test doubles that tests and the eval inject. No
// production entry point can reach them: this walks every import from the
// app server, the MCP server and the page, and none leads to a recorded
// client. test/bundle.test.ts checks the built page too.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromPackage } from "../src/paths.ts";

const RECORDED = [fromPackage("src/model/recorded.ts"), fromPackage("src/agent/recorded.ts")];

// Static imports, re-exports and dynamic imports with a literal path.
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

// Every package file `entry` reaches through relative imports, and the
// chain that leads to each.
export function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3]!;
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (!existsSync(target) || seen.has(target)) continue;
      seen.set(target, [...seen.get(file)!, target]);
      if (/\.(?:ts|tsx)$/.test(target)) queue.push(target);
    }
  }
  return seen;
}

describe("J12: no production code path picks a recorded client", () => {
  for (const entry of ["server/main.ts", "mcp/main.ts", "ui/main.tsx"]) {
    it(`${entry} never imports a recorded client`, () => {
      const files = reachable(fromPackage(entry));
      expect(files.size).toBeGreaterThan(entry.startsWith("ui/") ? 10 : 20);
      for (const r of RECORDED) {
        const chain = files.get(r);
        expect(chain?.map((f) => path.relative(fromPackage(), f)).join(" -> ") ?? null, r).toBeNull();
      }
    });
  }

  it("the walk finds a recorded client where one is imported", () => {
    const files = reachable(fromPackage("src/eval/cli.ts"));
    for (const r of RECORDED) expect(files.has(r), r).toBe(true);
  });

  it("the servers have no recorded mode and no APP_LIVE_MODEL switch", () => {
    for (const f of ["server/main.ts", "server/api.ts", "mcp/main.ts"]) {
      const text = readFileSync(fromPackage(f), "utf8");
      expect(text, f).not.toMatch(/APP_LIVE_MODEL|mode: "recorded"|fromDirectory\(/);
    }
  });
});
