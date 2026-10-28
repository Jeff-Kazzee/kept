// Review 2, B6: focus goes back to the chip by its message id and slot
// key, found again after the thread re-renders.
import { describe, expect, it } from "vitest";
import { chipRef, chipSelectors, findChip } from "./layout.ts";

// A stand-in for the document: answers each selector from a table.
function root(found: Record<string, string[]>) {
  const el = (id: string) => ({ id }) as unknown as HTMLElement;
  return {
    querySelector: (s: string) => (found[s]?.[0] ? el(found[s]![0]!) : null),
    querySelectorAll: (s: string) => (found[s] ?? []).map(el),
  } as unknown as ParentNode;
}

describe("chip focus", () => {
  const ref = { messageId: "cm4", slotKey: "2026-11-16T13:00" };
  const [same, anySlot] = chipSelectors(ref);

  it("finds the same chip by message id and slot key", () => {
    expect(same).toBe('.fact-chip[data-chip-slot="2026-11-16T13:00"][data-chip-message="cm4"]:not(:disabled)');
    expect((findChip(root({ [same!]: ["exact"], [anySlot!]: ["a", "b"] }), ref) as unknown as { id: string }).id).toBe("exact");
  });

  it("falls back to the newest chip for the slot, then to nothing", () => {
    // The streamed turn's chip ("pending") was replaced by the stored one.
    expect((findChip(root({ [anySlot!]: ["older", "newest"] }), ref) as unknown as { id: string }).id).toBe("newest");
    expect(findChip(root({}), ref)).toBeNull();
  });

  it("reads the message id from the chip's data and escapes quotes", () => {
    const el = { dataset: { chipMessage: "pending" } } as unknown as HTMLElement;
    expect(chipRef(el, "2026-11-16T13:00")).toEqual({ messageId: "pending", slotKey: "2026-11-16T13:00" });
    expect(chipRef(undefined, "x")).toBeNull();
    expect(chipSelectors({ messageId: 'a"b', slotKey: "k" })[0]).toContain('data-chip-message="a\\"b"');
  });
});
