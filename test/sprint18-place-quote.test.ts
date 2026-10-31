// Sprint 18 fix round 1, item 8 (the coordinator's live run): the reply
// card's Place field showed the time's quote, "Tuesday, November 10 at
// 2:00 PM", as its source. It now quotes the place's own words from the
// office's message, "our Elm Street office".
import { describe, expect, it } from "vitest";
import { NO_PLACE_QUOTE_SOURCE, placeWords, slotFields, type ReplyContext } from "../src/reply/draft.ts";
import { projectSlots } from "../src/slots/project.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, intake } from "./helpers.ts";

async function contextOf(ids: string[]): Promise<ReplyContext> {
  const service = intake(new EventStore());
  await acceptMessages(service, ids);
  const evidence = service.evidence();
  return { slots: projectSlots({ evidence }).slots, evidence, messages: service.messages(), userName: "Dana Reyes" };
}

describe("sprint 18 fix round 1, item 8: the Place field quotes the place", () => {
  it("the demo's Tuesday offer names our Elm Street office as the place's source, not the time", async () => {
    const ctx = await contextOf(["m1"]);
    const slot = ctx.slots.find((s) => s.key === "2026-11-10T14:00")!;
    expect(slot.location).not.toBeNull();
    const place = slotFields("ask_still_stands", slot, ctx).fields.find((f) => f.name === "location")!;
    expect(place.sources.map((s) => s.text)).toEqual(["Quote: “our Elm Street office”"]);
    expect(place.sources[0]!.text).not.toMatch(/November|2:00/);
    // The date and time keep their own source.
    const date = slotFields("ask_still_stands", slot, ctx).fields.find((f) => f.name === "date")!;
    expect(date.sources[0]!.text).toContain("Tuesday");
  });

  it("finds the place word for word, keeps a leading our or the, and gives no quote when the message does not name it", () => {
    expect(placeWords("Elm Street office", "Thursday at 10:30 AM at our Elm Street office. Reply 1 or 2.")).toBe("our Elm Street office");
    expect(placeWords("elm street office", "at the Elm   Street office")).toBe("the Elm Street office");
    expect(placeWords("Suite 2", "Come to Suite 2 on Monday")).toBe("Suite 2");
    expect(placeWords("Suite 2", "Come to Suite 20 on Monday")).toBeNull();
    expect(placeWords("Elm Street office", "Tuesday, November 10 at 2:00 PM")).toBeNull();
    expect(placeWords("Elm Street office", null)).toBeNull();
    expect(NO_PLACE_QUOTE_SOURCE).toBe("From the message that named this place");
  });
});
