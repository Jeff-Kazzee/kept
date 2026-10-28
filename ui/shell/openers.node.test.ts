// 0015, S8: Settings left the schedule panel's tabs, and every way in moved
// with it. The composer's model pill and the setup notice open Connections,
// the setup toast opens Connections, a credits toast and Open Usage open
// Usage, and nothing opens a removed tab. Read from the source the build
// ships, and from the functions the shell calls.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fromPackage } from "../../src/paths.ts";
import { AgentContext, DEFAULT_AGENT } from "../agent/AgentContext.tsx";
import { ApiError } from "../api.ts";
import { TABS } from "../schedule/SchedulePanel.tsx";
import { setupLink } from "./shell.ts";

const read = (f: string) => readFileSync(fromPackage(f), "utf8");

function sources(dir: string): string[] {
  return readdirSync(fromPackage(dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    if (statSync(fromPackage(rel)).isDirectory()) return sources(rel);
    return /\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) ? [rel] : [];
  });
}

describe("S8: every way into the old Settings tab moved", () => {
  it("the schedule panel has three tabs, and Settings is not one", () => {
    expect(TABS.map((t) => t.id)).toEqual(["schedule", "checklist", "activity"]);
  });

  it("no page source opens the Settings tab or names openSettings", () => {
    for (const f of sources("ui")) {
      const text = read(f);
      expect(text, f).not.toMatch(/openSettings|openPanel\("settings"\)|tab-settings|tab === "settings"/);
    }
  });

  it("the model pill and the setup notice open Connections, and the usage notice opens Usage", () => {
    const picker = read("ui/agent/ModelPicker.tsx");
    expect(picker).toMatch(/menu\.choose\(openConnections\)/);
    const chat = read("ui/chat/ChatView.tsx");
    expect(chat).toMatch(/function SetupNotice[\s\S]*?const \{ openConnections \} = useAgent\(\);[\s\S]*?onClick=\{openConnections\}[\s\S]*?Open Connections/);
    expect(chat).toMatch(/function UsageNotice[\s\S]*?const \{ openUsage \} = useAgent\(\);[\s\S]*?onClick=\{openUsage\}[\s\S]*?Open Usage/);
  });

  it("the shell gives openConnections and openUsage their views, and each toast link opens its view", () => {
    const app = read("ui/App.tsx");
    expect(app).toContain('openConnections: () => openView("connections"),');
    expect(app).toContain('openUsage: () => openView("usage"),');
    expect(app).toMatch(/openView\(t\.link!\);[\s\S]*?\{t\.link === "usage" \? "Open Usage" : "Open Connections"\}/);
    expect(setupLink(new ApiError(503, { error: "provider_not_ready" }))).toBe("connections");
    expect(setupLink(new ApiError(402, { error: "credits_exhausted" }))).toBe("usage");
    expect(setupLink(new ApiError(409, { error: "version_conflict" }))).toBeUndefined();
    expect(setupLink(new Error("x"))).toBeUndefined();
  });

  it("the model pill's menu names Connections", async () => {
    const { ModelPicker } = await import("../agent/ModelPicker.tsx");
    const html = renderToStaticMarkup(createElement(AgentContext.Provider, { value: DEFAULT_AGENT }, createElement(ModelPicker, { fallback: "No model set" })));
    expect(html).toContain("Provider and sign-in, in Connections");
  });
});
