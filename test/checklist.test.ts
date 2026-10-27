// SP5.3 the checklist (O-f) and SP5.5 the case history.
import { describe, expect, it } from "vitest";
import { buildChecklist } from "../src/case/checklist.ts";
import { CaseService } from "../src/case/service.ts";
import { GrantStore } from "../src/grants/grants.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { USER } from "../src/records/events.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, ev, fixtureMessage, intake } from "./helpers.ts";

const AT = "2026-11-01T10:00:00.000Z";
const THU = "2026-11-12T10:30";

function services() {
  const store = new EventStore(":memory:", () => "2026-11-06T17:00:00.000Z");
  const client = RecordedModelClient.fromDirectory();
  const svc = intake(store);
  const kase = new CaseService(store, svc, client, { userName: "Dana Reyes" });
  return { store, intake: svc, kase, reply: new ReplyService(store, kase, client), records: new RecordsService(store, svc, kase), grants: new GrantStore(store) };
}

const request = (id: string, item: string, quote: string | null, options: Parameters<typeof ev>[5] = {}) =>
  ev(id, "office_request", null, null, AT, { request_item: item, quote, ...options });

describe("SP5.3 checklist", () => {
  it("lists accepted office requests only, each with its quote and source label", () => {
    const items = buildChecklist([
      ev("m2-e1", "confirm", "2026-11-12", "10:30", AT),
      request("m2-e2", "Bring new insurance card", "Please bring your new insurance card"),
      request("m2-e3", "Arrive 15 minutes early", "arrive 15 minutes early", { status: "rejected" }),
      request("m5-e1", "Bring a photo ID", "Bring a photo ID", { status: "pending" }),
      request("m6-u1", "Bring the referral letter", null, { source_type: "reported_by_user" }),
      request("p-1-1", "Fill out the intake form", "She said they want the intake form", {
        source_type: "reported_by_user_via_agent",
        agent_name: "Laptop assistant",
      }),
    ]);
    expect(items).toEqual([
      { text: "Bring new insurance card", sources: [{ evidenceId: "m2-e2", quote: "Please bring your new insurance card", sourceLabel: "office message" }] },
      { text: "Bring the referral letter", sources: [{ evidenceId: "m6-u1", quote: null, sourceLabel: "reported by you" }] },
      {
        text: "Fill out the intake form",
        sources: [{ evidenceId: "p-1-1", quote: "She said they want the intake form", sourceLabel: "reported by you through Laptop assistant" }],
      },
    ]);
    // Items are not model output and carry no model label.
    expect(JSON.stringify(items)).not.toMatch(/model/i);
  });

  it("merges requests in the same words and keeps every source, and keeps different wording apart", () => {
    const items = buildChecklist([
      request("m2-e2", "Bring new insurance card", "Please bring your new insurance card"),
      request("m7-e1", "bring  new insurance card.", "Remember to bring new insurance card."),
      request("m8-e1", "Ｂring new insurance card", "Ｂring new insurance card", { source_type: "reported_by_user" }),
      request("m9-e1", "Bring your insurance card", "Bring your insurance card"),
    ]);
    expect(items.map((i) => [i.text, i.sources.map((s) => `${s.evidenceId} ${s.sourceLabel}`)])).toEqual([
      ["Bring new insurance card", ["m2-e2 office message", "m7-e1 office message", "m8-e1 reported by you"]],
      ["Bring your insurance card", ["m9-e1 office message"]],
    ]);
  });

  it("follows review in the real case: a request the user rejects never shows", async () => {
    const app = services();
    const imported = app.intake.importMessage(fixtureMessage("m2"));
    const { evidence } = await app.intake.extract("m2", { effort: "minimal", expectedVersion: imported.version });
    expect(app.kase.view().checklist).toEqual([]);
    const [confirm, card, early] = evidence;
    app.intake.accept(confirm!.id, confirm!.version);
    app.intake.accept(card!.id, card!.version);
    app.intake.reject(early!.id, early!.version);
    expect(app.kase.view().checklist.map((i) => i.text)).toEqual(["Bring new insurance card"]);
  });

  it("shows a confirmed agent report through the grant's name", async () => {
    const app = services();
    await acceptMessages(app.intake, ["m2"]);
    const { grant } = app.grants.create("Laptop assistant", "propose");
    const p = app.records.propose(
      { kind: "user_report", claim_type: "office_request", date: null, request_item: "Bring the parking pass", statement: "Dana says the office wants the parking pass." },
      grant,
    );
    expect(app.kase.view().checklist.map((i) => i.text)).toEqual(["Bring new insurance card", "Arrive 15 minutes early"]);
    app.records.confirmProposal(p.id, p.version);
    expect(app.kase.view().checklist.at(-1)).toEqual({
      text: "Bring the parking pass",
      sources: [{ evidenceId: `${p.id}-1`, quote: "Dana says the office wants the parking pass.", sourceLabel: "reported by you through Laptop assistant" }],
    });
  });
});

describe("SP5.5 case history", () => {
  it("lists events in order with readable labels, including undo and the reply steps", async () => {
    const app = services();
    await acceptMessages(app.intake, ["m2", "m3"]);
    const asked = await app.kase.askNext(app.kase.view().questionsVersion);
    const monday = asked.question!.choices.find((c) => c.label.includes("Monday"))!;
    let view = app.kase.answer(asked.question!.id, monday.id, asked.questionsVersion, asked.reply.version);
    view = app.reply.edit(view.reply.draft!.id, "I would like Monday at 1:00 PM.", view.reply.version);
    const draft = view.reply.draft!;
    app.reply.approve(draft.id, draft.fields.map((f) => f.name), view.reply.version);
    app.records.addNote(THU, "Parking is on Elm Street.", 0, USER);
    app.records.archive(THU, 1);
    app.records.undo(THU, 2, 2);
    const { grant, token: _token } = app.grants.create("Laptop assistant", "annotate");
    app.records.setTags(THU, ["moved"], 3, { kind: "agent", grant_id: grant.id, grant_name: grant.name });

    const history = app.kase.history();
    expect(history.map((h) => h.seq)).toEqual([...history.map((h) => h.seq)].sort((a, b) => a - b));
    // Grants are app settings, not case events.
    expect(history.some((h) => h.streamId.startsWith("grant:"))).toBe(false);
    const labels = history.map((h) => h.label);
    expect(labels.slice(0, 7)).toEqual([
      "Message m2 added (email)",
      "Extraction attempt 1 at effort low: passed the code checks",
      "Extraction finished: claims wait for your review",
      "Claim m2-e1 extracted: confirmation for Thursday 11/12 10:30 AM",
      "Claim m2-e2 extracted: office request",
      "Claim m2-e3 extracted: office request",
      "You accepted claim m2-e1",
    ]);
    expect(labels.slice(-9)).toEqual([
      "Question q1 asked (model wording, passed the code checks)",
      "Question q1 answered: Request Monday 11/16 1:00 PM",
      "Draft d1 started: Accept an offered slot, Monday 11/16 1:00 PM",
      "Draft d1 edited",
      "Draft d1 approved. Simulated send. Claims not confirmed.",
      "Note n1 added to 2026-11-12T10:30 by you",
      "2026-11-12T10:30 archived by you",
      "Undo on 2026-11-12T10:30 by you: reversed version 2",
      "Tags on 2026-11-12T10:30 set by Laptop assistant: moved",
    ]);
    expect(history.find((h) => h.label === "2026-11-12T10:30 archived by you")!.undone).toBe(true);
    expect(history.filter((h) => h.undone)).toHaveLength(1);
    // The simulated send is folded into the approval entry.
    expect(labels.filter((l) => l.includes("Simulated send"))).toHaveLength(1);
    // No message text, quote or note text is repeated in the history.
    expect(labels.join("\n")).not.toMatch(/Parking|insurance|I would like/);
  });
});
