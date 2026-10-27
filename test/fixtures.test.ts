import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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
        const issues = checkSlotValues({ date: e.date ?? null, time: e.time ?? null, event_time: null, quote: m.text });
        expect(issues.filter((i) => i !== "date_not_in_quote" || !e.date), `${m.id}`).toEqual([]);
      }
    }
  });

  it("keeps D2 and later expectations in stub fields", () => {
    for (const s of scenarios) for (const l of s.later) expect(l.deliverable).not.toBe("D1");
    expect(scenarios.find((s) => s.id === "S1")!.later[0]!.deliverable).toBe("D2");
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
