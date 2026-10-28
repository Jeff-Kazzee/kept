// The live meaning-flips run on cd91699 (Muse Spark 1.3, 3 runs), made
// deterministic.
// A. Run 1: the office message "Your Monday 11/16 1:00 PM visit is not
//    confirmed yet." gave a confirm claim, the agent accepted it, and Monday
//    was held. Code now refuses a claim whose sentence negates it.
// B. Every run: m4 pasted in the chat. Its claims came back with
//    sender_kind unknown, so rules 4 and 5 (0002) could not order them and
//    m4's confirmation and cancel never applied. The slot rules are right,
//    the extraction instructions now say what sender_kind means.
import { describe, expect, it } from "vitest";
import { claimsAction } from "../src/agent/grounding.ts";
import { checkClaim } from "../src/extract/extract.ts";
import { loadChatScripts, runChatEval } from "../src/eval/chat-eval.ts";
import { RecordedModelClient, readRecording, type Recording } from "../src/model/recorded.ts";
import { INSTRUCTIONS } from "../src/model/request.ts";
import { fromPackage } from "../src/paths.ts";
import { probeModel } from "./script-model.ts";

const NEGATED = "Lantern Hill Clinic: Your Monday 11/16 1:00 PM visit is not confirmed yet. We will text you when it is.";
const message = { id: "chat-a57326af", channel: "unknown" as const, from: "Unknown sender", received_at: "2026-11-05T10:00:00-07:00", text: NEGATED };
const confirm = (quote: string) => ({ claim_type: "confirm" as const, date: "2026-11-16", time: "13:00", location: null, quote, sender_kind: "person" as const, event_time: null, request_item: null });

// A recording that gives the claims `change` makes of the stored ones.
function variant(id: string, change: (claims: any[]) => any[]): Recording {
  const r = readRecording(fromPackage(`fixtures/recordings/minimal/${id}.json`));
  return { ...r, attempts: r.attempts.map((a) => ({ ...a, output: { claims: change((a.output as { claims: any[] }).claims) } })) };
}

async function flips(overrides: Recording[]) {
  const report = await runChatEval({
    chatClient: probeModel(),
    client: RecordedModelClient.withOverrides(overrides, RecordedModelClient.fromDirectory()),
    scripts: loadChatScripts().filter((s) => s.id === "meaning-flips"),
    runs: 1,
    maxUsd: 1,
  });
  return report.scripts[0]!.turnsDetail;
}

describe("live meaning-flips, A: a negated confirmation never holds a slot", () => {
  it("refuses a confirm claim whose sentence says it is not confirmed, whether or not the quote holds the negation", () => {
    expect(checkClaim(confirm("Your Monday 11/16 1:00 PM visit is not confirmed yet."), message)).toContain("negated_in_message");
    expect(checkClaim(confirm("Your Monday 11/16 1:00 PM visit"), message)).toContain("negated_in_message");
    // m4's real confirmation and cancel pass.
    const m4 = readRecording(fromPackage("fixtures/recordings/minimal/m4.json"));
    const m4Message = { id: "m4", channel: "email" as const, from: "Front Desk, Lantern Hill Clinic", received_at: "2026-11-06T09:00:00-07:00", text: "Hi Dana,\n\nThis confirms your appointment on Monday, November 16 at 1:00 PM at Lantern Hill Clinic, 400 Elm Street, Suite 2. Your Thursday, November 12 appointment is canceled.\n\nFront Desk\nLantern Hill Clinic" };
    for (const c of (m4.attempts[0]!.output as { claims: any[] }).claims) expect(checkClaim(c, m4Message), c.claim_type).toEqual([]);
  });

  it("the extraction instructions say a negated sentence gives no claim of that type", () => {
    expect(INSTRUCTIONS).toContain("A sentence that says a time is not confirmed, not canceled, not offered or not moved gives no claim of that type.");
  });

  it("with an extraction that confirms from the negated sentence, Monday stays offered, and the report lists each accepted claim", async () => {
    const wrong = variant("chat-a57326af", () => [confirm("Your Monday 11/16 1:00 PM visit is not confirmed yet.")]);
    const turns = await flips([wrong]);
    expect(turns[0]!.slotProblems).toEqual([]);
    expect(turns[0]!.acceptedClaims).toEqual([]);
    // Step 3 accepted the two offers, each listed with its slot and quote.
    expect(turns[2]!.acceptedClaims.map((c) => [c.claimType, c.status, c.date, c.time, c.quote, c.senderKind])).toEqual([
      ["offer", "accepted", "2026-11-13", "09:15", "At 9:15 AM on Friday 11/13", "person"],
      ["offer", "accepted", "2026-11-16", "13:00", "at 1:00 PM on Monday 11/16", "person"],
    ]);
  });
});

describe("live meaning-flips, B: m4's confirmation and cancel after the other messages", () => {
  it("apply when m4's claims say a person wrote it, as in the demo story", async () => {
    const turns = await flips([]);
    expect(turns[3]!.slotProblems).toEqual([]);
    expect(turns[3]!.acceptedClaims.map((c) => [c.claimType, c.date, c.time, c.senderKind])).toEqual([
      ["confirm", "2026-11-16", "13:00", "person"],
      ["cancel", "2026-11-12", null, "person"],
    ]);
  });

  it("stay unordered under rules 4 and 5 when the sender kind is unknown, as the live run gave, which the slot rules require", async () => {
    const unknown = variant("m4", (claims) => claims.map((c) => ({ ...c, sender_kind: "unknown" })));
    const turns = await flips([unknown]);
    expect(turns[3]!.slotProblems).toEqual(["2026-11-16T13:00 is change_proposed, expected confirmed", "2026-11-12T10:30 is change_proposed, expected canceled"]);
  });

  it("the extraction instructions say what sender_kind means, and that a pasted message's from and channel may be unknown", () => {
    expect(INSTRUCTIONS).toContain("sender_kind is who wrote the message, read from its text: person when a person at the office wrote it");
    expect(INSTRUCTIONS).toContain("The from and channel fields may be unknown for a pasted message.");
  });
});

// C. Runs 2 and 3, step 4, answered "I saved your office message and
// confirmed Monday 11/16 1:00 PM." No tool confirms anything, and the
// action check read "I" and "confirmed" only side by side.
describe("live meaning-flips, C: a verb joined to the assistant's own verb by and", () => {
  it("is held to the activity log like the first verb", () => {
    const done = new Set(["message_imported", "claim_accepted"]);
    for (const bad of ["I saved your office message and confirmed Monday 11/16 1:00 PM.", "I recorded the change and canceled Thursday.", "We added the message and then booked Monday."]) {
      expect(claimsAction(bad, done), bad).toBe(true);
    }
    for (const ok of [
      "I imported the message and accepted its claims.",
      "I see the office confirmed Monday and canceled Thursday.",
      "I checked your schedule and Monday is confirmed.",
      "I added the message, and the office confirmed Monday.",
    ]) {
      expect(claimsAction(ok, done), ok).toBe(false);
    }
  });
});
