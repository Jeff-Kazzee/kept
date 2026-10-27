import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/eval/cli.ts";
import type { ConflictEvalReport } from "../src/eval/conflict-eval.ts";
import type { ReplyEvalReport } from "../src/eval/reply-eval.ts";
import { claimMatches, estimateUsd, percentile, runEval, scoreMessage, type EvalReport } from "../src/eval/eval.ts";
import { corpusMessages, loadScenarios } from "../src/fixtures/load.ts";
import type { ModelCall, ModelClient } from "../src/model/client.ts";
import { MODEL } from "../src/model/request.ts";
import { RecordedModelClient, readRecording } from "../src/model/recorded.ts";
import { fromPackage } from "../src/paths.ts";
import type { EvidenceClaim } from "../src/domain/claim.ts";

const KEY = "sk-test-must-never-print";
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), "d1-eval-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const claim = (
  over: Partial<EvidenceClaim["slot"]> & { claim_type?: EvidenceClaim["claim_type"]; sender_kind?: EvidenceClaim["sender_kind"] } = {},
): EvidenceClaim => ({
  claim_type: over.claim_type ?? "offer",
  slot: { date: over.date ?? "2026-11-10", time: over.time ?? "14:00", location: over.location ?? null },
  quote: "q",
  source_type: "office_message",
  sender_kind: over.sender_kind ?? "person",
  evidence_time: "2026-10-30T15:04:00-06:00",
  event_time: null,
  request_item: null,
});

describe("scoring", () => {
  it("matches claim type, date and time, and location where the fixture states one", () => {
    expect(claimMatches({ claim_type: "offer", date: "2026-11-10", time: "14:00" }, claim())).toBe(true);
    expect(claimMatches({ claim_type: "offer", date: "2026-11-10", time: "14:00" }, claim({ claim_type: "confirm" }))).toBe(false);
    expect(claimMatches({ claim_type: "offer", date: "2026-11-10", time: "10:00" }, claim())).toBe(false);
    expect(claimMatches({ claim_type: "offer", location: "Elm Street office" }, claim({ location: "our Elm Street office" }))).toBe(true);
    expect(claimMatches({ claim_type: "offer", location: "Elm Street office" }, claim({ location: "Oak Avenue" }))).toBe(false);
    expect(claimMatches({ claim_type: "offer", location: null }, claim({ location: "Elm Street" }))).toBe(false);
    expect(claimMatches({ claim_type: "offer", time: null }, claim())).toBe(false);
  });

  it("finding 5: compares sender kind when the fixture states it", () => {
    const expected = { claim_type: "reminder" as const, date: "2026-11-12", time: "10:30", sender_kind: "automated" as const };
    const reminder = { claim_type: "reminder" as const, date: "2026-11-12", time: "10:30" };
    expect(claimMatches(expected, claim({ ...reminder, sender_kind: "person" }))).toBe(false);
    expect(claimMatches(expected, claim({ ...reminder, sender_kind: "automated" }))).toBe(true);
  });

  it("finding 6: needs the whole expected location, not one shared word", () => {
    expect(claimMatches({ claim_type: "offer", location: "Elm Street office" }, claim({ location: "Elm" }))).toBe(false);
    expect(claimMatches({ claim_type: "offer", location: "Elm Street office" }, claim({ location: "Street" }))).toBe(false);
    expect(claimMatches({ claim_type: "offer", location: "400 Elm Street, Suite 2" }, claim({ location: "Elm Street" }))).toBe(false);
    expect(
      claimMatches(
        { claim_type: "offer", location: "400 Elm Street, Suite 2" },
        claim({ location: "Lantern Hill Clinic, 400 Elm Street, Suite 2" }),
      ),
    ).toBe(true);
  });

  it("counts matched, missed and extra claims", () => {
    const score = scoreMessage(
      [
        { claim_type: "offer", date: "2026-11-10", time: "14:00" },
        { claim_type: "offer", date: "2026-11-12", time: "10:30" },
      ],
      [claim(), claim({ date: "2026-11-13" })],
    );
    expect(score.matched).toBe(1);
    expect(score.missed).toHaveLength(1);
    expect(score.extra).toHaveLength(1);
  });

  it("prices tokens at the Standard rates and computes percentiles", () => {
    expect(estimateUsd({ input: 1_000_000, cachedInput: 0, output: 0, reasoning: 0 })).toBeCloseTo(1.25);
    expect(estimateUsd({ input: 1_000_000, cachedInput: 1_000_000, output: 0, reasoning: 0 })).toBeCloseTo(0.15);
    expect(estimateUsd({ input: 0, cachedInput: 0, output: 1_000_000, reasoning: 500_000 })).toBeCloseTo(4.25);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("eval:live logic against the recorded client", () => {
  it("finding 7: reports the lowest run beside the pooled criterion", async () => {
    // Drops one m1 claim on the third run at effort low.
    const recorded = RecordedModelClient.fromDirectory();
    let m1Calls = 0;
    const client: ModelClient = {
      label: "degraded",
      async call(request: ModelCall) {
        const reply = await recorded.call(request);
        if (request.key === "m1" && request.effort === "low" && ++m1Calls === 3) {
          const out = JSON.parse(reply.outputText) as { claims: unknown[] };
          return { ...reply, outputText: JSON.stringify({ claims: out.claims.slice(0, 1) }) };
        }
        return reply;
      },
    };
    const scenarios = loadScenarios();
    const messages = corpusMessages(scenarios);
    const report = await runEval({
      client,
      messages,
      maxUsd: 5,
      model: MODEL,
      fabricated: {
        message: messages.find((m) => m.id === "s8-offer")!,
        recording: readRecording(fromPackage("fixtures/recordings/faults/s8-offer-fabricated.json")),
      },
    });
    const low = report.perEffort.find((e) => e.effort === "low")!;
    expect(low.runs.map((r) => r.matched)).toEqual([17, 17, 16]);
    expect(low.totals.accuracy).toBeCloseTo(50 / 51);
    expect(low.meetsTarget).toBe(true);
    expect(low.minRunAccuracy).toBeCloseTo(16 / 17);
    expect(low.everyRunMeetsTarget).toBe(false);
    expect(report.perEffort.find((e) => e.effort === "minimal")!.everyRunMeetsTarget).toBe(true);
  });

  it("runs both effort levels three times and writes a full report", async () => {
    const out = path.join(tempDir(), "report.json");
    const lines: string[] = [];
    const code = await main(["--out", out], { MODEL_API_KEY: KEY }, {
      createClient: () => RecordedModelClient.fromDirectory(),
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")) as EvalReport;
    expect(report.perEffort.map((e) => e.effort)).toEqual(["minimal", "low"]);
    for (const e of report.perEffort) {
      expect(e.runs.map((r) => r.run)).toEqual([1, 2, 3]);
      expect(e.totals.accuracy).toBe(1);
      expect(e.meetsTarget).toBe(true);
      expect(e.calls).toBe(report.corpus.messages * 3);
      expect(e.latencyMs.p50).toBeGreaterThan(0);
      expect(e.latencyMs.p95).toBeGreaterThanOrEqual(e.latencyMs.p50!);
      expect(e.costUsd).toBeCloseTo(estimateUsd(e.usage));
    }
    expect(report.corpus).toEqual({ messages: 11, expectedClaims: 17 });
    expect(report.calls).toHaveLength(66);
    expect(report.quoteCheck.rejectionsTotal).toBe(0);
    expect(report.s8).toMatchObject({ fabricatedClaims: 2, rejected: 2, rejectionRate: 1, manualEntry: true, passed: true });
    expect(report.usageTotal.input).toBe(report.perEffort[0]!.usage.input + report.perEffort[1]!.usage.input);
    expect(report.costUsdTotal).toBeCloseTo(estimateUsd(report.usageTotal));
    const printed = lines.join("\n");
    expect(printed).toContain("[low] accuracy 100.0%");
    expect(printed).toContain("S8 fabricated quote: 2/2 rejected (100.0%)");
    expect(printed).not.toContain(KEY);
    expect(readFileSync(out, "utf8")).not.toContain(KEY);
  });

  it("stops before a call once the spend estimate reaches the limit", async () => {
    const out = path.join(tempDir(), "report.json");
    const code = await main(["--max-usd", "0.002", "--out", out], { MODEL_API_KEY: KEY }, {
      createClient: () => RecordedModelClient.fromDirectory(),
      log: () => {},
    });
    expect(code).toBe(3);
    const report = JSON.parse(readFileSync(out, "utf8")) as EvalReport;
    expect(report.stoppedBySpendGuard).toBe(true);
    expect(report.calls).toHaveLength(2);
    expect(report.perEffort[0]!.runs[0]!.complete).toBe(false);
    expect(report.perEffort[0]!.meetsTarget).toBe(false);
  });

  it("exits nonzero without MODEL_API_KEY and writes nothing", async () => {
    const out = path.join(tempDir(), "report.json");
    const errors: string[] = [];
    const code = await main(["--out", out], {}, { error: (l) => errors.push(l), log: () => {} });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/MODEL_API_KEY is not set/);
    expect(existsSync(out)).toBe(false);
  });

  it("runs as a script from another directory and resolves paths from the package", () => {
    const cwd = tempDir();
    const out = path.join(cwd, "smoke.json");
    const script = fromPackage("scripts/eval-live.ts");
    const env = { ...process.env, MODEL_API_KEY: "" };
    const noKey = spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8" });
    expect(noKey.status).toBe(2);
    const stdout = execFileSync(process.execPath, [script, "--recorded", "--out", out], { cwd, env, encoding: "utf8" });
    expect(stdout).toContain("S8 fabricated quote: 2/2 rejected");
    expect(JSON.parse(readFileSync(out, "utf8")).client).toBe("recorded");
  });
});

describe("SP2.16 eval:live for the explanation and question calls", () => {
  const recordedClient = () => RecordedModelClient.fromDirectory();

  it("--d2-only runs both calls three times over the conflict fixtures and writes a report", async () => {
    const out = path.join(tempDir(), "d2.json");
    const lines: string[] = [];
    const code = await main(["--d2-only", "--out", out], { MODEL_API_KEY: KEY }, {
      createClient: recordedClient,
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")) as ConflictEvalReport;
    expect(report).toMatchObject({ effort: "low", runs: 3, stoppedBySpendGuard: false, corpus: { explanationInputs: 6, questionInputs: 6 } });
    for (const kind of [report.explanation, report.question]) {
      expect(kind).toMatchObject({ items: 6, calls: 18, validCitationRate: 1, validRate: 1, fallbacks: 0, rejections: {} });
      expect(kind.latencyMs.p50).toBeGreaterThan(0);
      expect(kind.latencyMs.p95).toBeGreaterThanOrEqual(kind.latencyMs.p50!);
      expect(kind.costUsd).toBeCloseTo(estimateUsd(kind.usage));
    }
    expect(report.calls.every((c) => c.key.startsWith("explain-") || c.key.startsWith("question-"))).toBe(true);
    expect(report.runResults.map((r) => r.complete)).toEqual([true, true, true]);
    const printed = lines.join("\n");
    expect(printed).toContain("[explanation] valid citations 100.0% of parsed attempts, valid results 100.0%, fallbacks 0, calls 18");
    expect(printed).not.toContain("[low] accuracy");
    expect(printed).not.toContain(KEY);
  });

  it("--d2 adds the D2 report after the extraction runs", async () => {
    const out = path.join(tempDir(), "both.json");
    const code = await main(["--d2", "--out", out], { MODEL_API_KEY: KEY }, { createClient: recordedClient, log: () => {} });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")) as EvalReport & { d2: ConflictEvalReport };
    expect(report.perEffort.map((e) => e.effort)).toEqual(["minimal", "low"]);
    expect(report.d2.explanation.calls).toBe(18);
    expect(report.d2.maxUsd).toBeCloseTo(5 - report.costUsdTotal);
  });

  it("counts rejections by reason and fallbacks", async () => {
    const recorded = RecordedModelClient.fromDirectory();
    const faults = RecordedModelClient.withOverrides(
      [
        readRecording(fromPackage("fixtures/recordings/faults/explain-unknown-id.json")),
        readRecording(fromPackage("fixtures/recordings/faults/question-invented-date.json")),
      ],
      recorded,
    );
    const out = path.join(tempDir(), "faults.json");
    const code = await main(["--d2-only", "--out", out], { MODEL_API_KEY: KEY }, { createClient: () => faults, log: () => {} });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")) as ConflictEvalReport;
    expect(report.explanation).toMatchObject({ calls: 21, fallbacks: 3, rejections: { unknown_evidence_id: 6 } });
    expect(report.explanation.validCitationRate).toBeCloseTo(15 / 21);
    expect(report.explanation.validRate).toBeCloseTo(15 / 18);
    expect(report.question).toMatchObject({ calls: 21, fallbacks: 3, rejections: { invented_date_or_time: 3, not_a_question: 3 } });
    expect(report.question.validCitationRate).toBe(1);
  });

  it("review R1-5: does not count a question that names a closed conflict as citation-valid", async () => {
    const faults = RecordedModelClient.withOverrides(
      [readRecording(fromPackage("fixtures/recordings/faults/question-unknown-conflict.json"))],
      RecordedModelClient.fromDirectory(),
    );
    const out = path.join(tempDir(), "closed.json");
    expect(await main(["--d2-only", "--out", out], { MODEL_API_KEY: KEY }, { createClient: () => faults, log: () => {} })).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")) as ConflictEvalReport;
    expect(report.question).toMatchObject({ calls: 21, fallbacks: 3, rejections: { conflict_not_open: 6, evidence_not_in_conflict: 6 } });
    expect(report.question.validCitationRate).toBeCloseTo(15 / 21);
  });

  it("stops the D2 calls at the spend limit and refuses a bad effort", async () => {
    const out = path.join(tempDir(), "guard.json");
    const code = await main(["--d2-only", "--max-usd", "0.001", "--out", out], { MODEL_API_KEY: KEY }, {
      createClient: recordedClient,
      log: () => {},
    });
    expect(code).toBe(3);
    const report = JSON.parse(readFileSync(out, "utf8")) as ConflictEvalReport;
    expect(report.stoppedBySpendGuard).toBe(true);
    expect(report.runResults[0]!.complete).toBe(false);
    const errors: string[] = [];
    expect(await main(["--d2-only", "--d2-effort", "high"], { MODEL_API_KEY: KEY }, { error: (l) => errors.push(l), log: () => {} })).toBe(2);
    expect(errors.join("\n")).toMatch(/--d2-effort must be minimal or low/);
  });
});

describe("SP3.10 eval:live for the reply template call", () => {
  const recordedClient = () => RecordedModelClient.fromDirectory();

  it("--d3-only runs the template call three times over the D3 fixtures and writes a report", async () => {
    const out = path.join(tempDir(), "d3.json");
    const lines: string[] = [];
    const code = await main(["--d3-only", "--out", out], { MODEL_API_KEY: KEY }, { createClient: recordedClient, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")) as ReplyEvalReport;
    // Four notes on the demo case (S3), the S7 slot without a time, two S9
    // notes no template fits, and S12.
    expect(report).toMatchObject({ effort: "low", runs: 3, stoppedBySpendGuard: false, corpus: { inputs: 8, withExpectedPick: 8 } });
    expect(report.validTemplateRate).toBeCloseTo(15 / 24);
    // The model picks as expected wherever a template fits.
    expect(report.modelPickRate).toBe(1);
    // The S7 and S9 notes expect no pick. The system outcome meets it through
    // the code fallback, but the model still proposed a pick every time.
    expect(report.expectedOutcomeRate).toBe(1);
    expect(report.noFit).toEqual({ results: 9, modelProposedPick: 9 });
    const s9 = report.runResults[0]!.items.find((i) => i.source === "S9.1")!;
    expect(s9).toMatchObject({
      outcome: "manual_needed",
      pick: null,
      modelPick: { template: "accept_offer", slot: "2026-11-11T15:00" },
      expected: null,
      outcomeMatches: true,
      modelPickMatches: null,
    });
    expect(report).toMatchObject({ fallbacks: 9, calls: 33, rejections: { missing_field: 6, template_not_valid_for_state: 6, unknown_slot: 6 } });
    expect(report.latencyMs.p50).toBeGreaterThan(0);
    expect(report.latencyMs.p95).toBeGreaterThanOrEqual(report.latencyMs.p50!);
    expect(report.costUsd).toBeCloseTo(estimateUsd(report.usage));
    expect(report.callLog.every((c) => c.key.startsWith("reply-") && c.effort === "low")).toBe(true);
    expect(report.runResults.map((r) => r.complete)).toEqual([true, true, true]);
    const printed = lines.join("\n");
    expect(printed).toContain(
      "[template] valid templates 62.5%, model picks as expected 100.0%, system outcomes as expected 100.0%, fallbacks 9, calls 33",
    );
    expect(printed).toContain("no template fits: 9 results, the model still proposed a pick that code blocked in 9");
    expect(printed).toContain("rejections by reason: missing_field 6, unknown_slot 6, template_not_valid_for_state 6");
    expect(printed).not.toContain("[low] accuracy");
    expect(printed).not.toContain(KEY);
  });

  it("--d3 adds the D3 report after extraction, and --d2-only --d3-only writes both without extraction", async () => {
    const out = path.join(tempDir(), "with-d3.json");
    expect(await main(["--d3", "--out", out], { MODEL_API_KEY: KEY }, { createClient: recordedClient, log: () => {} })).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")) as EvalReport & { d3: ReplyEvalReport };
    expect(report.perEffort.map((e) => e.effort)).toEqual(["minimal", "low"]);
    expect(report.d3.calls).toBe(33);
    expect(report.d3.maxUsd).toBeCloseTo(5 - report.costUsdTotal);
    expect(report).not.toHaveProperty("d2");

    const both = path.join(tempDir(), "d2-d3.json");
    expect(await main(["--d2-only", "--d3-only", "--out", both], { MODEL_API_KEY: KEY }, { createClient: recordedClient, log: () => {} })).toBe(0);
    const pair = JSON.parse(readFileSync(both, "utf8")) as { d2: ConflictEvalReport; d3: ReplyEvalReport };
    expect(pair).not.toHaveProperty("perEffort");
    expect(pair.d2.explanation.calls).toBe(18);
    expect(pair.d3.calls).toBe(33);
    expect(pair.d3.maxUsd).toBeCloseTo(5 - pair.d2.costUsdTotal);
  });

  it("counts a rejected field value and the wrong-pick rate", async () => {
    const faults = RecordedModelClient.withOverrides(
      [readRecording(fromPackage("fixtures/recordings/faults/reply-field-mismatch.json"))],
      RecordedModelClient.fromDirectory(),
    );
    const out = path.join(tempDir(), "d3-faults.json");
    expect(await main(["--d3-only", "--out", out], { MODEL_API_KEY: KEY }, { createClient: () => faults, log: () => {} })).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")) as ReplyEvalReport;
    expect(report).toMatchObject({ fallbacks: 12, calls: 36, rejections: { field_mismatch: 6 } });
    // The model named the right template and slot with a wrong field value,
    // so its pick still matches while the system outcome does not.
    expect(report.modelPickRate).toBe(1);
    expect(report.expectedOutcomeRate).toBeCloseTo(21 / 24);
  });

  it("stops the template call at the spend limit and refuses a bad effort", async () => {
    const out = path.join(tempDir(), "d3-guard.json");
    const code = await main(["--d3-only", "--max-usd", "0.001", "--out", out], { MODEL_API_KEY: KEY }, { createClient: recordedClient, log: () => {} });
    expect(code).toBe(3);
    const report = JSON.parse(readFileSync(out, "utf8")) as ReplyEvalReport;
    expect(report).toMatchObject({ stoppedBySpendGuard: true, calls: 1 });
    expect(report.runResults[0]!.complete).toBe(false);
    const errors: string[] = [];
    expect(await main(["--d3-only", "--d3-effort", "high"], { MODEL_API_KEY: KEY }, { error: (l) => errors.push(l), log: () => {} })).toBe(2);
    expect(errors.join("\n")).toMatch(/--d3-effort must be minimal or low/);
  });
});
