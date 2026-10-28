// The case agent (0007, 0009): the tool loop, its tools and the checks on
// its text, with scripted model replies and no network.
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_NAMES, AGENT_TOOLS } from "../src/agent/tools.ts";
import { DRAFT_OPEN_NOTICE, UNGROUNDED_TEXT, WITHHELD_USER_TEXT } from "../src/agent/types.ts";
import { readFixtureText } from "../src/fixtures/load.ts";
import { MODEL } from "../src/model/request.ts";
import { SCOPE_DECLINE } from "../src/domain/scope.ts";
import { EventStore } from "../src/store/event-log.ts";
import { unsupportedSlots } from "../src/eval/chat-eval.ts";
import { acceptMessages } from "./helpers.ts";
import {
  CLOCK,
  RuleModel,
  agentFor,
  currentUserText,
  fingerprint,
  fixtureMessage,
  personOnly,
  fnCall,
  message,
  pasted,
  reply,
  say,
  sequence,
  services,
  turnOutputs,
} from "./agent-helpers.ts";

const MON = "2026-11-16T13:00";
const THU = "2026-11-12T10:30";

function fresh() {
  return services(new EventStore(":memory:", CLOCK));
}

async function demoCase() {
  const app = fresh();
  await acceptMessages(app.intake, ["m1", "m2", "m3"]);
  app.kase.loadCalendar("dana.ics", readFixtureText("calendar/dana.ics"), 0);
  return app;
}

const pendingIds = (app: ReturnType<typeof fresh>) => app.intake.reviewQueue().map((e) => e.id);

describe("G1: the model request", () => {
  it("uses muse-spark-1.3 with store false, streaming, effort low, function tools and encrypted reasoning within the turn only", async () => {
    const app = await demoCase();
    const model = sequence(reply(fnCall("get_schedule", {})), reply(message("Monday 11/16 1:00 PM is offered.")));
    const agent = agentFor(app, model);
    await say(agent, app, "What is offered on Monday?");
    expect(model.calls).toHaveLength(2);
    const [first, second] = model.calls.map((c) => c.body);
    expect(first).toMatchObject({
      model: MODEL,
      store: false,
      stream: true,
      reasoning: { effort: "low" },
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
    });
    expect(first!.model).not.toMatch(/contributor/);
    expect(first!.tools.map((t) => t.name)).toEqual(AGENT_TOOL_NAMES);
    // Turn two of the same turn carries the reasoning item, the call and its output.
    const types = second!.input.map((i) => (i as { type?: string }).type ?? (i as { role: string }).role);
    expect(types).toEqual(["user", "reasoning", "function_call", "function_call_output"]);
    expect(JSON.stringify(second!.input)).toContain("enc-");

    // The next turn sends the chat history as text only: no reasoning items
    // and no earlier tool results.
    const next = sequence(reply(message("You are welcome.")));
    const agent2 = agentFor(app, next);
    await say(agent2, app, "Thanks");
    const input = next.calls[0]!.body.input;
    expect(input.map((i) => (i as { role?: string }).role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(input)).not.toContain("enc-");
    expect(JSON.stringify(input)).not.toContain("function_call");
    // The store keeps no reasoning item and no tool result either.
    expect(JSON.stringify(app.store.readAll())).not.toContain("enc-");
  });

  it("refuses a contributor model before any call", async () => {
    const app = fresh();
    const model = sequence(reply(message("Hi")));
    const agent = agentFor(app, model, { model: "muse-spark-1.3-contributor" });
    const r = await say(agent, app, "Hello");
    expect(r.of("turn.error")[0]?.code).toBe("server_error");
    expect(model.calls).toHaveLength(0);
  });
});

describe("G2: the tools", () => {
  it("are the read tools and the action tools, with no tool that approves, sends, edits a reply, enters a fact by hand or deletes", () => {
    expect(AGENT_TOOL_NAMES).toEqual([
      "get_schedule",
      "get_appointment",
      "list_open_questions",
      "get_checklist",
      "check_calendar",
      "get_activity",
      "import_message",
      "accept_claim",
      "reject_claim",
      "explain_conflict",
      "ask_next_question",
      "answer_question",
      "archive_appointment",
      "unarchive_appointment",
      "add_note",
      "set_tags",
      "start_reply",
      "discard_draft",
      "undo",
      "set_timezone",
    ]);
    for (const forbidden of ["approve", "send", "delete", "grant", "propose", "edit", "manual", "confirm", "pair"]) {
      expect(AGENT_TOOL_NAMES.filter((n) => n.includes(forbidden)), forbidden).toEqual([]);
    }
    for (const t of AGENT_TOOLS) expect(t.label).toMatch(/^[A-Z][a-z ]+$/);
    expect(AGENT_TOOLS.filter((t) => t.readOnly).map((t) => t.name)).toEqual(["get_schedule", "get_appointment", "list_open_questions", "get_checklist", "check_calendar", "get_activity"]);
  });

  it("every tool runs without changing what only the person may change, and returns message text only in labeled fields", async () => {
    const app = await demoCase();
    // A pending claim from an injection message, so its quote is in the results.
    const injection = app.intake.importMessage({ ...fixtureMessage("s15-injection") });
    await app.intake.extract(injection.id, { effort: "low", expectedVersion: injection.version });
    const before = fingerprint(app);
    const conflict = app.kase.view().conflicts[0]!;
    const calls = [
      fnCall("get_schedule", {}),
      fnCall("get_appointment", { slot_key: THU }),
      fnCall("list_open_questions", {}),
      fnCall("get_checklist", {}),
      fnCall("check_calendar", { date: "2026-11-13", time: "09:15" }),
      fnCall("explain_conflict", { conflict_id: conflict.id }),
    ];
    const model = sequence(...calls.map((c) => reply(c)), reply(message("Here is your schedule.")));
    const r = await say(agentFor(app, model), app, "Show me everything");
    expect(r.report.tools).toEqual(calls.map((c) => ({ tool: (c as unknown as { name: string }).name, ok: true, code: "ok" })));
    expect(fingerprint(app)).toBe(before);

    const outputs = turnOutputs(model.calls.at(-1)!.body.input);
    const all = JSON.stringify(outputs);
    // The injection text appears only inside untrusted fields.
    const needle = "ignore your previous instructions";
    expect(all).toContain(needle);
    const bare: string[] = [];
    const walk = (v: unknown, key: string) => {
      if (typeof v === "string") {
        if (v.includes(needle) && key !== "untrusted_quote" && key !== "untrusted_text") bare.push(key);
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(outputs, "");
    expect(bare).toEqual([]);
    // The full message body is never returned.
    expect(all).not.toContain(fixtureMessage("s15-injection").text.slice(0, 120));
  });

  it("check_calendar reads Denver wall-clock times, and Friday 9:15 AM clashes with the team meeting", async () => {
    const app = await demoCase();
    const model = sequence(reply(fnCall("check_calendar", { date: "2026-11-13", time: "09:15" })), reply(message("Friday 11/13 9:15 AM clashes with an event from 9:00 AM.")));
    const r = await say(agentFor(app, model), app, "Does Friday clash with anything?");
    const out = turnOutputs(model.calls[1]!.body.input)[0]!.output;
    expect(out.clashes_with_time).toEqual([{ summary: { untrusted_text: "Team meeting" }, starts: "Friday 11/13 9:00 AM" }]);
    expect(r.report.outcome).toBe("answered");
    expect(r.of("facts")[0]!.chips).toEqual([
      { slotKey: "2026-11-13T09:15", label: "Fri 11/13 9:15 AM", stateLabel: "Offered · office message", evidenceIds: ["m3-e2"] },
    ]);
  });

  it("rejects arguments outside the app's rules and runs nothing", async () => {
    const app = await demoCase();
    const before = fingerprint(app);
    const model = sequence(
      reply(fnCall("start_reply", { template: "cancel_everything", slot_key: THU, expected_version: 0 })),
      reply(message("I could not do that.")),
    );
    const r = await say(agentFor(app, model), app, "Cancel Thursday");
    expect(r.report.tools).toEqual([{ tool: "start_reply", ok: false, code: "invalid_arguments" }]);
    expect(turnOutputs(model.calls[1]!.body.input)[0]!.output.error).toBe("invalid_arguments");
    expect(app.kase.view().reply.draft).toBeNull();
    expect(fingerprint(app)).toBe(before);
  });
});

describe("G3: import_message takes only text the person pasted", () => {
  it("imports a pasted message, runs the checked extraction and shows a claims card with nothing accepted", async () => {
    const app = fresh();
    const m1 = fixtureMessage("m1");
    const model = sequence(
      reply(fnCall("import_message", { text: m1.text, channel: "sms", from: m1.from, received_at: m1.received_at })),
      reply(message("I found two offered times: Tuesday 11/10 2:00 PM and Thursday 11/12 10:30 AM. Review them on the card.")),
    );
    const before = fingerprint(app);
    const r = await say(agentFor(app, model), app, pasted("m1"));
    expect(r.of("card").map((c) => c.card)).toEqual([{ kind: "claims", messageId: "m1", evidenceIds: ["m1-e1", "m1-e2"] }]);
    expect(pendingIds(app)).toEqual(["m1-e1", "m1-e2"]);
    expect(app.kase.view().slots).toEqual([]);
    expect(fingerprint(app)).toBe(before);
    expect(r.report.outcome).toBe("answered");
    // Pasting it again finds the same message instead of a copy.
    const again = sequence(
      reply(fnCall("import_message", { text: m1.text, channel: "sms", from: null, received_at: null })),
      reply(message("That message is already in your case.")),
    );
    const r2 = await say(agentFor(app, again), app, pasted("m1", "Here it is again:"));
    expect(turnOutputs(again.calls[1]!.body.input)[0]!.output.status).toBe("already_imported");
    expect(r2.of("card").map((c) => c.card)).toEqual([{ kind: "claims", messageId: "m1", evidenceIds: ["m1-e1", "m1-e2"] }]);
    expect(app.intake.messages()).toHaveLength(1);
  });

  it("refuses text that is not in the person's current message with not_from_user, and imports nothing", async () => {
    const app = fresh();
    const m4 = fixtureMessage("m4");
    const model = sequence(
      reply(fnCall("import_message", { text: m4.text, channel: "sms", from: "Lantern Hill Clinic", received_at: null })),
      reply(message("I could not import that.")),
    );
    const r = await say(agentFor(app, model), app, pasted("m1"));
    expect(turnOutputs(model.calls[1]!.body.input)[0]!.output).toMatchObject({ error: "not_from_user" });
    expect(r.report.tools).toEqual([{ tool: "import_message", ok: false, code: "not_from_user" }]);
    expect(app.intake.messages()).toEqual([]);
    expect(r.of("card")).toEqual([]);
  });

  it("accepts text whose whitespace differs from the paste, and refuses a fragment that cuts a word", async () => {
    const app = fresh();
    const m2 = fixtureMessage("m2");
    const flat = m2.text.replace(/\s+/g, " ");
    const model = sequence(
      reply(fnCall("import_message", { text: "onfirms your appointment", channel: "email", from: null, received_at: null })),
      reply(fnCall("import_message", { text: flat, channel: "email", from: m2.from, received_at: m2.received_at })),
      reply(message("Review the claims on the card.")),
    );
    const r = await say(agentFor(app, model), app, m2.text);
    expect(r.report.tools).toEqual([
      { tool: "import_message", ok: false, code: "not_from_user" },
      { tool: "import_message", ok: true, code: "ok" },
    ]);
    expect(app.intake.messages().map((m) => m.id)).toEqual(["m2"]);
  });
});

describe("G4: grounding", () => {
  it("replaces an answer with an invented time after one retry, sends the chips and stores none of the model text", async () => {
    const app = await demoCase();
    const model = sequence(
      reply(fnCall("get_schedule", {})),
      reply(message("You are confirmed for Monday 11/16 at 3:00 PM.")),
      reply(message("You are confirmed for Wednesday 11/18.")),
    );
    const r = await say(agentFor(app, model), app, "Am I booked Monday?");
    expect(r.report.problems).toEqual([["ungrounded"], ["ungrounded"]]);
    expect(r.of("turn.error")).toEqual([{ turnId: r.report.turnId, code: "ungrounded", message: UNGROUNDED_TEXT }]);
    expect(r.text).toBe(UNGROUNDED_TEXT);
    expect(r.of("facts")[0]!.chips.map((c) => c.slotKey)).toEqual(app.kase.view().slots.map((s) => s.key));
    expect(r.of("turn.done")).toHaveLength(1);
    const stored = JSON.stringify(app.store.readAll());
    expect(stored).not.toContain("3:00 PM");
    expect(stored).not.toContain("Wednesday 11/18");
    expect(app.kase.history().at(-1)!.label).toBe("Assistant answered in the chat (answer replaced by code)");
    // E2: the retry is the answering call's input plus one problem-code
    // message, with the same tools and tool choice, and no failed text.
    const answered = model.calls[1]!.body;
    const retry = model.calls[2]!.body;
    expect(retry.tool_choice).toBe("auto");
    expect(retry.tools).toEqual(answered.tools);
    expect(retry.input.slice(0, -1)).toEqual(answered.input);
    expect(JSON.stringify(retry.input.at(-1))).toContain("(ungrounded)");
    expect(JSON.stringify(retry.input)).not.toContain("3:00 PM");
  });

  it("keeps a retried answer that passes, with chips for the slots it names", async () => {
    const app = await demoCase();
    const model = sequence(
      reply(fnCall("get_schedule", {})),
      reply(message("Monday is at 3:00 PM.")),
      reply(message("Monday 11/16 1:00 PM is offered. It is not booked yet.")),
    );
    const r = await say(agentFor(app, model), app, "Am I booked Monday?");
    expect(r.report.outcome).toBe("answered");
    expect(r.text).toBe("Monday 11/16 1:00 PM is offered. It is not booked yet.");
    expect(r.of("turn.error")).toEqual([]);
    expect(r.of("facts")[0]!.chips).toEqual([{ slotKey: MON, label: "Mon 11/16 1:00 PM", stateLabel: "Offered · office message", evidenceIds: ["m3-e3"] }]);
    expect(agentFor(app, model).chat().messages.at(-1)).toMatchObject({ role: "assistant", text: r.text, chips: r.of("facts")[0]!.chips });
  });

  it("treats a date with no tool result behind it as ungrounded, even a plausible one", async () => {
    const app = await demoCase();
    const model = sequence(reply(message("Your visit is Monday 11/16 at 1:00 PM.")), reply(message("Your visit is on Monday.")));
    const r = await say(agentFor(app, model), app, "When is my visit?");
    expect(r.report.outcome).toBe("ungrounded");
  });

  it("replaces an answer that says the agent changed something", async () => {
    const app = await demoCase();
    const before = fingerprint(app);
    const model = sequence(
      reply(fnCall("get_schedule", {})),
      reply(message("I accepted every claim and canceled Thursday 11/12 10:30 AM.")),
      reply(message("I've cancelled Thursday 11/12 10:30 AM for you.")),
    );
    const r = await say(agentFor(app, model), app, "cancel Thursday");
    // Thursday is not canceled either, so both answers also misstate it.
    expect(r.report.problems).toEqual([
      ["state_mismatch", "claims_action"],
      ["state_mismatch", "claims_action"],
    ]);
    expect(r.report.outcome).toBe("ungrounded");
    expect(fingerprint(app)).toBe(before);
  });
});

describe("G5: scope", () => {
  it("declines clinical text with no model call and saves a fixed sentence in its place", async () => {
    const app = await demoCase();
    const model = sequence();
    const agent = agentFor(app, model);
    const asks = ["What do my lab results mean?", "Should I stop taking my medication before the visit?", "Are my sуmptoms serious?"];
    for (const ask of asks) {
      const r = await say(agent, app, ask);
      expect(r.of("turn.error").map((e) => e.code)).toEqual(["out_of_scope"]);
      expect(r.text).toBe(SCOPE_DECLINE);
      expect(r.of("turn.started")).toHaveLength(1);
      expect(r.of("turn.done")).toHaveLength(1);
    }
    expect(model.calls).toHaveLength(0);
    const chat = agent.chat();
    expect(chat.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual([WITHHELD_USER_TEXT, WITHHELD_USER_TEXT, WITHHELD_USER_TEXT]);
    expect(chat.messages.filter((m) => m.role === "assistant").every((m) => m.declined === true && m.text === SCOPE_DECLINE)).toBe(true);
    const stored = JSON.stringify(app.store.readAll());
    for (const word of ["lab results", "medication", "sуmptoms"]) expect(stored).not.toContain(word);
    expect(app.intake.messages()).toHaveLength(3);
  });

  it("replaces clinical model text with the decline after one retry", async () => {
    const app = await demoCase();
    const model = sequence(reply(message("You should fast before your blood test.")), reply(message("Take your medication as usual.")));
    const r = await say(agentFor(app, model), app, "Anything I should know?");
    expect(r.report.problems).toEqual([["clinical_content"], ["clinical_content"]]);
    expect(r.of("turn.error")[0]!.code).toBe("out_of_scope");
    expect(r.text).toBe(SCOPE_DECLINE);
    expect(agentFor(app, model).chat().messages.at(-1)!.declined).toBe(true);
    expect(JSON.stringify(app.store.readAll())).not.toContain("blood test");
  });
});

describe("G7: draft safety", () => {
  it("opens a draft only when none is open, and otherwise shows a notice and changes nothing", async () => {
    const app = await demoCase();
    const model = sequence(
      reply(fnCall("start_reply", { template: "accept_offer", slot_key: MON, expected_version: 0 })),
      reply(message("A reply accepting Monday 11/16 1:00 PM is ready for your readback.")),
      reply(fnCall("start_reply", { template: "accept_offer", slot_key: "2026-11-13T09:15", expected_version: 2 })),
      reply(message("A draft is already open.")),
    );
    const agent = agentFor(app, model);
    const r1 = await say(agent, app, "Move me to Monday");
    const draft = app.kase.view().reply.draft!;
    expect(draft).toMatchObject({ template: "accept_offer", slotKey: MON, origin: "manual" });
    expect(r1.of("card").map((c) => c.card)).toEqual([{ kind: "reply", draftId: draft.id }]);
    const version = app.kase.view().reply.version;
    const before = fingerprint(app);
    const r2 = await say(agent, app, "Actually make it Friday");
    expect(r2.of("card").map((c) => c.card)).toEqual([
      { kind: "notice", text: DRAFT_OPEN_NOTICE },
      { kind: "reply", draftId: draft.id },
    ]);
    expect(app.kase.view().reply.version).toBe(version);
    expect(app.kase.view().reply.draft!.slotKey).toBe(MON);
    expect(fingerprint(app)).toBe(before);
  });

  it("code blocks a template the slot's state does not allow", async () => {
    const app = await demoCase();
    const model = sequence(reply(fnCall("start_reply", { template: "accept_offer", slot_key: THU, expected_version: 0 })), reply(message("That reply is not possible.")));
    const r = await say(agentFor(app, model), app, "Accept Thursday");
    expect(r.report.tools).toEqual([{ tool: "start_reply", ok: false, code: "blocked" }]);
    expect(app.kase.view().reply.draft).toBeNull();
  });
});

describe("the demo story through chat", () => {
  // A stand-in model: imports what the person pasted and accepts its claims,
  // reads the case for questions, and words its answer from the tool
  // results.
  const demoModel = () =>
    new RuleModel([
      (input) => {
        const outs = turnOutputs(input);
        const text = currentUserText(input);
        if (outs.length > 0) return undefined;
        for (const id of ["m1", "m2", "m3", "m4"]) {
          const m = fixtureMessage(id);
          if (text.includes(m.text)) return [fnCall("import_message", { text: m.text, channel: m.channel, from: m.from, received_at: m.received_at })];
        }
        if (/confirmed/i.test(text)) return [fnCall("get_schedule", {})];
        if (/friday/i.test(text)) return [fnCall("check_calendar", { date: "2026-11-13", time: "09:15" })];
        if (/monday/i.test(text)) return [fnCall("get_schedule", {})];
        if (/bring/i.test(text)) return [fnCall("get_checklist", {})];
        return undefined;
      },
      (input) => {
        const last = turnOutputs(input).at(-1);
        if (!last) return undefined;
        const text = currentUserText(input);
        switch (last.name) {
          case "import_message":
            return [fnCall("accept_claim", { claims: last.output.claims.map((c: any) => ({ evidence_id: c.evidence_id, expected_version: c.version })) })];
          case "accept_claim":
            return [message(`I accepted ${last.output.decided} claims from the message. You can undo each one.`)];
          case "get_schedule": {
            if (/monday/i.test(text)) return [fnCall("start_reply", { template: "accept_offer", slot_key: MON, expected_version: last.output.reply_version })];
            const confirmed = last.output.appointments.filter((a: any) => a.state === "confirmed" || a.state === "change_proposed");
            return [message(confirmed.length ? `${confirmed.map((a: any) => a.label).join(" and ")} is confirmed.` : "Nothing is confirmed yet.")];
          }
          case "check_calendar":
            return [message(`Friday 11/13 9:15 AM overlaps an event that starts ${last.output.clashes_with_time[0].starts.replace("Friday 11/13 ", "")}.`)];
          case "start_reply":
            return [message(`A reply accepting ${last.output.slot_label} is ready. Read it back and approve it on the card.`)];
          case "get_checklist":
            return [message(`The office asked for ${last.output.items.length} things. They are on your checklist.`)];
        }
        return undefined;
      },
    ]);

  it("pastes m1 to m4 and the assistant accepts their facts, asks and drafts, and only the person approves the reply", async () => {
    const app = fresh();
    app.kase.loadCalendar("dana.ics", readFixtureText("calendar/dana.ics"), 0);
    const model = demoModel();
    const agent = agentFor(app, model);
    const turn = async (text: string) => {
      const sentBefore = personOnly(app);
      const r = await say(agent, app, text);
      expect(personOnly(app), text).toBe(sentBefore);
      expect(r.report.outcome, text).toBe("answered");
      return r;
    };

    for (const id of ["m1", "m2", "m3"]) {
      const r = await turn(pasted(id));
      expect(r.of("card").map((c) => c.card.kind)).toEqual(["claims"]);
      // Each action reached the page as it happened, and can be undone.
      const kinds = r.of("action").map((a) => a.entry.kind);
      expect(kinds[0]).toBe("message_imported");
      expect(kinds.slice(1).every((k) => k === "claim_accepted")).toBe(true);
      expect(r.of("action").every((a) => a.entry.actor === "agent" && a.entry.undoable)).toBe(true);
      expect(app.intake.reviewQueue()).toEqual([]);
    }
    let r = await turn("What is confirmed right now?");
    expect(r.text).toBe("Thursday 11/12 10:30 AM is confirmed.");
    r = await turn("Why does Friday clash?");
    expect(r.text).toBe("Friday 11/13 9:15 AM overlaps an event that starts 9:00 AM.");
    r = await turn("Please move me to Monday");
    const draft = app.kase.view().reply.draft!;
    expect(r.of("card").map((c) => c.card)).toEqual([{ kind: "reply", draftId: draft.id }]);
    expect(r.of("action").map((a) => a.entry.kind)).toEqual(["draft_started"]);
    // Nothing is sent until the person approves.
    expect(app.kase.view().reply.sent).toEqual([]);

    // The person reads back and approves on the card.
    app.reply.approve(draft.id, draft.fields.map((f) => f.name), app.kase.view().reply.version);
    expect(app.kase.view().slots.find((s) => s.key === MON)!.stateLabel).toBe("Requested · reported by you");

    r = await turn(pasted("m4", "The office wrote back:"));
    expect(r.of("card").map((c) => c.card)).toEqual([{ kind: "claims", messageId: "m4", evidenceIds: ["m4-e1", "m4-e2"] }]);
    expect(app.kase.view().slots.find((s) => s.key === MON)!.stateLabel).toBe("Confirmed · office message");
    expect(app.kase.view().slots.find((s) => s.key === THU)!.stateLabel).toBe("Canceled · office message");
    r = await turn("What do I need to bring?");
    expect(r.text).toBe("The office asked for 2 things. They are on your checklist.");

    // The chat holds every message in order, with its cards and actions.
    const chat = agent.chat();
    expect(chat.messages).toHaveLength(16);
    // 16 messages and 4 imported-line records, one per paste.
    expect(chat.chatVersion).toBe(20);
    expect(chat.messages.every((m, i) => m.role === (i % 2 === 0 ? "user" : "assistant"))).toBe(true);
    expect(chat.messages[1]!.cards).toEqual([{ kind: "claims", messageId: "m1", evidenceIds: ["m1-e1", "m1-e2"] }]);
    expect(chat.messages[1]!.actions).toHaveLength(3);
    expect(chat.messages[0]!.createdAt).toBe("2026-11-05T10:00:00.000-07:00");
    // No slot's state rests on anything but an office message or the
    // person's own report.
    expect(unsupportedSlots(app)).toEqual([]);
  });
});
