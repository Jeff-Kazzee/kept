// 0019, P34: every text and pill pair of the token block meets WCAG AA in
// both themes (4.5:1 for text, 3:1 for large display type and icons). A
// token change that drops a pair below its minimum fails here. Ported from
// the design explorer's contrast check, with its list of extra pairs
// (ui/contrast-pairs.json). Alpha colors are laid over their ground.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const block = css.slice(0, css.indexOf(':root[data-theme="light"]'));
const raw: Record<string, string> = {};
for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) raw[m[1]!] = m[2]!.trim();

type Theme = "dark" | "light";
type Rgba = [number, number, number, number];

const parse = (s: string): Rgba | null => {
  s = s.trim();
  let m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  m = s.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/);
  if (m) return [+m[1]!, +m[2]!, +m[3]!, m[4] === undefined ? 1 : +m[4]];
  return null;
};
const value = (name: string, theme: Theme): string => {
  let v = raw[name];
  if (v === undefined) throw new Error(`no --${name}`);
  const ref = v.match(/^var\(--([\w-]+)\)$/);
  if (ref) return value(ref[1]!, theme);
  const ld = v.match(/^light-dark\((.+),\s*(.+)\)$/);
  if (ld) v = theme === "light" ? ld[1]! : ld[2]!;
  return v;
};
const color = (spec: string, theme: Theme, ground?: string): Rgba => {
  const c = spec.startsWith("#") || spec.startsWith("rgb") ? parse(spec) : parse(value(spec, theme));
  if (!c) throw new Error(`cannot read ${spec}`);
  if (c[3] < 1) {
    const g = color(ground ?? "bg", theme);
    return [0, 1, 2].map((i) => c[i]! * c[3] + g[i]! * (1 - c[3])).concat(1) as Rgba;
  }
  return c;
};
const lum = (c: Rgba) => {
  const f = (x: number) => {
    x /= 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
export const ratio = (a: Rgba, b: Rgba) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

const cfg = JSON.parse(readFileSync(new URL("./contrast-pairs.json", import.meta.url), "utf8")) as {
  pairs: Array<[string, string, number?, string?, Theme?]>;
  skip: Array<[string, string, Theme, string]>;
};
const pairs: Array<[string, string, number?, string?, Theme?]> = [
  ...["bg", "surface", "surface-2", "surface-3", "sidebar"].map((g): [string, string] => ["text", g]),
  ...["bg", "surface", "surface-2", "surface-3", "sidebar"].map((g): [string, string] => ["text-2", g]),
  ["text", "bubble"],
  ["text", "raised"],
  ["accent-text", "bg"],
  ["accent-text", "surface"],
  ["accent-text", "surface-2"],
  ["accent-text", "accent-soft"],
  ["on-accent", "accent"],
  ["on-accent", "accent-hover"],
  ["on-accent", "accent-pressed"],
  ["danger", "danger-soft"],
  ["danger", "surface"],
  ["on-danger", "danger"],
  ["success", "success-soft"],
  ["success", "surface"],
  ["warn", "warn-soft"],
  ["warn", "surface"],
  ["untrusted-label", "untrusted-bg"],
  ...["confirmed", "offered", "requested", "change", "clash", "canceled", "calendar", "declined"].flatMap((s): Array<[string, string]> => [
    [`st-${s}-fg`, `st-${s}-bg`],
    [`st-${s}-fg`, "surface"],
  ]),
  ...cfg.pairs,
];

describe("0019, P34: contrast of the Steel tokens", () => {
  it("every listed pair meets its minimum in both themes", () => {
    const below: string[] = [];
    let checked = 0;
    for (const [fg, bg, min = 4.5, note = "", only] of pairs) {
      for (const theme of ["dark", "light"] as const) {
        if ((only && only !== theme) || cfg.skip.some(([f, g, t]) => f === fg && g === bg && t === theme)) continue;
        const r = ratio(color(fg, theme, bg), color(bg, theme));
        checked++;
        if (r < min) below.push(`${fg} on ${bg} (${theme}${note ? `, ${note}` : ""}): ${r.toFixed(2)} < ${min}`);
      }
    }
    expect(below).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it("a pair below its minimum is caught", () => {
    expect(ratio([153, 153, 153, 1], [255, 255, 255, 1])).toBeLessThan(4.5);
    expect(ratio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 0);
  });
});
