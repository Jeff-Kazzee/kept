// Review 1, finding 5: the message box grows with a pasted message without
// any style written from script, which the production CSP may refuse.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer, MAX_ROWS, charsPerLine, composerRows } from "./Composer.tsx";

const render = (value: string) =>
  renderToStaticMarkup(
    createElement(Composer, {
      value,
      onChange: () => {},
      onSend: () => {},
      disabled: false,
      busy: false,
      inputRef: createRef<HTMLTextAreaElement>(),
      onLoadCalendar: async () => {},
      onAddOfficeMessage: () => {},
    }),
  );

describe("composer", () => {
  it("sets its rows from the lines of the text, up to a limit", () => {
    expect(composerRows("")).toBe(1);
    expect(composerRows("one line")).toBe(1);
    expect(composerRows("a\nb\nc")).toBe(3);
    expect(composerRows(Array.from({ length: 30 }, () => "x").join("\n"))).toBe(MAX_ROWS);
    expect(render("Hi Dana,\n\nThis confirms Monday.\n\nFront Desk")).toContain('rows="5"');
    // No inline style in the markup.
    expect(render("a\nb")).not.toContain("style=");
  });

  it("review 2, B5: counts the rows a long line wraps to at the box's width", () => {
    // A 390 px phone: the box is about 230 px wide inside, 27 characters.
    const per = charsPerLine(230);
    expect(per).toBe(27);
    const pasted = "Lantern Hill Clinic: Hi Dana, we can see you Tuesday, November 10 at 2:00 PM or Thursday, November 12 at 10:30 AM.";
    expect(composerRows(pasted)).toBe(1);
    expect(composerRows(pasted, per)).toBe(Math.ceil(pasted.length / per));
    expect(composerRows(`${pasted}\n\nThanks`, per)).toBe(Math.ceil(pasted.length / per) + 2);
    expect(composerRows(pasted.repeat(10), per)).toBe(MAX_ROWS);
    expect(composerRows("short", per)).toBe(1);
  });

  it("writes no style from script anywhere in the page's code", () => {
    const ui = fileURLToPath(new URL("..", import.meta.url));
    const files = (readdirSync(ui, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !/\.test\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const src = readFileSync(`${ui}/${f}`, "utf8");
      expect(src, f).not.toMatch(/\.style\.|style=\{|setAttribute\("style"/);
    }
  });
});
