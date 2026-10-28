// Usage credits through the hosted routes and the chat (0014, design
// items 4 and 6): every call on the server key is held, charged and shown
// on the usage page. Credits that run out before or during a turn stop it
// cleanly, with nothing half written. The daily ceiling and the off switch
// stop every call, whatever the balances say.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_OUTPUT_TOKENS } from "../src/hosted/prices.ts";
import { USAGE_TEXT } from "../src/model/usage.ts";
import { PARTIAL_TEXT } from "../src/agent/types.ts";
import { completed, message } from "./provider-fakes.ts";
import { fixtureMessage } from "./helpers.ts";
import { fakeMeta, sseEvents, startHosted, type Browser, type Hosted } from "./hosted-helpers.ts";

let h: Hosted | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const gen = (state: { generation: number }) => ({ "X-Case-Generation": String(state.generation) });

async function signedIn(options: Parameters<typeof startHosted>[0] = {}, grantUsd = 5) {
  h = await startHosted(options);
  const b = h.browser();
  await h.googleSignIn(b);
  const id = h.app.store.session(b.cookies.get(`appt_session_${h.port}`)!)!.account.id;
  if (grantUsd > 0) h.app.store.grant(id, grantUsd * 1_000_000, "judge:j000000000000");
  return { b, id };
}

const chat = async (b: Browser, text: string) => {
  const s = (await b.call("GET", "/api/state")).body;
  const c = (await b.call("GET", "/api/chat")).body;
  return sseEvents((await b.call("POST", "/api/chat", { text, expectedVersion: c.chatVersion }, gen(s))).text);
};

const toolCall = (name: string, args: Record<string, unknown>, id = "call-1") => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const stream = (output: unknown[]) => new Response(completed(output, { input_tokens: 2000, output_tokens: 80 }), { headers: { "content-type": "text/event-stream" } });

describe("usage credits in hosted mode", () => {
  it("a chat turn holds and charges every call on the server key, with max_output_tokens set, and the usage page shows it", async () => {
    const meta = fakeMeta();
    const { b, id } = await signedIn();
    const events = await chat(b, "What is on my schedule?");
    expect(events.at(-1)!.event).toBe("turn.done");
    expect(meta.calls.length).toBeGreaterThan(0);
    for (const c of meta.calls) {
      expect(c.body.max_output_tokens).toBe(c.body.stream === undefined ? MAX_OUTPUT_TOKENS.json : MAX_OUTPUT_TOKENS.tool);
      expect(c.authorization).toBe("Bearer server-meta-key-for-tests");
      expect(c.body.model).toBe("muse-spark-1.3");
    }
    const charges = h!.app.store.charges(id);
    expect(charges).toHaveLength(meta.calls.length);
    expect(charges.every((c) => c.route === "chat" && c.turn !== null && c.input === 1000 && c.cachedInput === 200 && c.output === 100 && c.reasoning === 40)).toBe(true);
    expect(h!.app.store.ledger(id).filter((r) => r.kind === "hold" && r.open)).toEqual([]);

    const usage = (await b.call("GET", "/api/usage")).body;
    expect(usage.balanceMicros).toBe(5_000_000 - charges.reduce((x, c) => x + c.amountMicros, 0));
    expect(usage.charges).toHaveLength(1);
    expect(usage.charges[0]).toMatchObject({ what: "Chat turn", model: "muse-spark-1.3", modelLabel: "Muse Spark 1.3", calls: meta.calls.length });
    expect(usage.plans).toEqual([
      { id: "credit-20", usd: 20, label: "$20 of usage", available: false },
      { id: "credit-100", usd: 100, label: "$100 of usage", available: false },
    ]);
    expect(usage.markup).toBe("3");
    // The key is in no answer and no log.
    expect(JSON.stringify(usage)).not.toContain("server-meta-key-for-tests");
    expect(h!.logs.join("\n")).not.toContain("server-meta-key-for-tests");
  });

  it("with no credit, a turn is refused before the person's message is saved", async () => {
    const meta = fakeMeta();
    const { b } = await signedIn({}, 0);
    const events = await chat(b, "What is on my schedule?");
    expect(events).toEqual([{ event: "turn.error", data: { turnId: expect.any(String), code: "credits_exhausted", message: USAGE_TEXT.credits_exhausted.text } }]);
    expect(meta.calls).toEqual([]);
    expect((await b.call("GET", "/api/chat")).body.messages).toEqual([]);
  });

  it("credits that run out mid-turn stop the turn with the sentence, and every write before it is whole", async () => {
    const meta = fakeMeta();
    const { b, id } = await signedIn();
    const pasted = "From Lantern Hill Clinic: Your appointment is confirmed for Monday 11/16 at 1:00 PM.";
    // The first call imports the pasted message. While it runs, the
    // account's credit is spent elsewhere, so the extraction the import
    // starts cannot be held.
    meta.script.push(() => {
      h!.app.store.adjust(id, -h!.app.store.balance(id), "test");
      // Usage above the hold, so its charge takes the whole hold and the
      // balance is zero after it.
      return new Response(completed([toolCall("import_message", { text: pasted, channel: null, from: null, received_at: null })], { input_tokens: 70_000, output_tokens: 80 }), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const events = await chat(b, `Please add this:\n${pasted}`);
    const done = events.find((e) => e.event === "turn.done");
    expect(done).toBeTruthy();
    const error = events.find((e) => e.event === "turn.error")!;
    expect(error.data.code).toBe("credits_exhausted");
    expect(error.data.message).toBe(`${PARTIAL_TEXT} ${USAGE_TEXT.credits_exhausted.reason}`);
    // One model call: the extraction was refused before it was sent.
    expect(meta.calls).toHaveLength(1);
    const state = (await b.call("GET", "/api/state")).body;
    // The import is whole: the message is in the case, with no failed
    // extraction attempt and no claim.
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].attempts).toEqual([]);
    expect(state.evidence).toEqual([]);
    // The chat holds the person's message and the stop sentence.
    const log = (await b.call("GET", "/api/chat")).body.messages;
    expect(log.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(log[1].text).toBe(`${PARTIAL_TEXT} ${USAGE_TEXT.credits_exhausted.reason}`);
    // The activity shows the import, which the person can undo.
    expect((await b.call("GET", "/api/activity")).body.entries.length).toBeGreaterThan(0);
    // No hold stays open, and the balance is zero, never below.
    expect(h!.app.store.ledger(id).filter((r) => r.kind === "hold" && r.open)).toEqual([]);
    expect(h!.app.store.balance(id)).toBe(0);
  });

  it("a model route with no credit answers 402 with the sentence and writes nothing", async () => {
    const meta = fakeMeta();
    const { b } = await signedIn({}, 0);
    const s = (await b.call("GET", "/api/state")).body;
    await b.call("POST", "/api/messages", fixtureMessage("m2"), gen(s));
    const s2 = (await b.call("GET", "/api/state")).body;
    const m = s2.messages[0];
    const r = await b.call("POST", `/api/messages/${m.id}/extract`, { expectedVersion: m.version }, gen(s2));
    expect(r.status).toBe(402);
    expect(r.body).toEqual({ error: "credits_exhausted", message: USAGE_TEXT.credits_exhausted.text });
    expect(meta.calls).toEqual([]);
    const after = (await b.call("GET", "/api/state")).body;
    expect(after.messages[0].attempts).toEqual([]);
    expect(after.messages[0].version).toBe(m.version);
  });

  it("an extraction with credit is charged as Read a message", async () => {
    fakeMeta();
    const { b, id } = await signedIn();
    const s = (await b.call("GET", "/api/state")).body;
    await b.call("POST", "/api/messages", fixtureMessage("m2"), gen(s));
    const s2 = (await b.call("GET", "/api/state")).body;
    const m = s2.messages[0];
    expect((await b.call("POST", `/api/messages/${m.id}/extract`, { expectedVersion: m.version }, gen(s2))).status).toBe(200);
    expect(h!.app.store.charges(id)[0]).toMatchObject({ route: "extract", turn: null });
    expect((await b.call("GET", "/api/usage")).body.charges[0].what).toBe("Read a message");
  });

  it("the daily ceiling stops every call, whatever the balance", async () => {
    const meta = fakeMeta();
    const { b, id } = await signedIn({ env: { APP_DAILY_COST_CAP_USD: "0" } }, 50);
    const events = await chat(b, "What is on my schedule?");
    expect(events).toEqual([{ event: "turn.error", data: { turnId: expect.any(String), code: "usage_paused", message: USAGE_TEXT.daily_cap.text } }]);
    expect(meta.calls).toEqual([]);
    expect(h!.app.store.balance(id)).toBe(50_000_000);
  });

  it("the daily ceiling reached mid-turn ends the turn with its sentence", async () => {
    const meta = fakeMeta();
    const { b } = await signedIn({ env: { APP_DAILY_COST_CAP_USD: "0.1" } }, 50);
    // The first call costs the whole day's allowance.
    meta.script.push(() => new Response(completed([toolCall("get_schedule", {})], { input_tokens: 70_000, output_tokens: 80 }), { headers: { "content-type": "text/event-stream" } }));
    const events = await chat(b, "What is on my schedule?");
    const error = events.find((e) => e.event === "turn.error");
    expect(error?.data, JSON.stringify(events)).toMatchObject({ code: "usage_paused", message: USAGE_TEXT.daily_cap.text });
    expect(meta.calls).toHaveLength(1);
    const log = (await b.call("GET", "/api/chat")).body.messages;
    expect(log[1].text).toBe(USAGE_TEXT.daily_cap.text);
  });

  it("the off switch, or no server key, stops every call with a plain message", async () => {
    for (const options of [{ env: { APP_SERVER_KEY: "off" } }, { serverKey: null }]) {
      const meta = fakeMeta();
      const { b } = await signedIn(options, 50);
      const events = await chat(b, "What is on my schedule?");
      expect(events[0]!.data).toMatchObject({ code: "usage_paused", message: USAGE_TEXT.server_key_off.text });
      expect(meta.calls).toEqual([]);
      await h!.close();
      h = null;
    }
  });

  it("a stream that fails with usage is charged its usage, and one that fails without it the whole hold", async () => {
    const meta = fakeMeta();
    const { b, id } = await signedIn();
    meta.script.push(
      () =>
        new Response(
          `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { usage: { input_tokens: 700, output_tokens: 8192 } } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await chat(b, "What is on my schedule?");
    const [incomplete] = h!.app.store.charges(id);
    expect(incomplete).toMatchObject({ input: 700, output: 8192, wholeHold: false });
    meta.script.push(() => new Response("event: response.created\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } }));
    await chat(b, "What is on my schedule?");
    expect(h!.app.store.charges(id)[0]).toMatchObject({ wholeHold: true });
    // A plain answer still works after.
    meta.text = "Your schedule is empty.";
    expect((await chat(b, "Anything else?")).at(-1)!.event).toBe("turn.done");
    void message;
  });
});
