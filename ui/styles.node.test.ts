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
});
