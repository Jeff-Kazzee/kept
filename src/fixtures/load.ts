import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { FIXTURES_DIR } from "../paths.ts";
import { BaseMessages, CaseProfile, Scenario, type FixtureMessage, type ResolvedScenario } from "./schema.ts";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function loadScenarios(fixturesDir: string = FIXTURES_DIR): ResolvedScenario[] {
  const base = BaseMessages.parse(readJson(path.join(fixturesDir, "d0-messages.json")));
  const scenarioDir = path.join(fixturesDir, "scenarios");
  const files = readdirSync(scenarioDir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
  const scenarios = files.map((f) => {
    const parsed = Scenario.safeParse(readJson(path.join(scenarioDir, f)));
    if (!parsed.success) throw new Error(`Invalid fixture ${f}: ${parsed.error.message}`);
    if (`${parsed.data.id}.json` !== f) throw new Error(`Fixture ${f} has id ${parsed.data.id}.`);
    return parsed.data;
  });

  const pool = new Map<string, FixtureMessage>();
  const add = (m: FixtureMessage, where: string) => {
    if (pool.has(m.id)) throw new Error(`Message id ${m.id} is defined twice (${where}). Use a ref.`);
    pool.set(m.id, m);
  };
  for (const m of base) add(m, "d0-messages.json");
  for (const s of scenarios) for (const m of s.messages) if (!("ref" in m)) add(m, s.id);

  return scenarios.map((s) => {
    const messages = s.messages.map((m) => {
      if (!("ref" in m)) return m;
      const found = pool.get(m.ref);
      if (!found) throw new Error(`${s.id} refers to unknown message ${m.ref}.`);
      return found;
    });
    if (s.model_fault && !messages.some((m) => m.id === s.model_fault!.message)) {
      throw new Error(`${s.id} model_fault names a message that is not in the scenario.`);
    }
    for (const [kind, checkpoints] of [["d2", s.d2 ?? []], ["d3", s.d3 ?? []], ["d4", s.d4 ?? []]] as const) {
      for (const step of checkpoints.flatMap((c) => c.steps)) {
        if ("message" in step && !messages.some((m) => m.id === step.message)) {
          throw new Error(`${s.id} ${kind} step names message ${step.message}, which is not in the scenario.`);
        }
      }
    }
    for (const id of (s.d3 ?? []).flatMap((c) => c.declined?.messages ?? [])) {
      if (!messages.some((m) => m.id === id)) throw new Error(`${s.id} d3 declines message ${id}, which is not in the scenario.`);
    }
    return { ...s, messages };
  });
}

// Every distinct message across the scenarios, in first-use order.
export function corpusMessages(scenarios: ResolvedScenario[]): FixtureMessage[] {
  const seen = new Map<string, FixtureMessage>();
  for (const s of scenarios) for (const m of s.messages) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()];
}

export function readFixtureText(relativePath: string, fixturesDir: string = FIXTURES_DIR): string {
  const resolved = path.resolve(fixturesDir, relativePath);
  if (!resolved.startsWith(path.resolve(fixturesDir) + path.sep)) {
    throw new Error("Fixture path leaves the fixtures directory.");
  }
  return readFileSync(resolved, "utf8");
}

// The synthetic case profile: the name that signs replies and the demo's
// time zone.
export function loadCaseProfile(fixturesDir: string = FIXTURES_DIR): CaseProfile {
  return CaseProfile.parse(readJson(path.join(fixturesDir, "case.json")));
}
