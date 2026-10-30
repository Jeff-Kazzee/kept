// Sprint 13C fix round 1, R5 and R8: the reply draft's readback, ticked in
// one mounted card and read in the other, and never carried into a new
// case after Delete case.
import { createElement, Fragment } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import type { ReplyView } from "../../src/reply/types.ts";
import type { AppState } from "../api.ts";
import { installTestDom, mount } from "../test-dom.ts";
import { ReplyCard, ReplyPanel, scopeReadback } from "./ReplyCard.tsx";
import { sessionOwner } from "../App.tsx";

beforeAll(() => {
  installTestDom();
});

const draft = {
  id: "d1",
  template: "accept_offer",
  title: "Accept an offered slot",
  asserts: "You accept the slot and ask the office to confirm it.",
  slotKey: "2026-11-16T13:00",
  slotLabel: "Monday 11/16 1:00 PM",
  origin: "choice",
  questionId: null,
  suggestionId: null,
  fields: [
    { name: "date", label: "Date", value: "2026-11-16", display: "Monday 11/16", sources: [] },
    { name: "time", label: "Time", value: "13:00", display: "1:00 PM", sources: [] },
  ],
  renderedText: "Hello,\n\nI accept the appointment on Monday 11/16 at 1:00 PM. Please confirm it.\n\nThank you.",
  text: "Hello,\n\nI accept the appointment on Monday 11/16 at 1:00 PM. Please confirm it.\n\nThank you.",
  edited: false,
  claimConfirmation: null,
  valid: true,
  problems: [],
  invalidNotice: null,
  createdAt: "2026-11-05T09:00:00.000Z",
} satisfies ReplyView["draft"];

const reply3: ReplyView = { version: 3, options: [], withheld: [], draft, suggestion: null, sent: [] };
const both = (generation: number, reply: ReplyView = reply3) => {
  const state = { generation, case: { reply, profile: { userName: null, version: 0 } } } as unknown as AppState;
  return createElement(
    Fragment,
    null,
    createElement("div", { className: "in-chat" }, createElement(ReplyCard, { draftId: "d1", state, run: async () => {} })),
    createElement("div", { className: "in-panel" }, createElement(ReplyPanel, { reply, run: async () => {}, generation })),
  );
};

describe("sprint 13C fix round 1: one readback for both cards", () => {
  it("R8: ticking a field in the chat's card ticks it in the panel's, and approval waits for every field", async () => {
    const ui = await mount(both(4));
    const box = (where: string, name: string) => ui.find(`.${where} input[name="read-${name}"]`);
    const approve = (where: string) => ui.container.querySelectorAll(`.${where} button`).find((b) => b.textContent.startsWith("Approve"))!;
    await ui.click(box("in-chat", "date"));
    expect(box("in-panel", "date").checked).toBe(true);
    expect(box("in-panel", "time").checked).toBe(false);
    expect(approve("in-panel").disabled).toBe(true);
    await ui.click(box("in-panel", "time"));
    expect(box("in-chat", "time").checked).toBe(true);
    expect(approve("in-chat").disabled).toBe(false);
    expect(approve("in-panel").disabled).toBe(false);
    await ui.unmount();
  });

  it("R5: after Delete case, the same draft id, version and text in the new case starts with no ticks", async () => {
    const before = await mount(both(7));
    await before.click(before.find('.in-chat input[name="read-date"]'));
    expect(before.find('.in-chat input[name="read-date"]').checked).toBe(true);
    await before.unmount();
    const after = await mount(both(8));
    expect(after.find('.in-chat input[name="read-date"]').checked).toBe(false);
    expect(after.find('.in-panel input[name="read-date"]').checked).toBe(false);
    await after.unmount();
  });

  it("H5: a new version of the draft starts the readback empty in both cards", async () => {
    const ui = await mount(both(11));
    await ui.click(ui.find('.in-chat input[name="read-date"]'));
    expect(ui.find('.in-panel input[name="read-date"]').checked).toBe(true);
    await ui.unmount();
    const next = await mount(both(11, { ...reply3, version: 4 }));
    expect(next.find('.in-chat input[name="read-date"]').checked).toBe(false);
    expect(next.find('.in-panel input[name="read-date"]').checked).toBe(false);
    await next.unmount();
  });

  it("N6: a change of session or account clears the ticks in both cards", async () => {
    const { act } = await import("react");
    scopeReadback(sessionOwner({ mode: "hosted", signedIn: true, account: { kind: "user", email: "a.demo@example.com", name: null }, balanceMicros: 0, balance: "$0", expiresAt: 0, passwordMin: 10 }));
    const ui = await mount(both(12));
    await ui.click(ui.find('.in-chat input[name="read-date"]'));
    expect(ui.find('.in-panel input[name="read-date"]').checked).toBe(true);
    // The same account again changes nothing.
    await act(async () => scopeReadback(sessionOwner({ mode: "hosted", signedIn: true, account: { kind: "user", email: "a.demo@example.com", name: null }, balanceMicros: 5, balance: "$0", expiresAt: 1, passwordMin: 10 })));
    expect(ui.find('.in-panel input[name="read-date"]').checked).toBe(true);
    // Another account in the same tab: the same draft id, version and
    // generation start with no ticks.
    await act(async () => scopeReadback(sessionOwner({ mode: "hosted", signedIn: true, account: { kind: "user", email: "b.demo@example.com", name: null }, balanceMicros: 0, balance: "$0", expiresAt: 0, passwordMin: 10 })));
    expect(ui.find('.in-chat input[name="read-date"]').checked).toBe(false);
    expect(ui.find('.in-panel input[name="read-date"]').checked).toBe(false);
    await ui.unmount();
    expect(new Set([sessionOwner(null), sessionOwner({ mode: "local" }), sessionOwner({ mode: "hosted", signedIn: false, passwordMin: 10 })]).size).toBe(3);
  });
});
