// Review 2, B6: focus goes back to the chip by its message id and slot
// key, found again after the thread re-renders.
import { describe, expect, it } from "vitest";
import { chipRef, chipSelectors, findChip, focusSoon } from "./layout.ts";

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

// 0015: a sheet or the drawer that just opened refuses focus for a frame or
// two while it slides in, so focus is tried again each frame.
describe("focusSoon", () => {
  const frames = () => {
    const queue: Array<() => void> = [];
    globalThis.requestAnimationFrame = ((f: () => void) => queue.push(f)) as typeof requestAnimationFrame;
    return () => {
      let n = 0;
      while (queue.length > 0 && n++ < 100) queue.shift()!();
      return n;
    };
  };

  it("tries again until the element takes focus", () => {
    const run = frames();
    let tries = 0;
    const el = { focus: () => (tries++ >= 2 ? (doc.activeElement = el) : undefined) } as unknown as HTMLElement;
    const doc = { activeElement: null as unknown };
    globalThis.document = doc as unknown as Document;
    focusSoon(() => el);
    expect(run()).toBe(3);
    expect(doc.activeElement).toBe(el);
  });

  it("gives up after its frames, and does nothing without an element", () => {
    const run = frames();
    globalThis.document = { activeElement: null } as unknown as Document;
    let tries = 0;
    focusSoon(() => ({ focus: () => void tries++ }) as unknown as HTMLElement, 4);
    run();
    expect(tries).toBe(5);
    focusSoon(() => null);
    expect(run()).toBe(1);
  });
});

