// The agent acts and the person can undo (0009, J1). Each action reaches the
// page as an `action` event with its activity entry, the assistant message
// keeps the entry ids, and the checks on the agent's text read what the
// turn actually did. Code refuses what the rules do not allow, and the
// agent tells the person why.
import { describe, expect, it } from "vitest";
import { CaseActions } from "../src/actions/service.ts";
import { historyItem } from "../src/agent/agent.ts";
import { UNGROUNDED_TEXT } from "../src/agent/types.ts";
import { readFixtureText } from "../src/fixtures/load.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages } from "./helpers.ts";
import { CLOCK, agentFor, fixtureMessage, fnCall, message, pasted, personOnly, reply, say, sequence, services, turnOutputs } from "./agent-helpers.ts";

const THU = "2026-11-12T10:30";
const MON = "2026-11-16T13:00";

function fresh() {
  return services(new EventStore(":memory:", CLOCK));
}

describe("J1: the agent accepts facts itself", () => {
  it("imports a paste and accepts its claims in one turn, with an action event for each, and the answer may say so", async () => {
    const app = fresh();
    const m1 = fixtureMessage("m1");
    const model = sequence(
      reply(fnCall("import_message", { text: m1.text, channel: "sms", from: m1.from, received_at: null })),
      reply(fnCall("accept_claim", { claims: [{ evidence_id: "m1-e1", expected_version: 1 }, { evidence_id: "m1-e2", expected_version: 1 }] })),
      reply(message("I accepted the offer for Tuesday 11/10 2:00 PM and the offer for Thursday 11/12 10:30 AM. Both are offered, and you can undo either one.")),
    );
    const agent = agentFor(app, model);
    const r = await say(agent, app, pasted("m1"));
    expect(r.report.outcome).toBe("answered");
    expect(r.report.problems).toEqual([[]]);
    const actions = r.of("action").map((a) => a.entry);
    expect(actions.map((e) => [e.kind, e.actor, e.target?.id, e.undoable])).toEqual([
      ["message_imported", "agent", "m1", true],
      ["claim_accepted", "agent", "m1-e1", true],
      ["claim_accepted", "agent", "m1-e2", true],
    ]);
    // Each action event comes before the text, between its tool's start and end.
    const names = r.events.map((e) => e.event);
    expect(names.indexOf("action")).toBeGreaterThan(names.indexOf("tool.started"));
    expect(names.lastIndexOf("action")).toBeLessThan(names.indexOf("text.delta"));
    expect(r.of("card").map((c) => c.card)).toEqual([{ kind: "claims", messageId: "m1", evidenceIds: ["m1-e1", "m1-e2"] }]);
    expect(app.kase.view().slots.map((s) => [s.key, s.stateLabel])).toEqual([
      ["2026-11-10T14:00", "Offered · office message"],
      [THU, "Offered · office message"],
    ]);
    // The stored message keeps the ids, and history names them for the
    // next turn.
    const stored = agent.chat().messages[1]!;
    expect(stored.actions).toEqual(actions.map((e) => e.id));
    expect((historyItem(stored) as { content: string }).content).toContain(`(Actions taken, by activity id: ${actions.map((e) => e.id).join(", ")}. get_activity shows them.)`);
  });

  it("'accept everything for me' accepts the verified claims and reports the one it may not accept", async () => {
    const app = fresh();
    const m2 = app.intake.importMessage(fixtureMessage("m2"));
    await app.intake.extract("m2", { effort: "low", expectedVersion: m2.version });
    // A fact the person typed by hand, with no quote to check.
    app.intake.enterManually("m2", app.intake.message("m2").version, { claim_type: "office_request", date: null, time: null, location: null, quote: null, request_item: "Bring a pen" });
    const pending = app.intake.reviewQueue().map((e) => ({ evidence_id: e.id, expected_version: e.version }));
    expect(pending.map((p) => p.evidence_id)).toEqual(["m2-e1", "m2-e2", "m2-e3", "m2-u1"]);
    const model = sequence(
      reply(fnCall("list_open_questions", {})),
      reply(fnCall("accept_claim", { claims: pending })),
      reply(message("I accepted 3 claims. One fact you typed has no quote to check, so accept it yourself.")),
    );
    const r = await say(agentFor(app, model), app, "Accept everything for me.");
    expect(r.report.tools.map((t) => [t.tool, t.code])).toEqual([
      ["list_open_questions", "ok"],
      ["accept_claim", "partial"],
    ]);
    const out = turnOutputs(model.calls.at(-1)!.body.input).find((o) => o.name === "accept_claim")!.output;
    expect(out).toMatchObject({ decided: 3, refused: 1 });
    expect(out.results[3]).toMatchObject({ evidence_id: "m2-u1", error: "refused", message: "This fact has no quote from its message to check. Accept it yourself in the app." });
    expect(app.intake.reviewQueue().map((e) => e.id)).toEqual(["m2-u1"]);
    expect(r.report.outcome).toBe("answered");
  });
});

describe("design 5: the action-claim check reads what the turn did", () => {
  it("replaces 'I accepted' when nothing was accepted, and 'I sent' or 'I confirmed' always", async () => {
    const app = fresh();
    await acceptMessages(app.intake, ["m1", "m2", "m3"]);
    for (const text of ["I accepted the offer.", "I sent the reply.", "I confirmed Monday 11/16 1:00 PM."]) {
      const model = sequence(reply(fnCall("get_schedule", {})), reply(message(text)), reply(message(text)));
      const r = await say(agentFor(app, model), app, "Do it.");
      expect(r.report.problems.flat(), text).toContain("claims_action");
      expect(r.text, text).toBe(UNGROUNDED_TEXT);
    }
  });

  it("keeps an answer that names an action the turn took", async () => {
    const app = fresh();
    await acceptMessages(app.intake, ["m2"]);
    const model = sequence(
      reply(fnCall("archive_appointment", { slot_key: THU, expected_version: 0 })),
      reply(message("I archived Thursday 11/12 10:30 AM. You can undo it.")),
    );
    const r = await say(agentFor(app, model), app, "Archive Thursday.");
    expect(r.report.outcome).toBe("answered");
    expect(r.of("action").map((a) => a.entry.kind)).toEqual(["appointment_archived"]);
    expect(app.kase.archivedKeys().has(THU)).toBe(true);
  });
});

describe("code refuses what the rules do not allow, and nothing only the person may do happens", () => {
  it("an answer that would set a slot's state is refused with a reason the model reads, and nothing is written", async () => {
    const app = fresh();
    await acceptMessages(app.intake, ["m2", "m3", "s4-confirm"]);
    const view = await app.kase.askNext(app.kase.view().questionsVersion);
    expect(view.question!.conflictKind).toBe("both_held");
    const stands = view.question!.choices.find((c) => c.label === "Monday 11/16 1:00 PM stands")!;
    const model = sequence(
      reply(fnCall("answer_question", { question_id: view.question!.id, choice_id: stands.id, expected_version: view.questionsVersion })),
      reply(message("Only you can answer that one. The question is on the card.")),
    );
    const before = JSON.stringify(app.store.readAll().filter((e) => e.streamId !== "chat"));
    const r = await say(agentFor(app, model), app, "Monday stands, cancel Thursday.");
    expect(r.report.tools).toEqual([{ tool: "answer_question", ok: false, code: "needs_person" }]);
    expect(turnOutputs(model.calls[1]!.body.input)[0]!.output.message).toBe(
      "Only an office message or your own report can set Thursday 11/12 10:30 AM to canceled. The assistant cannot answer with that choice. Answer it yourself in the app.",
    );
    expect(r.of("action")).toEqual([]);
    expect(JSON.stringify(app.store.readAll().filter((e) => e.streamId !== "chat"))).toBe(before);
    expect(r.report.outcome).toBe("answered");
  });

  it("the agent's undo reverses an entry, and an undo a later approval blocks comes back as undo_blocked", async () => {
    const app = fresh();
    app.kase.loadCalendar("dana.ics", readFixtureText("calendar/dana.ics"), 0);
    await acceptMessages(app.intake, ["m1", "m2", "m3"]);
    const actions = new CaseActions(app.store, app);
    actions.addNote({ actor: "agent" }, MON, "Parking on Elm Street.", 0);
    let log = actions.activity();
    const model = sequence(
      reply(fnCall("undo", { activity_id: log.entries[0]!.id, expected_version: log.activityVersion })),
      reply(message("I undid that note.")),
    );
    const r = await say(agentFor(app, model), app, "Undo that note.");
    expect(r.report.outcome).toBe("answered");
    expect(r.of("action").map((a) => a.entry.kind)).toEqual(["undo"]);
    expect(app.records.record(MON).notes).toEqual([]);

    // The agent starts the reply, the person approves it, and an undo of
    // the start is refused with the reason.
    actions.startReply({ actor: "agent" }, "accept_offer", MON, app.kase.view().reply.version);
    const draft = app.kase.view().reply.draft!;
    actions.approveDraft({ actor: "you" }, draft.id, draft.fields.map((f) => f.name), app.kase.view().reply.version);
    log = actions.activity();
    const start = log.entries.find((e) => e.kind === "draft_started")!;
    const blocked = sequence(reply(fnCall("undo", { activity_id: start.id, expected_version: log.activityVersion })), reply(message("That cannot be undone because the reply was approved.")));
    const r2 = await say(agentFor(app, blocked), app, "Undo the reply.");
    expect(r2.report.tools).toEqual([{ tool: "undo", ok: false, code: "undo_blocked" }]);
    expect(turnOutputs(blocked.calls[1]!.body.input)[0]!.output.message).toBe(
      "A reply for Monday 11/16 1:00 PM was approved after this and depends on it. A sent reply cannot be unsent, so this cannot be undone.",
    );
    expect(app.kase.view().reply.sent).toHaveLength(1);
  });

  it("set_timezone in the chat is the agent's action, and the next turn reads the new zone", async () => {
    const app = fresh();
    const model = sequence(
      reply(fnCall("set_timezone", { timezone: "Europe/London", expected_version: 1 })),
      reply(message("Your time zone is now Europe/London.")),
      reply(fnCall("get_schedule", {})),
      reply(message("Today is Thursday 11/5.")),
    );
    const agent = agentFor(app, model);
    const r = await say(agent, app, "I moved to London.");
    expect(r.of("action").map((a) => [a.entry.kind, a.entry.actor, a.entry.summary])).toEqual([["timezone_set", "agent", "Set the time zone to Europe/London (it was America/Denver)."]]);
    await say(agent, app, "What day is it?");
    const schedule = turnOutputs(model.calls.at(-1)!.body.input)[0]!.output;
    expect(schedule.time_zone).toMatchObject({ name: "Europe/London", set_by: "agent", settings_version: 2 });
    expect(agent.chat().messages.at(-1)!.createdAt).toMatch(/\+00:00$/);
  });
});
