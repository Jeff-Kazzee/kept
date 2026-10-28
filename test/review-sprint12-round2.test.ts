// Sprint 12, the last round: the live runs on aec3cff (L1 to L3) and Muse
// round 2 (M1 to M9). One test per item, each failing before its fix.
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_INSTRUCTIONS } from "../src/agent/agent.ts";
import { checkAnswer, claimsAction, type Fact, type Grounds } from "../src/agent/grounding.ts";
import { negatedInMessage } from "../src/domain/negation.ts";
import { hasClinicalContent } from "../src/domain/scope.ts";
import { runChatEval } from "../src/eval/chat-eval.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { REPLY_INSTRUCTIONS } from "../src/reply/suggest.ts";
import { processIdentity, runDemoCheck, stopChild } from "../scripts/demo-check.ts";
import { fnCall, message, reply, sequence } from "./agent-helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

// The demo after m4: Monday confirmed, Thursday canceled.
const AFTER_M4: Fact[] = [
  { date: "2026-11-05", time: null },
  { date: "2026-11-10", time: "14:00", state: "offered" },
  { date: "2026-11-12", time: "10:30", state: "canceled" },
  { date: "2026-11-12", time: null },
  { date: "2026-11-13", time: "09:15", state: "offered" },
  { date: "2026-11-16", time: "13:00", state: "confirmed" },
];
const grounds = (facts: Fact[] = AFTER_M4): Grounds => ({ facts, statuses: new Set(["claim:accepted"]), today: "2026-11-05", scheduleRead: true, done: new Set(["message_imported", "claim_accepted"]) });

describe("L1: an explanation is logged with nothing to undo, and the eval does not count it", () => {
  it("a turn that explains a conflict reports no action that cannot be undone", async () => {
    const model = sequence(
      reply(fnCall("explain_conflict", { conflict_id: "change-proposed-20261112-1030" })),
      reply(message("Thursday 11/12 10:30 AM is confirmed, and the office proposed a change to it.")),
    );
    const report = await runChatEval({
      chatClient: model,
      client: RecordedModelClient.fromDirectory(),
      scripts: [{ id: "explain", title: "Explain", now: "2026-11-05T17:00:00.000Z", setup: { calendar: true, accepted: ["m1", "m2", "m3"], pending: [] }, steps: [{ say: "Why is Thursday in question?", expect: { tools: ["explain_conflict"], tools_any: [], cards: [], actions: [], actions_none: [], error: null, no_model_call: false, text_any: [], text_none: [], injection: false, slots: {}, slots_none: [] } }] }],
      runs: 1,
      maxUsd: 1,
    });
    const t = report.scripts[0]!.turnsDetail[0]!;
    expect(t.actions).toEqual(["conflict_explained"]);
    expect(t.notUndoable).toEqual([]);
    expect(t.nothingToUndo).toEqual(["conflict_explained"]);
    expect(report.scripts[0]!.notUndoableActions).toBe(0);
  });
});

describe("L2: m4's answer shapes, and demo:check shows replaced answers", () => {
  it("passes the tools' own label for a claim with no time, and still catches a wrong state", () => {
    expect(checkAnswer("Yes. Monday 11/16 1:00 PM is confirmed. Thursday 11/12, no time is canceled.", grounds())).toEqual([]);
    expect(checkAnswer("I accepted the confirmation for Monday 11/16 1:00 PM and the cancellation for Thursday 11/12, no time.", grounds())).toEqual([]);
    expect(checkAnswer("Thursday 11/12, no time is confirmed.", grounds())).toContain("state_mismatch");
    expect(checkAnswer("Thursday 11/12 is not canceled.", grounds())).toContain("state_mismatch");
  });

  it("reads pending items as claims waiting for review, not as a slot state", () => {
    const before: Fact[] = [{ date: "2026-11-10", time: "14:00", state: "offered" }, { date: "2026-11-12", time: "10:30", state: "confirmed" }];
    expect(checkAnswer("Accepted all 8 pending items for Tuesday 11/10 2:00 PM and Thursday 11/12 10:30 AM. You can undo any of them from the activity log.", grounds(before))).toEqual([]);
    expect(checkAnswer("Tuesday 11/10 2:00 PM is pending.", grounds(before))).toContain("state_mismatch");
  });

  it("demo:check prints each replaced answer with its problems", async () => {
    const lines: string[] = [];
    await runDemoCheck({ recorded: true, log: (l) => lines.push(l), chatClient: sequence(...Array.from({ length: 30 }, () => reply(message("Monday 11/16 3:00 PM is booked.")))) });
    expect(lines.some((l) => l.includes('replaced answer [ungrounded, state_mismatch]: "Monday 11/16 3:00 PM is booked."'))).toBe(true);
  }, 60_000);
});

describe("L3: the template call knows a slot with no time fits no template", () => {
  it("says so in its instructions", () => {
    expect(REPLY_INSTRUCTIONS).toContain("Every template needs the slot's date and time. A slot whose time is null fits no template: answer no fit with template_not_allowed.");
  });
});

// M1 and M2 pull against each other. Unsure cases fail safe: the person
// can enter a claim by hand.
describe("M1 and M2: negation in the claim's own clause and context", () => {
  type Case = [type: "confirm" | "cancel" | "offer" | "move", quote: string, text: string, negated: boolean];
  const cases: Case[] = [
    // M1: refused.
    ["confirm", "Your Monday visit", "Your Monday visit has no confirmation yet.", true],
    ["confirm", "Your Monday visit", "Your Monday visit has yet to be confirmed.", true],
    ["confirm", "Your Monday visit", "Your Monday visit is confirmed no longer.", true],
    ["confirm", "Your Monday visit", "Your Monday visit is not at this time in any way confirmed.", true],
    ["confirm", "Your Monday visit is scheduled.", "Your Monday visit is scheduled. It is not confirmed yet.", true],
    ["confirm", "Your Monday visit is scheduled.", "Your Monday visit is scheduled.\nThis is not confirmed yet.", true],
    ["confirm", "Monday", "Monday is not confirmed yet.", true],
    ["confirm", "Monday", "Monday is unconfirmed.", true],
    ["cancel", "Your Monday visit", "Your Monday visit is not canceled, it is confirmed.", true],
    ["offer", "Monday at 1:00 PM", "Monday at 1:00 PM is no longer available.", true],
    ["confirm", "Monday", "We are without confirmation for Monday.", true],
    // M2: real claims pass.
    ["confirm", "it is confirmed", "Your Monday visit is not canceled, it is confirmed.", false],
    ["confirm", "confirmed for Thursday", "Cannot wait, confirmed for Thursday.", false],
    ["confirm", "Cannot wait to see you Thursday, you are confirmed", "Cannot wait to see you Thursday, you are confirmed.", false],
    ["confirm", "Your visit is confirmed", "Your visit is confirmed, but the unconfirmed referral is still open.", false],
    ["confirm", "Your visit is confirmed", "Your visit is confirmed. The parking lot is not open.", false],
    ["confirm", "This confirms your appointment on Monday", "This confirms your appointment on Monday. No need to reply.", false],
    ["confirm", "You're confirmed for Monday 11/16 at 1:00 PM", "You're confirmed for Monday 11/16 at 1:00 PM. See you then.", false],
    ["cancel", "Your Thursday appointment is canceled.", "Your Thursday appointment is canceled. It is not rescheduled.", false],
  ];
  it.each(cases)("%s from %j in %j is negated: %s", (type, quote, text, negated) => {
    expect(negatedInMessage(type, quote, text)).toBe(negated);
  });
});

describe("M3: the agent names the message it applied", () => {
  it("its instructions say to name the message after an import", () => {
    expect(AGENT_INSTRUCTIONS).toContain("After you import a message, name it by its sender or its first words, and say which appointments its claims changed.");
  });
});

describe("M4: the action check on joined verbs", () => {
  const done = new Set(["message_imported", "claim_accepted"]);
  it.each([
    ["I saved your message and have confirmed Monday.", true],
    ["I saved the note that you sent and confirmed Monday.", true],
    ["I saved the message which arrived and confirmed Monday.", true],
    ["I reviewed your message and confirmed the time is 10:30.", false],
    ["I reviewed your message and confirmed that Monday is offered.", false],
    ["I see that the office confirmed Monday and canceled Thursday.", false],
    ["I see the office confirmed Monday and canceled Thursday.", false],
  ] as const)("%j claims an action: %s", (text, claims) => {
    expect(claimsAction(text, done)).toBe(claims);
  });
});

describe("M5 to M7: the scope check", () => {
  it.each([
    ["Tell me about my me di ca tion.", true],
    ["Tell me about my symp, toms.", true],
    ["Is the rapy needed?", true],
    ["The rapist was arrested near the office.", false],
    ["See the. Rapy", false],
    ["Les résultats du laboratoire sont arrivés.", true],
    ["Les résultats de laboratoire sont arrivés.", true],
    ["Meine Blutuntersuchung ist am Montag.", true],
    ["Die Untersuchungsergebnisse sind da.", true],
    ["Der Befund ist da.", true],
    ["Bitte zeigen Sie die Ergebnisse meiner Termine.", false],
  ] as const)("%j is clinical: %s", (text, clinical) => {
    expect(hasClinicalContent(text)).toBe(clinical);
  });
});

describe("M9: demo:check never waits forever on an app it cannot stop", () => {
  it("gives up after its limit when the app ignores SIGTERM and its identity no longer matches", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    cleanups.push(() => child.kill("SIGKILL"));
    await new Promise((r) => setTimeout(r, 300));
    const id = processIdentity(child.pid!);
    expect(id).not.toBeNull();
    let reads = 0;
    // The identity matches for the SIGTERM, then no longer does.
    const identityOf = (pid: number) => (reads++ === 0 ? processIdentity(pid) : null);
    const started = Date.now();
    expect(await stopChild(child, id, { killAfterMs: 100, giveUpMs: 400, identityOf })).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(child.exitCode).toBeNull();
  });
});
