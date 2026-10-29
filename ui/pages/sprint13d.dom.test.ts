// Sprint 13D (0017): E5, Delete case says it finished.
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "../api.ts";
import { installTestDom, mount, TestElement, TestEvent } from "../test-dom.ts";
import { CASE_DELETED_TEXT, DeleteCasePanel } from "./Settings.tsx";

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
