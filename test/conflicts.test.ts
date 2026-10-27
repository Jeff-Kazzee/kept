import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { checkCitations, datesAndTimesSupported } from "../src/conflicts/check.ts";
import { explainConflict, explanationKey } from "../src/conflicts/explain.ts";
import { proposeQuestion, questionKey } from "../src/conflicts/question.ts";
import { hasClinicalContent } from "../src/domain/scope.ts";
import { RecordedModelClient, readRecording, type Recording } from "../src/model/recorded.ts";
import { fromPackage } from "../src/paths.ts";
import { projectSlots } from "../src/slots/project.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, ev, intake } from "./helpers.ts";

const recorded = RecordedModelClient.fromDirectory();
const fault = (name: string) => readRecording(fromPackage(`fixtures/recordings/faults/${name}.json`));
const usage = { input: 100, cached_input: 0, output: 20, reasoning: 0 };

async function caseOf(ids: string[]) {
  const service = intake(new EventStore());
  await acceptMessages(service, ids);
  const evidence = service.evidence();
  return { evidence, conflicts: projectSlots({ evidence }).conflicts };
}

const DEMO = ["m1", "m2", "m3"];
const STATES: Record<string, string[]> = {
  S2: ["m2", "s2-offer"],
  demo: DEMO,
  S4: ["m2", "m3", "s4-confirm"],
  S5: ["m2", "s5-report"],
  S6: ["m2", "s5-report", "s6-reminder"],
  S7: ["s7-confirm"],
};

describe("SP2.12 explanation call", () => {
  it("has a valid recorded explanation for every conflict in the fixture states", async () => {
    for (const [name, ids] of Object.entries(STATES)) {
      const { evidence, conflicts } = await caseOf(ids);
      for (const conflict of conflicts) {
        const result = await explainConflict(conflict, evidence, recorded);
        expect(result.attempts.map((a) => a.problems), `${name} ${conflict.id}`).toEqual([[]]);
        expect(result.outcome).toBe("valid");
        expect(result.evidenceIds.every((id) => conflict.evidenceIds.includes(id))).toBe(true);
      }
    }
  });

  it("demo: explains the change proposal with all four sources cited", async () => {
    const { evidence, conflicts } = await caseOf(DEMO);
    const result = await explainConflict(conflicts[0]!, evidence, recorded);
    expect(result.key).toBe("explain-change-proposed-20261112-1030-e21e7875");
    expect(result.evidenceIds).toEqual(["m2-e1", "m3-e1", "m3-e2", "m3-e3"]);
    expect(result.text).toMatch(/^The office confirmed your visit for Thursday, November 12 at 10:30 AM\./);
    expect(result.usage).toEqual({ input: 1040, cachedInput: 0, output: 150, reasoning: 50 });
  });

  for (const [name, problem] of [
    ["explain-unknown-id", "unknown_evidence_id"],
    ["explain-other-conflict-id", "evidence_not_in_conflict"],
    ["explain-invented-time", "invented_date_or_time"],
  ] as const) {
    it(`rejects ${name}, retries once, then shows no explanation`, async () => {
      const { evidence, conflicts } = await caseOf(DEMO);
      const client = RecordedModelClient.withOverrides([fault(name)]);
      const result = await explainConflict(conflicts[0]!, evidence, client);
      expect(client.calls).toHaveLength(2);
      expect(result.attempts.map((a) => a.problems)).toEqual([[problem], [problem]]);
      expect(result).toMatchObject({ outcome: "unavailable", text: null, evidenceIds: [] });
    });
  }

  it("keeps the retry's explanation when the retry passes", async () => {
    const { evidence, conflicts } = await caseOf(DEMO);
    const good = recorded.lookup(explanationKey(conflicts[0]!), "low")!.attempts[0]!;
    const client = RecordedModelClient.withOverrides([{ ...fault("explain-unknown-id"), attempts: [fault("explain-unknown-id").attempts[0]!, good] }]);
    const result = await explainConflict(conflicts[0]!, evidence, client);
    expect(result.attempts.map((a) => a.outcome)).toEqual(["invalid", "valid"]);
    expect(result.outcome).toBe("valid");
    expect(client.calls[1]!.body.instructions).toContain("rejected for: unknown_evidence_id.");
    expect(client.calls[1]!.body.input).toBe(client.calls[0]!.body.input);
  });

  it("rejects no citation, clinical words, text that is not JSON, and a failed call", async () => {
    const { evidence, conflicts } = await caseOf(DEMO);
    const key = explanationKey(conflicts[0]!);
    const run = async (attempts: Recording["attempts"]) => {
      const client = RecordedModelClient.withOverrides([{ message_id: key, effort: "any", attempts }]);
      return explainConflict(conflicts[0]!, evidence, client);
    };
    const none = await run([{ output: { explanation: "The office asked to move the visit.", evidence_ids: [] }, usage, latency_ms: 5 }]);
    expect(none.attempts.map((a) => a.problems)).toEqual([["no_citation"], ["no_citation"]]);
    const clinical = await run([{ output: { explanation: "The move may affect your treatment.", evidence_ids: ["m3-e1"] }, usage, latency_ms: 5 }]);
    expect(clinical.attempts[0]!.problems).toEqual(["clinical_content"]);
    const text = await run([{ output_text: "Here is an explanation.", usage, latency_ms: 5 }]);
    expect(text.attempts[0]!.problems).toEqual(["not_json"]);
    const extra = await run([{ output: { explanation: "x", evidence_ids: ["m2-e1"], note: "y" }, usage, latency_ms: 5 }]);
    expect(extra.attempts[0]!.problems).toEqual(["schema_mismatch"]);
    const failed = await run([{ error: { status: 503, message: "busy" }, usage, latency_ms: 5 }]);
    expect(failed.attempts.map((a) => a.problems)).toEqual([["call_failed"], ["call_failed"]]);
    expect(failed.outcome).toBe("unavailable");
  });

  it("sends only the conflict's evidence quotes, with store false and effort low", async () => {
    const { evidence, conflicts } = await caseOf(DEMO);
    const client = RecordedModelClient.withOverrides([], recorded);
    await explainConflict(conflicts[0]!, evidence, client);
    const body = client.calls[0]!.body;
    expect(body).toMatchObject({ model: "muse-spark-1.3", store: false, reasoning: { effort: "low" } });
    const input = JSON.parse(body.input) as { evidence: Array<{ id: string; quote: string }> };
    expect(input.evidence.map((e) => e.id)).toEqual(["m2-e1", "m3-e1", "m3-e2", "m3-e3"]);
    // m1 is in the case but not in this conflict. Full message text is never sent.
    expect(body.input).not.toContain("Tuesday, November 10");
    expect(body.input).not.toContain("Reply FRI or MON");
    expect(body.instructions).toMatch(/untrusted data/);
  });

  it("uses the effort option and refuses contributor models", async () => {
    const { evidence, conflicts } = await caseOf(DEMO);
    const client = RecordedModelClient.withOverrides([{ ...recorded.lookup(explanationKey(conflicts[0]!), "low")!, effort: "any" }]);
    await explainConflict(conflicts[0]!, evidence, client, { effort: "minimal" });
    expect(client.calls[0]!.body.reasoning.effort).toBe("minimal");
    await expect(explainConflict(conflicts[0]!, evidence, client, { model: "muse-spark-1.3-contributor" })).rejects.toThrow(/not allowed/);
  });
});

describe("SP2.13 next-question call", () => {
  it("has a valid recorded question for every fixture state", async () => {
    for (const [name, ids] of Object.entries(STATES)) {
      const { evidence, conflicts } = await caseOf(ids);
      const result = await proposeQuestion(conflicts, evidence, recorded);
      expect(result.attempts.map((a) => a.problems), name).toEqual([[]]);
      expect(result.origin).toBe("model");
      expect(result.text.endsWith("?")).toBe(true);
    }
  });

  it("demo: asks one question about the change proposal", async () => {
    const { evidence, conflicts } = await caseOf(DEMO);
    const result = await proposeQuestion(conflicts, evidence, recorded);
    expect(result).toMatchObject({
      key: questionKey(conflicts),
      origin: "model",
      conflictId: "change-proposed-20261112-1030",
      text: "The office needs to move your Thursday 11/12 10:30 AM visit. Which new time do you want to request?",
      evidenceIds: ["m3-e1", "m3-e2", "m3-e3"],
    });
    const input = JSON.parse(recorded.calls.at(-1)!.body.input) as { conflicts: Array<{ choices: string[] }> };
    expect(input.conflicts[0]!.choices).toEqual(["Request Friday 11/13 9:15 AM", "Request Monday 11/16 1:00 PM", "Not sure yet"]);
  });

  it("falls back to the fixed wording after a question names a conflict that is not open", async () => {
    const { evidence, conflicts } = await caseOf(DEMO);
    const client = RecordedModelClient.withOverrides([fault("question-unknown-conflict")]);
    const result = await proposeQuestion(conflicts, evidence, client);
    expect(client.calls).toHaveLength(2);
    expect(result.attempts.map((a) => a.problems)).toEqual([["conflict_not_open"], ["conflict_not_open"]]);
    expect(result).toMatchObject({
      origin: "fixed",
      conflictId: "change-proposed-20261112-1030",
      text: "The office proposed to move Thursday 11/12 10:30 AM. Which time do you want instead?",
      evidenceIds: conflicts[0]!.evidenceIds,
    });
  });

  it("rejects an invented date and a question without a question mark", async () => {
    const { evidence, conflicts } = await caseOf(DEMO);
    const client = RecordedModelClient.withOverrides([fault("question-invented-date")]);
    const result = await proposeQuestion(conflicts, evidence, client);
    expect(result.attempts.map((a) => a.problems)).toEqual([["invented_date_or_time"], ["not_a_question"]]);
    expect(result.origin).toBe("fixed");
  });

  it("checks citations against the chosen conflict", async () => {
    const { evidence, conflicts } = await caseOf(["m2", "s5-report", "s6-reminder"]);
    const key = questionKey(conflicts);
    const client = RecordedModelClient.withOverrides([
      {
        message_id: key,
        effort: "any",
        attempts: [
          { output: { conflict_id: "possibly-stale-20261112-1030", question: "Is the reminder out of date?", evidence_ids: ["s5-report-e1"] }, usage, latency_ms: 5 },
        ],
      },
    ]);
    const result = await proposeQuestion(conflicts, evidence, client);
    expect(result.attempts[0]!.problems).toEqual(["evidence_not_in_conflict"]);
    expect(result).toMatchObject({ origin: "fixed", conflictId: "possibly-stale-20261112-1030" });
  });
});

describe("citation and date checks", () => {
  const cited = [
    ev("a", "confirm", "2026-11-12", "10:30", "2026-10-31T09:12:00-06:00", { quote: "Thursday, November 12 at 10:30 AM" }),
  ];

  it("accepts dates, weekdays and times from the cited evidence", () => {
    expect(datesAndTimesSupported("Your Thursday 11/12 visit at 10:30 AM still holds.", cited)).toBe(true);
    expect(datesAndTimesSupported("The office wrote on October 31.", cited)).toBe(true);
    expect(datesAndTimesSupported("It is at 10:30.", cited)).toBe(true);
    expect(datesAndTimesSupported("No date here.", cited)).toBe(true);
  });

  it("rejects a date, weekday or time the evidence does not hold", () => {
    expect(datesAndTimesSupported("Your visit on 11/13 still holds.", cited)).toBe(false);
    expect(datesAndTimesSupported("Your Friday visit still holds.", cited)).toBe(false);
    expect(datesAndTimesSupported("It is at 11:30 AM.", cited)).toBe(false);
    expect(datesAndTimesSupported("It is at 3:30.", cited)).toBe(false);
  });

  it("review R1-3: checks the year of a date against the cited evidence", () => {
    expect(datesAndTimesSupported("Thursday, November 12, 2027 at 10:30 AM", cited)).toBe(false);
    expect(datesAndTimesSupported("Thursday, November 12, 2026 at 10:30 AM", cited)).toBe(true);
    expect(datesAndTimesSupported("11/12/2027", cited)).toBe(false);
    // A yearless quote read in late December may mean the next January.
    const january = [ev("j", "offer", null, null, "2026-12-20T09:00:00-07:00", { quote: "January 5 at 9:00 AM" })];
    expect(datesAndTimesSupported("January 5, 2027 at 9:00 AM", january)).toBe(true);
    expect(datesAndTimesSupported("January 5, 2028 at 9:00 AM", january)).toBe(false);
  });

  it("review R1-3: checks each mention as one unit against one cited source", () => {
    const two = [
      ...cited,
      ev("b", "confirm", "2026-11-16", "13:00", "2026-11-05T09:20:00-07:00", { quote: "Monday 11/16 at 1:00 PM" }),
    ];
    expect(datesAndTimesSupported("November 12 at 10:30 AM and November 16 at 1:00 PM", two)).toBe(true);
    expect(datesAndTimesSupported("November 12 at 1:00 PM", two)).toBe(false);
    expect(datesAndTimesSupported("November 16 at 10:30 AM", two)).toBe(false);
    expect(datesAndTimesSupported("Monday 11/12", two)).toBe(false);
    expect(datesAndTimesSupported("Thursday 11/16", two)).toBe(false);
    expect(datesAndTimesSupported("Thursday or Monday", two)).toBe(true);
  });

  it("review R1-3: an explanation that moves a cited time to another cited date is rejected", async () => {
    const { evidence, conflicts } = await caseOf(["m2", "m3", "s4-confirm"]);
    const key = explanationKey(conflicts[0]!);
    const output = { explanation: "The office confirmed November 12 at 1:00 PM and Monday 11/16.", evidence_ids: ["m2-e1", "s4-confirm-e1"] };
    const client = RecordedModelClient.withOverrides([{ message_id: key, effort: "any", attempts: [{ output, usage, latency_ms: 5 }] }]);
    const result = await explainConflict(conflicts[0]!, evidence, client);
    expect(result.attempts.map((a) => a.problems)).toEqual([["invented_date_or_time"], ["invented_date_or_time"]]);
  });

  it("names each citation problem once", () => {
    const caseIds = new Set(["a", "b"]);
    expect(checkCitations([], caseIds, new Set(["a"]))).toEqual(["no_citation"]);
    expect(checkCitations(["a", "x", "y"], caseIds, new Set(["a"]))).toEqual(["unknown_evidence_id"]);
    expect(checkCitations(["b"], caseIds, new Set(["a"]))).toEqual(["evidence_not_in_conflict"]);
    expect(checkCitations(["a"], caseIds, new Set(["a"]))).toEqual([]);
  });

  it("flags clinical words", () => {
    expect(hasClinicalContent("Your symptoms may change.")).toBe(true);
    expect(hasClinicalContent("Bring your new insurance card.")).toBe(false);
  });

  it("review R1-4: flags singular and plural clinical words", () => {
    expect(hasClinicalContent("Your lab result is ready for Thursday 11/12 at 10:30 AM")).toBe(true);
    for (const word of [
      "lab", "labs", "lab result", "test results", "biopsy", "biopsies", "cancer", "tumor", "tumour", "symptom",
      "diagnosis", "diagnosed", "treatment", "treated", "therapy", "medication", "medicine", "medical", "prescription",
      "pharmacy", "drug", "pill", "dose", "dosage", "blood", "scan", "X-ray", "xray", "MRI", "ultrasound", "screening",
      "surgery", "surgical", "illness", "disease", "disorder", "condition", "infection", "allergy", "pregnancy",
      "vaccine", "injection", "pain", "mental health", "chemotherapy", "radiation", "prognosis",
    ]) {
      expect(hasClinicalContent(`About your ${word} on Thursday.`), word).toBe(true);
    }
  });

  it("review R1-4: passes the administrative words, every fixture text and all recorded model output", async () => {
    for (const text of [
      "appointment", "visit", "clinic", "Lantern Hill Clinic", "insurance card", "arrive 15 minutes early", "Front Desk",
      "Reply C to confirm", "reminder", "confirmed", "canceled", "office", "Suite 2", "check in", "front desk",
    ]) {
      expect(hasClinicalContent(text), text).toBe(false);
    }
    const strings = (v: unknown): string[] =>
      typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
    const dir = fromPackage("fixtures/recordings");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      for (const a of readRecording(path.join(dir, f)).attempts) {
        for (const text of strings(a.output)) expect(hasClinicalContent(text), `${f}: ${text}`).toBe(false);
      }
    }
    // Code-built text: summaries, fixed questions and choice labels.
    for (const ids of Object.values(STATES)) {
      for (const c of (await caseOf(ids)).conflicts) {
        for (const text of [c.summary, c.fixedQuestion, ...c.choices.map((ch) => ch.label)]) {
          expect(hasClinicalContent(text), text).toBe(false);
        }
      }
    }
  });
});
