// Review 1, finding 8: touch targets are at least 44 px, the theme switch
// included. Read from the stylesheet the build ships.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("touch targets", () => {
  it("the touch token is 44 px and every control rule uses it", () => {
    expect(css).toMatch(/--touch: 44px;/);
    for (const selector of [".btn", ".chip", ".check", ".input, .select, .textarea", ".segmented label", "details > summary"]) {
      expect(rule(selector), selector).toMatch(/min-height: var\(--touch\)/);
    }
    expect(rule(".segmented label")).not.toMatch(/min-height: 40px/);
  });

  it("Muse round 1, finding 9: Undo links, tabs, the model pill, info buttons and every summary give a 44 px hit area", () => {
    for (const selector of [".link-btn", ".tabs button", ".model-pill", ".infotip-btn", ".new-pill", ".send-btn", ".rail-btn", ".fact-toggle", ".menu-item", ".side-item", ".account-btn"]) {
      expect(rule(selector), selector).toMatch(/(min-height|height): var\(--touch\)/);
    }
    // No summary or link brings its hit area back under the token.
    expect(css).not.toMatch(/summary \{[^}]*min-height: (2|3)\dpx/);
    expect(css).not.toMatch(/\.link-btn \{[^}]*min-height: 32px/);
  });
});

describe("0015: the shell", () => {
  it("the sidebar is 248 px and folds to the 64 px rail, and its surface is its own token in both themes", () => {
    expect(css).toMatch(/--side-w: 248px;/);
    expect(css).toMatch(/--rail-w: 64px;/);
    expect(css).toMatch(/--sidebar: light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\);/);
    expect(rule(".sidebar")).toMatch(/background: var\(--sidebar\)/);
    expect(css).toMatch(/\.app\[data-side="full"\] \{ grid-template-columns: var\(--side-w\) minmax\(0, 1fr\); \}/);
  });

  it("the work area's top bar and the sidebar's head share the 56 px line", () => {
    expect(rule(".side-head")).toMatch(/height: calc\(var\(--topbar-h\) \+ env\(safe-area-inset-top\)\)/);
    expect(css).toMatch(/--topbar-h: 56px;/);
    expect(rule(".panel-head")).toMatch(/min-height: 56px/);
  });
});
