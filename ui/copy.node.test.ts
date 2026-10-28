// Review C2 (sprint 13B): the product's text names no developer files. A
// docs path is for whoever runs the server, not for the person in the
// app. Read from every page source the build ships, comments left out.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromPackage } from "../src/paths.ts";
import { GOOGLE_ERROR_TEXT } from "../src/google/http.ts";

function sources(dir: string): string[] {
  return readdirSync(fromPackage(dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    if (statSync(fromPackage(rel)).isDirectory()) return sources(rel);
    return /\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) && name !== "test-dom.ts" ? [rel] : [];
  });
}

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("C2: no docs path in the product's text", () => {
  it("no page source shows a docs path or a Markdown file name", () => {
    for (const f of sources("ui")) {
      expect(withoutComments(readFileSync(fromPackage(f), "utf8")), f).not.toMatch(/docs\/|\b[\w-]+\.md\b/);
    }
  });

  it("the server's Google errors, which the page shows as written, name none either", () => {
    for (const text of Object.values(GOOGLE_ERROR_TEXT)) expect(text).not.toMatch(/docs\/|\.md\b/);
  });
});
