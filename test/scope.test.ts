// S11 and R-f: text the user types is checked for clinical content before
// any model call. A clinical text gets the fixed decline that states the
// administrative scope, records nothing and makes no model call.
import { describe, expect, it } from "vitest";
import { createApi } from "../server/api.ts";
import { CaseService } from "../src/case/service.ts";
import { OutOfScopeError, SCOPE_DECLINE, hasClinicalContent, mixesScripts, normalizeForScope } from "../src/domain/scope.ts";
import { loadScenarios } from "../src/fixtures/load.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, asFreshPage, fixtureMessage, intake } from "./helpers.ts";

const S11_TEXT = loadScenarios().find((s) => s.id === "S11")!.messages[0]!.text;

// The clinical words and phrases from reviews R1-4 and R2-12.
const R1_4_WORDS = [
  "lab result", "lab work", "lab test", "test results", "biopsy", "biopsies", "cancer", "tumor", "tumour", "symptom",
  "diagnosis", "diagnosed", "treatment", "therapy", "medication", "medicine", "medical", "prescription",
  "pharmacy", "drug", "pill", "dose", "dosage", "blood", "scan", "X-ray", "xray", "MRI", "ultrasound", "screening",
  "surgery", "surgical", "illness", "disease", "disorder", "condition", "infection", "allergy", "pregnancy",
  "vaccine", "injection", "pain", "mental health", "chemotherapy", "radiation", "prognosis",
];
const R2_12_CLINICAL = ["Your results are in.", "The results of your visit", "Your test result", "lab work", "Your treatment plan"];
const R2_12_ADMIN = ["As a result, my Thursday visit still holds.", "Should we treat Thursday 11/12 as canceled?", "Is the North Lab office open?"];

async function setup(ids: string[] = []) {
  const store = new EventStore();
  const service = intake(store);
  await acceptMessages(service, ids);
  const client = RecordedModelClient.withOverrides([], RecordedModelClient.fromDirectory());
  const kase = new CaseService(store, service, client, { userName: "Dana Reyes" });
  const reply = new ReplyService(store, kase, client);
  return { store, intake: service, kase, reply, client };
}

describe("SP3.9 S11: a clinical question gets the fixed decline", () => {
  it("states the administrative scope in the decline", () => {
    expect(SCOPE_DECLINE).toBe(
      "This app only handles appointment times, places, confirmations and office requests. It cannot answer health questions. Please ask the office directly.",
    );
    expect(hasClinicalContent(SCOPE_DECLINE)).toBe(false);
    expect(new OutOfScopeError().message).toBe(SCOPE_DECLINE);
  });

  it("S11: declines the pasted report, records nothing and calls no model", async () => {
    const { intake: service, store, client } = await setup();
    expect(() => service.importMessage(fixtureMessage("s11-question"))).toThrow(OutOfScopeError);
    expect(store.readAll()).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  it("S11: declines the same question typed as a reply note, records nothing and calls no model", async () => {
    const { reply, store, client } = await setup(["m1", "m2", "m3"]);
    const count = store.readAll().length;
    const calls = client.calls.length;
    await expect(reply.suggest(S11_TEXT, 0)).rejects.toThrow(SCOPE_DECLINE);
    expect(store.readAll()).toHaveLength(count);
    expect(client.calls).toHaveLength(calls);
  });

  it("R1-4: declines a report or a note with any clinical word, singular or plural", async () => {
    const { intake: service, reply, store, client } = await setup(["m1"]);
    const count = store.readAll().length;
    const calls = client.calls.length;
    for (const [i, word] of R1_4_WORDS.entries()) {
      const text = `About my ${word} before Thursday.`;
      const report = { id: `r${i}`, channel: "user_report" as const, from: "Dana Reyes", received_at: "2026-11-06T19:30:00-07:00", text };
      expect(() => service.importMessage(report), word).toThrow(OutOfScopeError);
      await expect(reply.suggest(text, 0), word).rejects.toBeInstanceOf(OutOfScopeError);
    }
    expect(store.readAll()).toHaveLength(count);
    expect(client.calls).toHaveLength(calls);
  });

  it("R2-12: declines clinical phrases and lets ordinary uses of result, treat and lab through", async () => {
    const { intake: service, reply } = await setup(["m1"]);
    for (const text of R2_12_CLINICAL) await expect(reply.suggest(text, 0), text).rejects.toBeInstanceOf(OutOfScopeError);
    let version = 0;
    for (const [i, text] of R2_12_ADMIN.entries()) {
      // No recording exists for these notes, so the model call fails and
      // the user picks by hand. The point is that the note was not declined.
      const view = await reply.suggest(text, version);
      expect(view.reply.suggestion, text).toMatchObject({ intent: text, outcome: "manual_needed" });
      version = view.reply.version;
      const report = { id: `ok${i}`, channel: "user_report" as const, from: "Dana Reyes", received_at: "2026-11-06T19:30:00-07:00", text };
      expect(service.importMessage(report).id).toBe(`ok${i}`);
    }
  });

  it("checks only text the user types: an office message is imported as data", async () => {
    const { intake: service } = await setup();
    const office = { id: "o1", channel: "sms" as const, from: "Lantern Hill Clinic", received_at: "2026-11-06T19:30:00-07:00", text: "Please bring your medication list." };
    expect(service.importMessage(office).id).toBe("o1");
  });

  it("returns the decline from the API as out_of_scope", async () => {
    const { intake: service, kase, reply } = await setup(["m1"]);
    const api = asFreshPage(createApi(service, kase, { mode: "recorded" }, reply), kase);
    const pasted = await api({ method: "POST", path: "/api/messages", body: fixtureMessage("s11-question") });
    expect(pasted).toEqual({ status: 422, body: { error: "out_of_scope", message: SCOPE_DECLINE } });
    const note = await api({ method: "POST", path: "/api/reply/suggest", body: { expectedVersion: 0, intent: S11_TEXT } });
    expect(note).toEqual({ status: 422, body: { error: "out_of_scope", message: SCOPE_DECLINE } });
    // Review round 1, finding 2: the same text typed into a draft edit.
    await api({ method: "POST", path: "/api/reply/drafts", body: { expectedVersion: 0, template: "accept_offer", slotKey: "2026-11-10T14:00" } });
    const edit = await api({ method: "POST", path: "/api/reply/drafts/d1/edit", body: { expectedVersion: 1, text: S11_TEXT } });
    expect(edit).toEqual({ status: 422, body: { error: "out_of_scope", message: SCOPE_DECLINE } });
  });
});

describe("review round 2, B1: the scope check reads normalized text", () => {
  const CYRILLIC = "Before the visit, can you tell me what my sуmptoms mean?";
  const ZERO_WIDTH = "Before the visit, can you tell me what my symp​toms mean?";
  const FULLWIDTH = "Before the visit, can you tell me what my ｓｙｍｐｔｏｍｓ mean?";

  it("catches a Cyrillic letter, a zero-width character, fullwidth letters, a soft hyphen and an accent", () => {
    expect(hasClinicalContent("sуmptoms")).toBe(true);
    expect(mixesScripts("sуmptoms")).toBe(true);
    for (const text of [CYRILLIC, ZERO_WIDTH, FULLWIDTH, "my symp­toms", "my sýmptoms", "my sýmptoms", "‍treatment"]) {
      expect(hasClinicalContent(text), JSON.stringify(text)).toBe(true);
    }
    expect(normalizeForScope(FULLWIDTH)).toContain("symptoms");
    expect(normalizeForScope(ZERO_WIDTH)).toContain("symptoms");
  });

  it("fails closed on any word that mixes Latin with another script, and passes words in one script", () => {
    expect(hasClinicalContent("Is my Thursdаy visit still on?")).toBe(true);
    expect(hasClinicalContent("Is my Thursday visit still on?")).toBe(false);
    expect(hasClinicalContent("Merci, le café au 400 Elm Street convient.")).toBe(false);
    expect(hasClinicalContent("Спасибо, Thursday works.")).toBe(false);
  });

  it("refuses each case as a draft edit, and refuses a stored one at approval", async () => {
    const { reply, store, kase } = await setup(["m2", "m3"]);
    reply.start("ask_still_stands", "2026-11-12T10:30", 0);
    const count = store.readAll().length;
    for (const text of [CYRILLIC, ZERO_WIDTH, FULLWIDTH]) {
      expect(() => reply.edit("d1", text, 1), JSON.stringify(text)).toThrow(SCOPE_DECLINE);
    }
    expect(store.readAll()).toHaveLength(count);
    store.append("reply", 1, [{ type: "reply_edited", data: { draft_id: "d1", text: CYRILLIC } }]);
    expect(() => reply.approve("d1", kase.view().reply.draft!.fields.map((f) => f.name), 2)).toThrow(SCOPE_DECLINE);
  });

  it("refuses each case as a pasted report and as a note, before any model call", async () => {
    const { intake: service, reply, client } = await setup(["m1"]);
    const calls = client.calls.length;
    for (const [i, text] of [CYRILLIC, ZERO_WIDTH, FULLWIDTH].entries()) {
      const report = { id: `u${i}`, channel: "user_report" as const, from: "Dana Reyes", received_at: "2026-11-06T19:30:00-07:00", text };
      expect(() => service.importMessage(report)).toThrow(OutOfScopeError);
      await expect(reply.suggest(text, 0)).rejects.toBeInstanceOf(OutOfScopeError);
    }
    expect(client.calls).toHaveLength(calls);
  });
});
