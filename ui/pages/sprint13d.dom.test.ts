// Sprint 13D (0017): E5, Delete case says it finished.
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "../api.ts";
import { installTestDom, mount, TestElement, TestEvent } from "../test-dom.ts";
import { CASE_DELETED_TEXT, DeleteCasePanel, caseDeletedShown } from "./Settings.tsx";

beforeAll(() => {
  const doc = installTestDom();
  // react-dom checks this when it loads to listen for "input", as a
  // browser has it.
  (doc as unknown as { oninput: null }).oninput = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Types into an input as a person does, past React's value tracker.
async function type(el: TestElement, text: string) {
  const { act } = await import("react");
  // A browser reads an input without a type as a text input. The test DOM
  // reads the attribute, so it is set.
  if (!el.getAttribute("type")) el.setAttribute("type", "text");
  await act(async () => {
    Object.getOwnPropertyDescriptor(TestElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new TestEvent("input", { bubbles: true }));
  });
}

describe("sprint 13D, E5: Delete case says it finished", () => {
  it("runs onDeleted once the case is deleted, and the page's sentence names what went and what stays", async () => {
    const del = vi.spyOn(api, "deleteCase").mockResolvedValue({ erased: 12 });
    const onDeleted = vi.fn();
    const view = await mount(createElement(DeleteCasePanel, { version: 7, run: async (a: () => Promise<unknown>) => void (await a()), onDeleted }));
    await type(view.find("#delete-confirm"), "DELETE");
    await view.click(view.button("Delete this case and all its data permanently"));
    expect(del).toHaveBeenCalledWith(7, "DELETE");
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(CASE_DELETED_TEXT).toBe("The case was deleted. Its messages, facts, replies, chat and activity are erased. Events it added to Google Calendar stay there.");
    await view.unmount();
  });

  it("says nothing when the delete failed", async () => {
    vi.spyOn(api, "deleteCase").mockRejectedValue(new Error("busy"));
    const onDeleted = vi.fn();
    const run = async (a: () => Promise<unknown>) => {
      try {
        await a();
      } catch {
        // The page shows the error as a toast.
      }
    };
    const view = await mount(createElement(DeleteCasePanel, { version: 7, run, onDeleted }));
    await type(view.find("#delete-confirm"), "DELETE");
    await view.click(view.button("Delete this case and all its data permanently"));
    expect(onDeleted).not.toHaveBeenCalled();
    await view.unmount();
  });
});

describe("sprint 13D fix round 1, R7: the Delete case sentence stays on the page", () => {
  it("renders in the panel while the new case is empty, as a status", async () => {
    const view = await mount(createElement(DeleteCasePanel, { version: 0, run: async () => {}, deleted: true }));
    const status = view.container.querySelector('[role="status"]')!;
    expect(status.textContent).toBe(CASE_DELETED_TEXT);
    await view.unmount();
    const before = await mount(createElement(DeleteCasePanel, { version: 4, run: async () => {}, deleted: false }));
    expect(before.container.textContent).not.toContain("The case was deleted.");
    await before.unmount();
  });

  it("shows from the new case's first read until the next thing done in it", () => {
    // Before the page reads the new case, the old one is still shown.
    expect(caseDeletedShown(3, { generation: 3, caseVersion: 41 })).toBe(false);
    // The new, empty case.
    expect(caseDeletedShown(3, { generation: 4, caseVersion: 0 })).toBe(true);
    // The next write in it, by the person, the chat or an agent.
    expect(caseDeletedShown(3, { generation: 4, caseVersion: 1 })).toBe(false);
    expect(caseDeletedShown(null, { generation: 4, caseVersion: 0 })).toBe(false);
  });
});
