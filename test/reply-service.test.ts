// D3 reply commands: drafts, edits, readback, approval and the claims
// approval records. Every write states the expected version of the reply
// stream.
import { describe, expect, it } from "vitest";
import { CaseService } from "../src/case/service.ts";
import type { CaseView } from "../src/case/types.ts";
import { RecordedModelClient, readRecording, type Recording } from "../src/model/recorded.ts";
import { fromPackage } from "../src/paths.ts";
import { checkReply } from "../src/reply/suggest.ts";
import { ReplyService } from "../src/reply/service.ts";
import { draftValidity } from "../src/reply/view.ts";
import { EventStore, StaleEditError } from "../src/store/event-log.ts";
import { acceptMessages, intake } from "./helpers.ts";

const NOW = "2026-11-05T09:00:00.000Z";

async function setup(ids: string[], overrides: Recording[] = []) {
  const store = new EventStore();
  const service = intake(store);
  await acceptMessages(service, ids);
  const client = RecordedModelClient.withOverrides(overrides, RecordedModelClient.fromDirectory());
  const kase = new CaseService(store, service, client, { now: () => NOW, userName: "Dana Reyes" });
  const reply = new ReplyService(store, kase, client, { now: () => NOW });
  return { store, intake: service, kase, reply, client };
}

const states = (view: CaseView) => view.slots.map((s) => [s.key, s.stateLabel]);
const allFields = (view: CaseView) => view.reply.draft!.fields.map((f) => f.name);
const replyEvents = (store: EventStore) => store.readStream("reply").map((e) => e.type);

describe("SP3.7 approval records what the template asserts", () => {
  it("demo: Dana picks Monday, reads back the fields, approves, and the simulated send is labeled", async () => {
    const { kase, reply, store, intake: service } = await setup(["m1", "m2", "m3"]);
    const asked = await kase.askNext(0);
    const drafted = kase.answer("q1", "request:2026-11-16T13:00", asked.questionsVersion, asked.reply.version);
    expect(states(drafted)).toEqual(states(asked));
    const draft = drafted.reply.draft!;
    expect(draft).toMatchObject({
      template: "accept_offer",
      title: "Accept an offered slot",
      asserts: "You accept the slot and ask the office to confirm it.",
      slotLabel: "Monday 11/16 1:00 PM",
      origin: "choice",
      edited: false,
      valid: true,
      text: "Hello Lantern Hill Clinic,\n\nI accept the appointment on Monday 11/16 at 1:00 PM. Please confirm it.\n\nThank you,\nDana Reyes",
    });
    expect(draft.fields.map((f) => [f.label, f.display])).toEqual([
      ["Office", "Lantern Hill Clinic"],
      ["Date", "Monday 11/16"],
      ["Time", "1:00 PM"],
      ["Place", null],
      ["Your name", "Dana Reyes"],
    ]);

    const view = reply.approve(draft.id, allFields(drafted), drafted.reply.version);
    expect(states(view)).toEqual([
      ["2026-11-10T14:00", "Offered · office message"],
      ["2026-11-12T10:30", "Confirmed · office message, change proposed"],
      ["2026-11-13T09:15", "Offered · office message"],
      ["2026-11-16T13:00", "Requested · reported by you"],
    ]);
    expect(view.reply).toMatchObject({
      draft: null,
      sent: [{ draftId: "d1", template: "accept_offer", slotKey: "2026-11-16T13:00", text: draft.text, edited: false, evidenceIds: ["reply-d1-1"], simulated: true }],
    });
    expect(service.evidenceItem("reply-d1-1")).toMatchObject({
      origin: "reply",
      status: "accepted",
      messageId: null,
      claim: { claim_type: "request", slot: { date: "2026-11-16", time: "13:00", location: null }, source_type: "reported_by_user", quote: "Approved reply: I accept Monday 11/16 1:00 PM" },
      reply: { draft_id: "d1", index: 0 },
    });
    expect(replyEvents(store)).toEqual(["reply_drafted", "reply_approved", "reply_send_simulated"]);
    // S12: the send adds no message.
    expect(service.messages().map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("R-a: a decline reply makes the slot declined, reported by you", async () => {
    const { kase, reply } = await setup(["m1"]);
    const started = reply.start("decline_offer", "2026-11-10T14:00", 0);
    expect(started.reply.draft!.text).toContain("I can't take the appointment on Tuesday 11/10 at 2:00 PM at Elm Street office.");
    const view = reply.approve("d1", allFields(started), 1);
    expect(states(view)).toEqual([
      ["2026-11-10T14:00", "Declined · reported by you"],
      ["2026-11-12T10:30", "Offered · office message"],
    ]);
    expect(kase.view().reply.options.map((o) => `${o.template} ${o.slotKey}`)).toEqual(["accept_offer 2026-11-12T10:30", "decline_offer 2026-11-12T10:30"]);
  });

  it("R-a: keep the original declines the offered change, and the original returns to plain confirmed", async () => {
    const { kase, reply } = await setup(["m2", "s2-offer"]);
    const asked = await kase.askNext(0);
    expect(asked.question!.choices.map((c) => c.label)).toEqual(["Request Wednesday 11/11 3:00 PM", "Keep Thursday 11/12 10:30 AM", "Not sure yet"]);
    const drafted = kase.answer("q1", "keep", 1, 0);
    expect(states(drafted)).toEqual(states(asked));
    expect(drafted.reply.draft).toMatchObject({ template: "keep_original", slotKey: "2026-11-12T10:30", origin: "choice" });
    expect(drafted.reply.draft!.text).toContain("I decline the proposed change to Wednesday 11/11 3:00 PM.");
    const view = reply.approve("d1", allFields(drafted), 1);
    expect(states(view)).toEqual([
      ["2026-11-11T15:00", "Declined · reported by you"],
      ["2026-11-12T10:30", "Confirmed · office message"],
    ]);
    expect(view.conflicts).toEqual([]);
  });

  it("R-a: keep the original after a move declines the offers, and the move still proposes a change", async () => {
    const { reply } = await setup(["m2", "m3"]);
    const started = reply.start("keep_original", "2026-11-12T10:30", 0);
    const view = reply.approve("d1", allFields(started), 1);
    expect(states(view)).toEqual([
      ["2026-11-12T10:30", "Confirmed · office message, change proposed"],
      ["2026-11-13T09:15", "Declined · reported by you"],
      ["2026-11-16T13:00", "Declined · reported by you"],
    ]);
    expect(view.reply.sent[0]!.evidenceIds).toEqual(["reply-d1-1", "reply-d1-2"]);
  });

  it("R-a: asking whether a slot still stands records the draft and the send only", async () => {
    const { reply, store, intake: service } = await setup(["m2", "m3"]);
    const started = reply.start("ask_still_stands", "2026-11-12T10:30", 0);
    expect(started.reply.draft!.text).toContain("Is my appointment on Thursday 11/12 at 10:30 AM at Lantern Hill Clinic, 400 Elm Street, Suite 2 still set?");
    const count = service.evidence().length;
    const view = reply.approve("d1", allFields(started), 1);
    expect(states(view)).toEqual(states(started));
    expect(service.evidence()).toHaveLength(count);
    expect(view.reply.sent).toMatchObject([{ template: "ask_still_stands", evidenceIds: [] }]);
    expect(replyEvents(store)).toEqual(["reply_drafted", "reply_approved", "reply_send_simulated"]);
  });
});

describe("SP3.5 readback and checks before approval", () => {
  it("refuses approval until every field is read back, and writes nothing", async () => {
    const { reply, store } = await setup(["m1"]);
    const started = reply.start("accept_offer", "2026-11-10T14:00", 0);
    const count = store.readAll().length;
    expect(() => reply.approve("d1", ["date", "time"], 1)).toThrow(/Read back every field/);
    expect(() => reply.approve("d1", [...allFields(started), "extra"], 1)).toThrow(/Read back every field/);
    expect(() => reply.approve("d1", allFields(started), 0)).toThrow(StaleEditError);
    expect(store.readAll()).toHaveLength(count);
  });

  it("refuses approval once the case no longer matches the draft", async () => {
    const { kase, reply, intake: service } = await setup(["m2", "m3"]);
    const started = reply.start("accept_offer", "2026-11-16T13:00", 0);
    // m4 confirms Monday, so an accept reply no longer fits it.
    await acceptMessages(service, ["m4"]);
    expect(kase.view().reply.draft).toMatchObject({ id: "d1", valid: false, problems: ["template_not_valid_for_state"] });
    expect(() => reply.approve("d1", allFields(started), 1)).toThrow(/case changed/);
  });

  it("refuses approval when a field value changed since the draft", async () => {
    const { kase, reply, intake: service } = await setup(["m1"]);
    const started = reply.start("accept_offer", "2026-11-12T10:30", 0);
    expect(started.reply.draft!.fields.find((f) => f.name === "location")!.value).toBe("Elm Street office");
    // m2 gives a more detailed place for Thursday and also confirms it.
    await acceptMessages(service, ["m2"]);
    expect(kase.view().reply.draft).toMatchObject({ valid: false });
    expect(() => reply.approve("d1", allFields(started), 1)).toThrow(/case changed/);
  });

  it("treats a stored field value that differs from the case as a changed case", async () => {
    const { kase, reply } = await setup(["m1"]);
    reply.start("accept_offer", "2026-11-12T10:30", 0);
    const record = kase.replyState().log.drafts[0]!;
    const changed = { ...record, fields: record.fields.map((f) => (f.name === "location" ? { ...f, value: "Other place" } : f)) };
    expect(draftValidity(record, kase.replyState().context)).toEqual({ valid: true, problems: [] });
    expect(draftValidity(changed, kase.replyState().context)).toEqual({ valid: false, problems: ["case_changed"] });
  });

  it("S9: blocks a reply whose template the slot's state does not allow, or whose slot is unknown", async () => {
    const { reply, store } = await setup(["m1", "m2"]);
    expect(() => reply.start("accept_offer", "2026-11-12T10:30", 0)).toThrow(/Code blocked this reply: template_not_valid_for_state/);
    expect(() => reply.start("accept_offer", "2026-11-11T15:00", 0)).toThrow(/Code blocked this reply: unknown_slot/);
    expect(() => reply.start("confirm_for_me", "2026-11-10T14:00", 0)).toThrow(/No reply template/);
    expect(replyEvents(store)).toEqual([]);
  });

  it("S7: blocks a template that needs the missing time", async () => {
    const { reply, kase } = await setup(["s7-confirm"]);
    expect(kase.view().reply.options).toEqual([]);
    expect(() => reply.start("ask_still_stands", "2026-11-16", 0)).toThrow(/missing_field/);
  });
});

describe("SP3.6 edits and R-b drafts as events", () => {
  it("labels an edit and keeps the label after the text is changed back", async () => {
    const { reply, store } = await setup(["m1"]);
    const started = reply.start("accept_offer", "2026-11-10T14:00", 0);
    const rendered = started.reply.draft!.text;
    const edited = reply.edit("d1", `${rendered}\nI will arrive early.`, 1);
    expect(edited.reply.draft).toMatchObject({ edited: true, renderedText: rendered, text: `${rendered}\nI will arrive early.`, valid: true });
    const back = reply.edit("d1", rendered, 2);
    expect(back.reply.draft).toMatchObject({ edited: true, text: rendered });
    expect(() => reply.edit("d1", rendered, 3)).toThrow(/did not change/);
    expect(() => reply.edit("d1", "   ", 3)).toThrow(/empty/);
    expect(() => reply.edit("d1", "x".repeat(2001), 3)).toThrow(/longer than/);
    const view = reply.approve("d1", allFields(back), 3);
    expect(view.reply.sent[0]).toMatchObject({ edited: true, text: rendered });
    expect(replyEvents(store)).toEqual(["reply_drafted", "reply_edited", "reply_edited", "reply_approved", "reply_send_simulated"]);
  });

  it("keeps one open draft: a new draft discards the open one in the same write", async () => {
    const { reply, store } = await setup(["m1"]);
    reply.start("accept_offer", "2026-11-10T14:00", 0);
    const second = reply.start("accept_offer", "2026-11-12T10:30", 1);
    expect(second.reply).toMatchObject({ version: 3, draft: { id: "d2", slotKey: "2026-11-12T10:30" } });
    expect(store.readStream("reply").map((e) => [e.type, (e.data as { draft_id: string }).draft_id])).toEqual([
      ["reply_drafted", "d1"],
      ["reply_discarded", "d1"],
      ["reply_drafted", "d2"],
    ]);
    expect(() => reply.approve("d1", ["date"], 3)).toThrow(/not open/);
    const discarded = reply.discard("d2", 3);
    expect(discarded.reply.draft).toBeNull();
    expect(() => reply.discard("d2", 4)).toThrow(/not open/);
    // A discarded edit label goes with its draft.
    expect(reply.start("accept_offer", "2026-11-12T10:30", 4).reply.draft).toMatchObject({ id: "d3", edited: false });
  });

  it("a choice tap replaces an open draft through a discard event", async () => {
    const { kase, reply, store } = await setup(["m2", "m3"]);
    reply.start("ask_still_stands", "2026-11-12T10:30", 0);
    await kase.askNext(0);
    expect(() => kase.answer("q1", "request:2026-11-13T09:15", 1, 0)).toThrow(StaleEditError);
    const view = kase.answer("q1", "request:2026-11-13T09:15", 1, 1);
    expect(view.reply.draft).toMatchObject({ id: "d2", template: "accept_offer", slotKey: "2026-11-13T09:15" });
    expect(replyEvents(store)).toEqual(["reply_drafted", "reply_discarded", "reply_drafted"]);
  });
});

const fault = (name: string) => readRecording(fromPackage(`fixtures/recordings/faults/${name}.json`));

describe("SP3.4 the model picks a template and a slot, and code checks it", () => {
  it("demo: a valid pick opens a draft that code builds, and the model output stays visible", async () => {
    const { reply, client, kase } = await setup(["m1", "m2", "m3"]);
    const before = states(kase.view());
    const view = await reply.suggest("I want Monday.", 0);
    expect(states(view)).toEqual(before);
    expect(view.reply.draft).toMatchObject({ id: "d1", template: "accept_offer", slotKey: "2026-11-16T13:00", origin: "model", suggestionId: "s1", valid: true });
    expect(view.reply.suggestion).toMatchObject({
      id: "s1",
      intent: "I want Monday.",
      outcome: "valid",
      model: "muse-spark-1.3",
      effort: "low",
      attempts: [{ attempt: 1, outcome: "valid", problems: [] }],
      outputs: [{ template: "accept_offer", slot_id: "2026-11-16T13:00", fields: { date: "2026-11-16", time: "13:00", location: null } }],
    });
    const call = client.calls.at(-1)!;
    expect(call).toMatchObject({ key: "reply-df1ce4b1", effort: "low", body: { store: false, text: { format: { name: "reply_template" } } } });
    // The model sees slots and templates, never message text.
    expect(call.body.input).not.toContain("insurance card");
    expect(JSON.parse(call.body.input)).toMatchObject({ note: "I want Monday.", slots: [{ id: "2026-11-10T14:00", state: "offered" }, {}, {}, {}] });
  });

  for (const [note, template, slot] of [
    ["Friday does not work for me. Please offer another time.", "decline_offer", "2026-11-13T09:15"],
    ["Is my Thursday visit still on?", "ask_still_stands", "2026-11-12T10:30"],
    ["I want to keep Thursday.", "keep_original", "2026-11-12T10:30"],
  ] as const) {
    it(`picks ${template} for "${note}"`, async () => {
      const { reply } = await setup(["m1", "m2", "m3"]);
      expect((await reply.suggest(note, 0)).reply.draft).toMatchObject({ template, slotKey: slot, origin: "model" });
    });
  }

  it("S9: blocks a pick of the accept template for a confirmed slot, then falls back to manual entry", async () => {
    const { reply, store } = await setup(["m1", "m2"], [fault("reply-not-valid-for-state")]);
    const view = await reply.suggest("I accept Thursday.", 0);
    expect(view.reply.draft).toBeNull();
    expect(view.reply.suggestion).toMatchObject({
      outcome: "manual_needed",
      template: null,
      slotKey: null,
      attempts: [{ problems: ["template_not_valid_for_state"] }, { problems: ["template_not_valid_for_state"] }],
      outputs: [{ template: "accept_offer", slot_id: "2026-11-12T10:30" }, { template: "accept_offer", slot_id: "2026-11-12T10:30" }],
    });
    // Manual entry: the user picks from the options code offers.
    expect(view.reply.options.map((o) => `${o.template} ${o.slotKey}`)).toEqual([
      "accept_offer 2026-11-10T14:00",
      "decline_offer 2026-11-10T14:00",
      "ask_still_stands 2026-11-12T10:30",
    ]);
    expect(replyEvents(store)).toEqual(["reply_suggested"]);
    expect(reply.start("ask_still_stands", "2026-11-12T10:30", 1).reply.draft).toMatchObject({ origin: "manual" });
  });

  it("S9: blocks a pick of a slot that no message offers", async () => {
    const { reply } = await setup(["m1"], [fault("reply-unknown-slot")]);
    const view = await reply.suggest("Please accept Wednesday at 3:00 PM.", 0);
    expect(view.reply).toMatchObject({ draft: null, suggestion: { outcome: "manual_needed", attempts: [{ problems: ["unknown_slot"] }, { problems: ["unknown_slot"] }] } });
  });

  it("R-c: rejects a proposed field value that differs from the case", async () => {
    const { reply } = await setup(["m1", "m2", "m3"], [fault("reply-field-mismatch")]);
    const view = await reply.suggest("I want Monday.", 0);
    expect(view.reply).toMatchObject({ draft: null, suggestion: { outcome: "manual_needed", attempts: [{ problems: ["field_mismatch"] }, { problems: ["field_mismatch"] }] } });
  });

  it("gives output that is not JSON one retry", async () => {
    const { reply } = await setup(["m1", "m2", "m3"], [fault("reply-not-json")]);
    const view = await reply.suggest("I want Monday.", 0);
    expect(view.reply.suggestion).toMatchObject({
      outcome: "valid",
      attempts: [{ outcome: "invalid", problems: ["not_json"] }, { outcome: "valid" }],
      outputs: [null, { template: "accept_offer" }],
    });
    expect(view.reply.draft).toMatchObject({ template: "accept_offer", origin: "model" });
  });

  it("S7: a pick for the slot without a time fails the missing-field check and falls back", async () => {
    const { reply } = await setup(["s7-confirm"]);
    const view = await reply.suggest("Please confirm my visit.", 0);
    expect(view.reply).toMatchObject({
      draft: null,
      options: [],
      suggestion: { outcome: "manual_needed", attempts: [{ problems: ["missing_field"] }, { problems: ["missing_field"] }] },
    });
  });

  it("replaces an open draft through a discard event", async () => {
    const { reply, store } = await setup(["m1", "m2", "m3"]);
    reply.start("decline_offer", "2026-11-10T14:00", 0);
    await reply.suggest("I want Monday.", 1);
    expect(replyEvents(store)).toEqual(["reply_drafted", "reply_suggested", "reply_discarded", "reply_drafted"]);
  });

  it("checks the version and the note before calling the model", async () => {
    const { reply, client } = await setup(["m1", "m2", "m3"]);
    const calls = client.calls.length;
    await expect(reply.suggest("I want Monday.", 1)).rejects.toBeInstanceOf(StaleEditError);
    await expect(reply.suggest("x".repeat(501), 0)).rejects.toThrow(/longer than 500/);
    expect(client.calls).toHaveLength(calls);
  });

  it("R-c: accepts a proposed place that equals the case value apart from case and spacing", async () => {
    const { kase } = await setup(["m2", "m3"]);
    const ctx = kase.replyState().context;
    const out = { template: "ask_still_stands" as const, slot_id: "2026-11-12T10:30", fields: { date: "2026-11-12", time: "10:30", location: "lantern hill clinic,  400 elm street, suite 2" } };
    expect(checkReply(out, ctx)).toEqual([]);
    expect(checkReply({ ...out, fields: { ...out.fields, location: "Elm Street office" } }, ctx)).toEqual(["field_mismatch"]);
    expect(checkReply({ ...out, fields: { date: null, time: null, location: null } }, ctx)).toEqual([]);
  });
});
