// D3 templates: the validity table, the fields code fills, and the
// templates withheld for a missing detail.
import { describe, expect, it } from "vitest";
import type { SlotState } from "../src/domain/claim.ts";
import { buildDraft, replyOptions, type ReplyContext } from "../src/reply/draft.ts";
import { TEMPLATES, TEMPLATE_IDS, renderReply } from "../src/reply/templates.ts";
import { projectSlots } from "../src/slots/project.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, ev, intake } from "./helpers.ts";

const USER = "Dana Reyes";

async function contextOf(ids: string[]): Promise<ReplyContext> {
  const service = intake(new EventStore());
  await acceptMessages(service, ids);
  const evidence = service.evidence();
  return { slots: projectSlots({ evidence }).slots, evidence, messages: service.messages(), userName: USER };
}

const pairs = (ctx: ReplyContext) => replyOptions(ctx).options.map((o) => `${o.template} ${o.slotKey}`);

describe("SP3.1 template definitions", () => {
  it("defines the four templates and what each asserts", () => {
    expect(TEMPLATE_IDS.map((id) => [TEMPLATES[id].title, TEMPLATES[id].validStates])).toEqual([
      ["Accept an offered slot", ["offered"]],
      ["Decline and ask for another time", ["offered"]],
      ["Ask whether a slot still stands", ["confirmed", "change_proposed"]],
      ["Keep the original", ["change_proposed"]],
    ]);
  });

  it("renders each template from field values only", () => {
    const f = { office_name: "Office A", date: "Monday 11/16", time: "1:00 PM", location: null, declined_slots: null, user_name: null };
    expect(renderReply("accept_offer", f)).toBe("Hello Office A,\n\nI accept the appointment on Monday 11/16 at 1:00 PM. Please confirm it.\n\nThank you.");
    expect(renderReply("decline_offer", { ...f, office_name: null })).toBe(
      "Hello,\n\nI can't take the appointment on Monday 11/16 at 1:00 PM. Could you offer me another time?\n\nThank you.",
    );
    expect(renderReply("ask_still_stands", { ...f, location: "Suite 2", user_name: USER })).toBe(
      "Hello Office A,\n\nIs my appointment on Monday 11/16 at 1:00 PM at Suite 2 still set? Please let me know.\n\nThank you,\nDana Reyes",
    );
    expect(renderReply("keep_original", { ...f, declined_slots: "Friday 11/13 9:15 AM" })).toContain(
      "I would like to keep my appointment on Monday 11/16 at 1:00 PM. I decline the proposed change to Friday 11/13 9:15 AM.",
    );
  });
});

describe("SP3.2 validity table", () => {
  const T = "2026-11-02T10:00:00-07:00";
  const T2 = "2026-11-03T10:00:00-07:00";
  const D = "2026-11-12";
  const evidenceFor: Record<SlotState, ReturnType<typeof ev>[]> = {
    offered: [ev("a", "offer", D, "10:30", T)],
    requested: [ev("a", "offer", D, "10:30", T), ev("b", "request", D, "10:30", T2, { source_type: "reported_by_user" })],
    confirmed: [ev("a", "confirm", D, "10:30", T)],
    change_proposed: [ev("a", "confirm", D, "10:30", T), ev("b", "move", D, "10:30", T2)],
    canceled: [ev("a", "cancel", D, "10:30", T)],
    declined: [ev("a", "offer", D, "10:30", T), ev("b", "decline", D, "10:30", T2, { source_type: "reported_by_user" })],
  };

  for (const state of Object.keys(evidenceFor) as SlotState[]) {
    it(`offers only the templates whose row allows a ${state} slot`, () => {
      const evidence = evidenceFor[state];
      const slots = projectSlots({ evidence }).slots;
      expect(slots.map((s) => s.state)).toEqual([state]);
      const ctx: ReplyContext = { slots, evidence, messages: [], userName: USER };
      const allowed = TEMPLATE_IDS.filter((t) => TEMPLATES[t].validStates.includes(state));
      expect(replyOptions(ctx).options.map((o) => o.template)).toEqual(allowed);
      for (const t of TEMPLATE_IDS.filter((x) => !allowed.includes(x))) {
        expect(buildDraft(t, slots[0]!.key, ctx)).toEqual({ ok: false, problems: ["template_not_valid_for_state"], missing: [] });
      }
    });
  }

  it("S9: blocks an accept reply for a slot that is not offered", async () => {
    const ctx = await contextOf(["m1", "m2"]);
    expect(ctx.slots.find((s) => s.key === "2026-11-12T10:30")!.state).toBe("confirmed");
    expect(buildDraft("accept_offer", "2026-11-12T10:30", ctx)).toMatchObject({ ok: false, problems: ["template_not_valid_for_state"] });
    // m1 does not offer Wednesday 11/11 3:00 PM, so it is no slot at all.
    expect(buildDraft("accept_offer", "2026-11-11T15:00", ctx)).toMatchObject({ ok: false, problems: ["unknown_slot"] });
    expect(pairs(ctx)).toEqual(["accept_offer 2026-11-10T14:00", "decline_offer 2026-11-10T14:00", "ask_still_stands 2026-11-12T10:30"]);
  });
});

describe("SP3.3 fields filled by code and withheld templates", () => {
  it("demo: the accept template for Monday is filled from the slot, the sender and the case profile", async () => {
    const ctx = await contextOf(["m1", "m2", "m3"]);
    const result = buildDraft("accept_offer", "2026-11-16T13:00", ctx);
    if (!result.ok) throw new Error("expected a draft");
    expect(result.content.text).toBe(
      "Hello Lantern Hill Clinic,\n\nI accept the appointment on Monday 11/16 at 1:00 PM. Please confirm it.\n\nThank you,\nDana Reyes",
    );
    expect(result.content.fields.map((f) => [f.name, f.value, f.sources.map((s) => s.evidenceId)])).toEqual([
      ["office_name", "Lantern Hill Clinic", ["m3-e3"]],
      ["date", "2026-11-16", ["m3-e3"]],
      ["time", "13:00", ["m3-e3"]],
      // m3 states no place for Monday, so the reply names none.
      ["location", null, []],
      ["user_name", USER, [null]],
    ]);
    expect(pairs(ctx)).toEqual([
      "accept_offer 2026-11-10T14:00",
      "decline_offer 2026-11-10T14:00",
      "ask_still_stands 2026-11-12T10:30",
      "keep_original 2026-11-12T10:30",
      "accept_offer 2026-11-13T09:15",
      "decline_offer 2026-11-13T09:15",
      "accept_offer 2026-11-16T13:00",
      "decline_offer 2026-11-16T13:00",
    ]);
  });

  it("keep the original names the proposed change it declines", async () => {
    const ctx = await contextOf(["m2", "m3"]);
    const result = buildDraft("keep_original", "2026-11-12T10:30", ctx);
    if (!result.ok) throw new Error("expected a draft");
    expect(result.content.declines).toEqual(["2026-11-13T09:15", "2026-11-16T13:00"]);
    expect(result.content.text).toContain("I decline the proposed change to Friday 11/13 9:15 AM and Monday 11/16 1:00 PM.");
    expect(result.content.fields.find((f) => f.name === "location")).toMatchObject({
      value: "Lantern Hill Clinic, 400 Elm Street, Suite 2",
      sources: [{ kind: "evidence", evidenceId: "m2-e1" }],
    });
  });

  it("S7: offers no template that needs the missing time", async () => {
    const ctx = await contextOf(["s7-confirm"]);
    expect(ctx.slots.map((s) => [s.key, s.state, s.missing])).toEqual([["2026-11-16", "confirmed", ["time", "location"]]]);
    expect(replyOptions(ctx)).toEqual({
      options: [],
      withheld: [
        { template: "ask_still_stands", title: "Ask whether a slot still stands", slotKey: "2026-11-16", slotLabel: "Monday 11/16, no time", missing: ["time"] },
      ],
    });
    expect(buildDraft("ask_still_stands", "2026-11-16", ctx)).toEqual({ ok: false, problems: ["missing_field"], missing: ["time"] });
  });

  it("S7: withholds accept and decline for an offer with a date and no time", () => {
    const evidence = [ev("a", "offer", "2026-11-20", null, "2026-11-02T10:00:00-07:00")];
    const ctx: ReplyContext = { slots: projectSlots({ evidence }).slots, evidence, messages: [], userName: null };
    expect(replyOptions(ctx).options).toEqual([]);
    expect(replyOptions(ctx).withheld.map((w) => [w.template, w.missing])).toEqual([
      ["accept_offer", ["time"]],
      ["decline_offer", ["time"]],
    ]);
  });

  it("shows imported sender text on one short line", async () => {
    const ctx = await contextOf(["m3"]);
    const message = ctx.messages[0]!;
    const long = { ...message, message: { ...message.message, from: `Lantern\nHill ${"x".repeat(300)}` } };
    const result = buildDraft("accept_offer", "2026-11-16T13:00", { ...ctx, messages: [long] });
    if (!result.ok) throw new Error("expected a draft");
    const office = result.content.fields.find((f) => f.name === "office_name")!.value!;
    expect(office.startsWith("Lantern Hill x")).toBe(true);
    expect(office).toHaveLength(120);
  });
});
