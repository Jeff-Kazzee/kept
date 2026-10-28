// SP12.7: Lighthouse flagged `<aside role="dialog">` on the phone sheet,
// because an aside may not be a dialog. The schedule panel is a div that
// is the complementary landmark beside the chat and a modal dialog while
// it is the open sheet. The production build is audited with Lighthouse
// for mobile and desktop (docs/decisions/0013-failure-testing.md).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromPackage } from "../src/paths.ts";

describe("SP12.7: the schedule panel's markup", () => {
  const app = readFileSync(fromPackage("ui/App.tsx"), "utf8");
  it("gives no aside a dialog role", () => {
    expect(app).not.toMatch(/<aside\b/);
    for (const f of ["ui/schedule/SchedulePanel.tsx", "ui/chat/ChatView.tsx", "ui/chat/ImportSheet.tsx"]) {
      expect(readFileSync(fromPackage(f), "utf8"), f).not.toMatch(/<aside[^>]*role=/);
    }
  });
  it("is a div that is the complementary landmark, and a modal dialog only as the open sheet", () => {
    const panel = /<div\s+id="schedule-panel"[^>]*>/.exec(app)?.[0] ?? "";
    expect(panel).toContain('role={sheetModal ? "dialog" : "complementary"}');
    expect(panel).toContain("aria-modal={sheetModal || undefined}");
    expect(panel).toContain('aria-label="Schedule"');
  });
});
