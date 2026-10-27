import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { corpusMessages, loadScenarios, readFixtureText } from "../src/fixtures/load.ts";
import { checkSlotValues, isValidDate, isValidTime } from "../src/domain/datetime.ts";
import { fromPackage } from "../src/paths.ts";

const scenarios = loadScenarios();

describe("fixtures", () => {
  it("has scenarios S1 to S12 in order", () => {
    expect(scenarios.map((s) => s.id)).toEqual(Array.from({ length: 12 }, (_, i) => `S${i + 1}`));
  });

  it("gives every message an explicit expected claim list", () => {
    for (const s of scenarios) {
      for (const m of s.messages) expect(Array.isArray(m.expected), `${s.id} ${m.id}`).toBe(true);
    }
    expect(scenarios.find((s) => s.id === "S11")!.messages[0]!.expected).toEqual([]);
  });

  it("reuses the D0 messages as the base of the demo story", () => {
    const d0 = JSON.parse(readFileSync(fromPackage("fixtures/d0-messages.json"), "utf8")) as Array<{ id: string }>;
    expect(d0.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    const s1 = scenarios.find((s) => s.id === "S1")!;
    expect(s1.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("states expected dates and times that are valid and match the message text", () => {
    for (const m of corpusMessages(scenarios)) {
      for (const e of m.expected) {
        if (e.date) expect(isValidDate(e.date), `${m.id} ${e.date}`).toBe(true);
        if (e.time) expect(isValidTime(e.time), `${m.id} ${e.time}`).toBe(true);
        const issues = checkSlotValues({
          date: e.date ?? null,
          time: e.time ?? null,
          event_time: null,
          quote: m.text,
          receivedAt: m.received_at,
        });
        expect(issues, `${m.id}`).toEqual([]);
      }
    }
  });

  it("assigns every later expectation to its deliverable", () => {
    const owners = Object.fromEntries(scenarios.map((s) => [s.id, s.later.map((l) => l.deliverable)]));
    expect(owners).toEqual({
      S1: [],
      S2: [],
      S3: [],
      S4: [],
      S5: [],
      S6: [],
      S7: ["D3"],
      S8: [],
      S9: ["D3"],
      S10: ["D4"],
      S11: ["product"],
      S12: ["D3"],
    });
  });

  it("turns every D2 stub into checkpoints for S1 to S7", () => {
    const counts = Object.fromEntries(scenarios.filter((s) => s.d2).map((s) => [s.id, s.d2!.length]));
    expect(counts).toEqual({ S1: 1, S2: 1, S3: 3, S4: 1, S5: 1, S6: 2, S7: 1 });
  });

  it("refuses a D2 step that names a message outside the scenario", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "d2-fixture-"));
    try {
      cpSync(fromPackage("fixtures"), dir, { recursive: true });
      const file = path.join(dir, "scenarios", "S1.json");
      const s1 = JSON.parse(readFileSync(file, "utf8"));
      s1.d2[0].steps.push({ message: "m4" });
      writeFileSync(file, JSON.stringify(s1));
      expect(() => loadScenarios(dir)).toThrow(/S1 d2 step names message m4/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ships the S8 fabricated recording and the calendar", () => {
    const s8 = scenarios.find((s) => s.id === "S8")!;
    expect(s8.model_fault?.message).toBe("s8-offer");
    expect(() => readFixtureText(s8.model_fault!.recording)).not.toThrow();
    for (const s of scenarios) if (s.calendar) expect(readFixtureText(s.calendar)).toContain("BEGIN:VCALENDAR");
    expect(() => readFixtureText("../package.json")).toThrow(/leaves/);
  });

  it("uses only the synthetic people and clinic", () => {
    const text = readdirSync(fromPackage("fixtures/scenarios"))
      .map((f) => readFileSync(fromPackage("fixtures/scenarios", f), "utf8"))
      .join("\n");
    const names = new Set(text.match(/\b(?:Dana Reyes|Lantern Hill Clinic)\b/g));
    expect(names).toEqual(new Set(["Dana Reyes", "Lantern Hill Clinic"]));
  });

  it("holds no clinical content outside the S11 out-of-scope question", () => {
    const clinical = /\b(diagnos\w*|symptom\w*|treatment|medication|medicine|prescri\w*|dose|dosage|lab results|test results|condition)\b/i;
    for (const m of corpusMessages(scenarios)) {
      if (m.id === "s11-question") continue;
      expect(clinical.test(m.text), m.id).toBe(false);
    }
  });
});
