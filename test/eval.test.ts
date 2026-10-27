import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/eval/cli.ts";
import { claimMatches, estimateUsd, percentile, scoreMessage, type EvalReport } from "../src/eval/eval.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
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

const claim = (over: Partial<EvidenceClaim["slot"]> & { claim_type?: EvidenceClaim["claim_type"] } = {}): EvidenceClaim => ({
  claim_type: over.claim_type ?? "offer",
  slot: { date: over.date ?? "2026-11-10", time: over.time ?? "14:00", location: over.location ?? null },
  quote: "q",
  source_type: "office_message",
  sender_kind: "person",
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
    expect(report.perEffort.map((e) => e.effort)).toEqual(["low", "minimal"]);
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
    const code = await main(["--max-usd", "0.004", "--out", out], { MODEL_API_KEY: KEY }, {
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
