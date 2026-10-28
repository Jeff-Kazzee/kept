// 0015, S8, and review round 1 (R1, R2, R4): every way into the old
// Settings tab, rendered and clicked. The composer's model pill and the
// setup notice open Connections, Open Usage opens Usage, and each toast
// link opens its view. The openers come from openersFor, as the shell
// builds them, with a recorder in place of the shell's openView. The
// toasts are inert while the drawer or the schedule sheet is modal.
import { createElement, type ReactNode } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { installTestDom, mount } from "../test-dom.ts";
import { AgentContext, DEFAULT_AGENT, type AgentState } from "../agent/AgentContext.tsx";
import { ApiError } from "../api.ts";
import { TABS, railLabel } from "../schedule/SchedulePanel.tsx";
import { openersFor, setupLink, shellModes, type ShellFlags, type View } from "./shell.ts";
import { Toasts } from "./Toasts.tsx";

beforeAll(() => {
  installTestDom();
});

// The agent state the shell gives every part, with the views recorded.
function recorded() {
  const views: View[] = [];
  const agent: AgentState = { ...DEFAULT_AGENT, ...openersFor((v) => views.push(v)) };
  const wrap = (node: ReactNode) => createElement(AgentContext.Provider, { value: agent }, node);
  return { views, wrap };
}

describe("S8: the openers, clicked", () => {
  it("the model pill's menu opens, and its Provider and sign-in item opens Connections", async () => {
    const { ModelPicker } = await import("../agent/ModelPicker.tsx");
    const { views, wrap } = recorded();
    const ui = await mount(wrap(createElement(ModelPicker, { fallback: "No model set" })));
    const menu = ui.find(".menu");
    expect(menu.shown).toBe(false);
    await ui.click(ui.find(".model-pill"));
    expect(menu.shown).toBe(true);
    await ui.click(ui.button("Provider and sign-in, in Connections"));
    expect(views).toEqual(["connections"]);
    expect(menu.shown).toBe(false);
    await ui.unmount();
  });

  it("the setup notice's Open Connections opens Connections", async () => {
    const { SetupNotice } = await import("../chat/ChatView.tsx");
    const { views, wrap } = recorded();
    const ui = await mount(wrap(createElement(SetupNotice, { text: "The assistant needs a Meta Model API key or Sign in with ChatGPT. Add one in Connections." })));
    await ui.click(ui.button("Open Connections"));
    expect(views).toEqual(["connections"]);
    await ui.unmount();
  });

  it("the usage notice's Open Usage opens Usage when the credit ran out, and offers nothing for other stops", async () => {
    const { UsageNotice } = await import("../chat/ChatView.tsx");
    const { views, wrap } = recorded();
    const ui = await mount(wrap(createElement(UsageNotice, { text: "Your usage credit has run out.", credits: true })));
    await ui.click(ui.button("Open Usage"));
    expect(views).toEqual(["usage"]);
    await ui.unmount();
    const other = await mount(wrap(createElement(UsageNotice, { text: "The site reached its daily limit.", credits: false })));
    expect(other.container.querySelectorAll("button")).toHaveLength(0);
    await other.unmount();
  });

  it("each toast link opens its view and dismisses its toast, and an error gets the link its code calls for", async () => {
    const opened: View[] = [];
    const dismissed: number[] = [];
    const connections = setupLink(new ApiError(503, { error: "provider_not_ready" }));
    const usage = setupLink(new ApiError(402, { error: "credits_exhausted" }));
    expect([connections, usage, setupLink(new ApiError(409, { error: "version_conflict" })), setupLink(new Error("x"))]).toEqual(["connections", "usage", undefined, undefined]);
    const toasts = [
      { id: 1, kind: "error" as const, text: "No provider is ready.", link: connections },
      { id: 2, kind: "error" as const, text: "Your usage credit has run out.", link: usage },
      { id: 3, kind: "info" as const, text: "Loaded the demo calendar." },
    ];
    const ui = await mount(createElement(Toasts, { toasts, inert: false, onDismiss: (id: number) => dismissed.push(id), onOpen: (v: View) => opened.push(v) }));
    await ui.click(ui.button("Open Connections"));
    await ui.click(ui.button("Open Usage"));
    expect(opened).toEqual(["connections", "usage"]);
    expect(dismissed).toEqual([1, 2]);
    // The info toast has only Dismiss.
    expect(ui.container.querySelectorAll(".toast")[2]!.querySelectorAll("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Dismiss"]);
    await ui.unmount();
  });

  it("the schedule panel has three tabs, and the folded rail's Schedule button names the waiting count", () => {
    expect(TABS.map((t) => t.id)).toEqual(["schedule", "checklist", "activity"]);
    expect(railLabel(TABS[0]!, 3)).toBe("Open Schedule, 3 waiting for you");
    expect(railLabel(TABS[0]!, 0)).toBe("Open Schedule");
    expect(railLabel(TABS[2]!, 3)).toBe("Open Activity");
  });
});

describe("R1: the keyboard stays inside a modal", () => {
  const base: ShellFlags = { laptop: true, phone: false, sheetOpen: false, drawerOpen: false, railed: false, view: "case" };

  it("with the phone drawer open, everything but the sidebar is inert, the toasts included", () => {
    const m = shellModes({ ...base, laptop: false, phone: true, drawerOpen: true });
    expect(m.drawerModal).toBe(true);
    expect(m.inert).toEqual({ sidebar: false, topbar: true, chat: true, rail: false, panel: true, page: true, toasts: true });
  });

  it("with the schedule sheet open on a tablet or a phone, everything but the panel is inert, the toasts included", () => {
    for (const phone of [false, true]) {
      const m = shellModes({ ...base, laptop: false, phone, sheetOpen: true });
      expect(m.sheetModal).toBe(true);
      expect(m.inert).toEqual({ sidebar: true, topbar: true, chat: true, rail: false, panel: false, page: false, toasts: true });
    }
  });

  it("on a laptop nothing is modal, and a page makes the case inert under it but not the toasts", () => {
    expect(Object.values(shellModes(base).inert).some(Boolean)).toBe(false);
    const page = shellModes({ ...base, view: "connections" });
    expect(page.inert).toEqual({ sidebar: false, topbar: false, chat: true, rail: true, panel: true, page: false, toasts: false });
  });

  it("inert toasts cannot be reached or clicked", async () => {
    const opened: View[] = [];
    const ui = await mount(createElement(Toasts, { toasts: [{ id: 1, kind: "error", text: "No provider is ready.", link: "connections" }], inert: true, onDismiss: () => {}, onOpen: (v: View) => opened.push(v) }));
    expect(ui.find(".toasts").inert).toBe(true);
    const buttons = ui.container.querySelectorAll("button");
    expect(buttons.length).toBe(2);
    expect(buttons.some((b) => b.tabbable)).toBe(false);
    await ui.click(ui.button("Open Connections"));
    expect(opened).toEqual([]);
    await ui.unmount();
  });
});
