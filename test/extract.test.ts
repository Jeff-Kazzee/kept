import { describe, expect, it, vi } from "vitest";
import { extractClaims, MAX_ATTEMPTS } from "../src/extract/extract.ts";
import { corpusMessages, loadScenarios } from "../src/fixtures/load.ts";
import { MetaResponsesClient, ModelCallError } from "../src/model/client.ts";
import { RecordedModelClient, readRecording, type Recording } from "../src/model/recorded.ts";
import { buildRequestBody, MODEL } from "../src/model/request.ts";
import { fromPackage } from "../src/paths.ts";
import type { Message } from "../src/domain/claim.ts";
import { NETWORK_BLOCKED } from "./setup.ts";

const scenarios = loadScenarios();
const corpus = corpusMessages(scenarios);
const byId = (id: string) => corpus.find((m) => m.id === id)!;
const recorded = RecordedModelClient.fromDirectory();
const usage = { input: 100, cached_input: 0, output: 20, reasoning: 0 };

const validM1 = recorded.lookup("m1", "low")!.attempts[0]!;
const fabricated = readRecording(fromPackage("fixtures/recordings/faults/s8-offer-fabricated.json"));

function faultClient(messageId: string, attempts: Recording["attempts"]) {
  return RecordedModelClient.withOverrides([{ message_id: messageId, effort: "any", attempts }]);
}

describe("recorded responses", () => {
  it("cover every corpus message at both effort levels and pass every check", async () => {
    for (const effort of ["low", "minimal"] as const) {
      for (const m of corpus) {
        const result = await extractClaims(m, recorded, { effort });
        expect(result.attempts, `${m.id} ${effort}`).toHaveLength(1);
        expect(result.rejected, `${m.id} ${effort}`).toEqual([]);
        expect(result.needsManualEntry).toBe(false);
        expect(result.passed.map((c) => c.claim_type).sort(), m.id).toEqual(m.expected.map((e) => e.claim_type).sort());
      }
    }
  });

  it("sets source type from the channel and evidence time from the message", async () => {
    const report = await extractClaims(byId("s5-report"), recorded, { effort: "low" });
    expect(report.passed.every((c) => c.source_type === "reported_by_user")).toBe(true);
    expect(report.passed[0]!.evidence_time).toBe("2026-11-05T12:10:00-07:00");
    const office = await extractClaims(byId("m2"), recorded, { effort: "low" });
    expect(office.passed.every((c) => c.source_type === "office_message")).toBe(true);
    expect(office.passed.filter((c) => c.claim_type === "office_request").map((c) => c.request_item)).toEqual([
      "Bring new insurance card",
      "Arrive 15 minutes early",
    ]);
  });

  it("returns token usage and latency per call", async () => {
    const result = await extractClaims(byId("m1"), recorded, { effort: "low" });
    expect(result.attempts[0]!.usage).toEqual({ input: 780, cachedInput: 0, output: 260, reasoning: 90 });
    expect(result.attempts[0]!.latencyMs).toBe(1800);
    expect(result.usage).toEqual(result.attempts[0]!.usage);
  });
});

describe("S8 and the one-retry rule", () => {
  it("S8: rejects a fabricated quote, retries once, then falls to manual entry", async () => {
    const client = RecordedModelClient.withOverrides([fabricated]);
    const result = await extractClaims(byId("s8-offer"), client, { effort: "low" });
    expect(client.calls).toHaveLength(MAX_ATTEMPTS);
    expect(result.attempts.map((a) => [a.outcome, a.problem])).toEqual([
      ["invalid", "claim_checks_failed"],
      ["invalid", "claim_checks_failed"],
    ]);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((r) => r.problems.includes("quote_not_in_source"))).toBe(true);
    expect(result.passed).toEqual([]);
    expect(result.needsManualEntry).toBe(true);
  });

  it("S8: keeps the retry's claims when the retry passes", async () => {
    const good = recorded.lookup("s8-offer", "low")!.attempts[0]!;
    const client = faultClient("s8-offer", [fabricated.attempts[0]!, good]);
    const result = await extractClaims(byId("s8-offer"), client, { effort: "low" });
    expect(client.calls).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.passed).toHaveLength(1);
    expect(result.needsManualEntry).toBe(false);
  });

  it("retries once on output that is not JSON", async () => {
    const client = faultClient("m1", [{ output_text: "Sure, here are the claims.", usage, latency_ms: 5 }, validM1]);
    const result = await extractClaims(byId("m1"), client, { effort: "low" });
    expect(result.attempts.map((a) => a.problem)).toEqual(["not_json", null]);
    expect(result.passed).toHaveLength(2);
  });

  it("never calls more than twice, even when every attempt is invalid", async () => {
    const client = faultClient("m1", [{ output: { claims: [{ claim_type: "offer" }] }, usage, latency_ms: 5 }]);
    const result = await extractClaims(byId("m1"), client, { effort: "minimal" });
    expect(client.calls).toHaveLength(2);
    expect(result.attempts.map((a) => a.problem)).toEqual(["schema_mismatch", "schema_mismatch"]);
    expect(result.needsManualEntry).toBe(true);
  });

  it("treats a failed call as an invalid attempt", async () => {
    const client = faultClient("m1", [{ error: { status: 503, message: "busy" }, usage, latency_ms: 5 }]);
    const result = await extractClaims(byId("m1"), client, { effort: "low" });
    expect(client.calls).toHaveLength(2);
    expect(result.attempts.map((a) => a.problem)).toEqual(["call_failed", "call_failed"]);
    expect(result.needsManualEntry).toBe(true);
  });

  it("keeps passing claims of a final invalid attempt and rejects the rest", async () => {
    const claims = (validM1.output as { claims: Array<Record<string, unknown>> }).claims;
    const mixed = { claims: [claims[0], { ...claims[1], quote: "Thursday at 10:30 AM" }] };
    const client = faultClient("m1", [{ output: mixed, usage, latency_ms: 5 }]);
    const result = await extractClaims(byId("m1"), client, { effort: "low" });
    expect(result.passed.map((c) => c.slot.date)).toEqual(["2026-11-10"]);
    expect(result.rejected).toHaveLength(2);
    expect(result.needsManualEntry).toBe(true);
  });

  it("sends only problem codes on the retry, never message text", async () => {
    const client = RecordedModelClient.withOverrides([fabricated]);
    await extractClaims(byId("s8-offer"), client, { effort: "low" });
    const [first, second] = client.calls;
    expect(first!.attempt).toBe(1);
    expect(second!.attempt).toBe(2);
    expect(first!.body.instructions).not.toContain("previous answer");
    expect(second!.body.instructions).toContain("rejected for: quote_not_in_source, location_not_in_source.");
    expect(second!.body.input).toBe(first!.body.input);
  });

  it("rejects dates and times that contradict the quote instead of guessing", async () => {
    const claims = (validM1.output as { claims: Array<Record<string, unknown>> }).claims;
    const wrong = { claims: [{ ...claims[0], time: "02:00" }, { ...claims[1], date: "2026-11-13" }] };
    const client = faultClient("m1", [{ output: wrong, usage, latency_ms: 5 }]);
    const result = await extractClaims(byId("m1"), client, { effort: "low" });
    expect(result.rejected.map((r) => r.problems)).toEqual([
      ["time_not_in_quote"],
      ["date_not_in_quote"],
      ["time_not_in_quote"],
      ["date_not_in_quote"],
    ]);
    expect(result.passed).toEqual([]);
  });
});

describe("review round 1 findings", () => {
  const claims = () => (validM1.output as { claims: Array<Record<string, unknown>> }).claims;
  const run = async (messageId: string, output: unknown) => {
    const client = faultClient(messageId, [{ output, usage, latency_ms: 5 }]);
    return extractClaims(byId(messageId), client, { effort: "low" });
  };

  it("finding 1: rejects a partial quote that supports an invented date and time", async () => {
    const result = await run("m1", { claims: [{ ...claims()[0], quote: "Tuesday", date: "2026-11-17", time: "09:00" }] });
    expect(result.rejected[0]!.problems).toEqual(["date_outside_window", "time_not_in_quote"]);
    const fragment = await run("m1", { claims: [{ ...claims()[0], quote: "uesda", date: null, time: null }] });
    expect(fragment.rejected[0]!.problems).toEqual(["quote_not_in_source"]);
  });

  it("finding 2: rejects a date and time taken from different offers in one quote", async () => {
    const whole = byId("m1").text;
    const result = await run("m1", { claims: [{ ...claims()[0], quote: whole, date: "2026-11-10", time: "10:30" }] });
    expect(result.rejected[0]!.problems).toEqual(["time_not_in_quote"]);
    const good = await run("m1", { claims: [{ ...claims()[0], quote: whole, date: "2026-11-10", time: "14:00" }] });
    expect(good.rejected).toEqual([]);
  });

  it("finding 3: rejects an unsupported location, request item and event time", async () => {
    const location = await run("m1", { claims: [{ ...claims()[0], location: "Oak Avenue clinic" }] });
    expect(location.rejected[0]!.problems).toEqual(["location_not_in_source"]);
    const m2 = recorded.lookup("m2", "low")!.attempts[0]!.output as { claims: Array<Record<string, unknown>> };
    const item = await run("m2", { claims: [{ ...m2.claims[1], request_item: "bring a passport" }] });
    expect(item.rejected[0]!.problems).toEqual(["request_item_not_in_quote"]);
    const event = await run("m1", { claims: [{ ...claims()[0], event_time: "2026-11-03T09:00:00-07:00" }] });
    expect(event.rejected[0]!.problems).toEqual(["event_time_not_in_quote"]);
  });

  it("finding 3: keeps sender_kind as an unchecked model judgment for review", async () => {
    const result = await run("m1", { claims: [{ ...claims()[0], sender_kind: "automated" }] });
    expect(result.rejected).toEqual([]);
    expect(result.passed[0]!.sender_kind).toBe("automated");
  });

  it("finding 8: treats unknown fields in model output as invalid output", async () => {
    const extraOnClaim = await run("m1", { claims: [{ ...claims()[0], approved: true }] });
    expect(extraOnClaim.attempts.map((a) => a.problem)).toEqual(["schema_mismatch", "schema_mismatch"]);
    expect(extraOnClaim.needsManualEntry).toBe(true);
    const extraOnRoot = await run("m1", { claims: claims(), note: "x" });
    expect(extraOnRoot.attempts[0]!.problem).toBe("schema_mismatch");
  });
});

describe("model client", () => {
  const message: Message = byId("m1");

  it("builds the D0 request shape with store false and configurable effort", () => {
    const body = buildRequestBody(message, "minimal");
    expect(body).toMatchObject({
      model: MODEL,
      store: false,
      reasoning: { effort: "minimal" },
      text: { format: { type: "json_schema", name: "appointment_claims", strict: false } },
    });
    expect(JSON.parse(body.input)).toEqual({
      channel: "sms",
      from: "Lantern Hill Clinic",
      received_at: message.received_at,
      text: message.text,
    });
  });

  it("refuses contributor models", async () => {
    expect(() => buildRequestBody(message, "low", [], "muse-spark-1.3-contributor")).toThrow(/not allowed/);
    await expect(extractClaims(message, recorded, { effort: "low", model: "muse-spark-1.3-contributor" })).rejects.toThrow(
      /not allowed/,
    );
  });

  it("cannot reach the network in tests", async () => {
    const live = new MetaResponsesClient({ apiKey: "test-key-not-real" });
    const err = await live
      .call({ key: "m1", attempt: 1, effort: "low", body: buildRequestBody(message, "low") })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(() => fetch("https://api.meta.ai/v1/responses")).toThrow(NETWORK_BLOCKED);
  });

  it("sends the key only in the Authorization header and keeps it out of errors", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response('{"error":"bad request"}', { status: 400 });
    });
    const live = new MetaResponsesClient({ apiKey: "secret-value-123" });
    const err = (await live
      .call({ key: "m1", attempt: 1, effort: "low", body: buildRequestBody(message, "low") })
      .catch((e: unknown) => e)) as ModelCallError;
    expect(err.status).toBe(400);
    expect(err.message).not.toContain("secret-value-123");
    expect(seen[0]!.url).toBe("https://api.meta.ai/v1/responses");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer secret-value-123");
    expect(String(seen[0]!.init.body)).not.toContain("secret-value-123");
    expect(JSON.parse(String(seen[0]!.init.body)).store).toBe(false);
  });

  it("parses output text and usage from a Responses API body", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        output: [
          { type: "reasoning", summary: [] },
          { type: "message", content: [{ type: "output_text", text: '{"claims":[]}' }] },
        ],
        usage: {
          input_tokens: 900,
          input_tokens_details: { cached_tokens: 512 },
          output_tokens: 70,
          output_tokens_details: { reasoning_tokens: 40 },
        },
      }),
    );
    const live = new MetaResponsesClient({ apiKey: "k" });
    const reply = await live.call({ key: "m1", attempt: 1, effort: "low", body: buildRequestBody(message, "low") });
    expect(reply.outputText).toBe('{"claims":[]}');
    expect(reply.usage).toEqual({ input: 900, cachedInput: 512, output: 70, reasoning: 40 });
    expect(reply.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
