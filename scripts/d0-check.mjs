// D0 check: one structured extraction call per fixture message against
// Meta Model API (Responses API, Standard mode, store: false).
// Run with: pnpm exec varlock run -- node scripts/d0-check.mjs
// Prints claims, quote checks, latency, usage and rate-limit headers.
// Never prints the API key or request headers.
import { readFileSync } from "node:fs";

const API_URL = "https://api.meta.ai/v1/responses";
const MODEL = "muse-spark-1.3";

const key = process.env.MODEL_API_KEY;
if (!key) {
  console.error("MODEL_API_KEY is not set. Run through varlock.");
  process.exit(2);
}

const messages = JSON.parse(
  readFileSync(new URL("../fixtures/d0-messages.json", import.meta.url), "utf8"),
);

const nullableString = (description) => ({ type: ["string", "null"], description });

const claimSchema = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "claim_type", "date", "time", "location",
          "quote", "sender_kind", "event_time", "request_item",
        ],
        properties: {
          claim_type: {
            type: "string",
            enum: ["offer", "confirm", "cancel", "move", "reminder", "office_request"],
          },
          date: nullableString("Appointment date as YYYY-MM-DD, only if the message states it."),
          time: nullableString("Appointment time as 24-hour HH:MM, only if the message states it."),
          location: nullableString("Appointment location, only if the message states it."),
          quote: {
            type: "string",
            description: "The exact, verbatim words from the message that support this claim.",
          },
          sender_kind: { type: "string", enum: ["person", "automated", "unknown"] },
          event_time: nullableString("When the described event happened, only if the message states it."),
          request_item: nullableString("For office_request: what the office asked the person to bring or do."),
        },
      },
    },
  },
};

const instructions = [
  "You extract administrative appointment facts from one message.",
  "Return one claim per fact: each offered time, confirmation, cancellation,",
  "proposed move of an existing appointment, reminder, or office request",
  "(something the office asked the person to bring or do).",
  "Use claim_type move for the existing appointment the office wants to move,",
  "and a separate offer claim for each replacement time.",
  "The quote must be copied exactly from the message text, word for word.",
  "Resolve dates using the message's received_at year. Do not guess missing values: use null.",
  "Do not give medical or clinical content. Extract only what the message says.",
].join(" ");

const normalize = (s) => s.replace(/\s+/g, " ").trim();

function checkClaims(message, claims) {
  const text = normalize(message.text);
  const rows = claims.map((c) => ({
    claim_type: c.claim_type,
    date: c.date,
    time: c.time,
    request_item: c.request_item,
    quote_ok: c.quote.length > 0 && text.includes(normalize(c.quote)),
  }));
  const unmatched = [...rows];
  const misses = [];
  for (const exp of message.expected) {
    const i = unmatched.findIndex(
      (r) =>
        r.claim_type === exp.claim_type &&
        (exp.date === undefined || r.date === exp.date) &&
        (exp.time === undefined || r.time === exp.time),
    );
    if (i === -1) misses.push(exp);
    else unmatched.splice(i, 1);
  }
  return { rows, misses, extras: unmatched };
}

let failures = 0;
for (const message of messages) {
  const body = {
    model: MODEL,
    store: false,
    reasoning: { effort: "low" },
    instructions,
    input: JSON.stringify({
      channel: message.channel,
      from: message.from,
      received_at: message.received_at,
      text: message.text,
    }),
    text: {
      format: {
        type: "json_schema",
        name: "appointment_claims",
        schema: claimSchema,
        strict: false,
      },
    },
  };

  const started = performance.now();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const latencyMs = Math.round(performance.now() - started);
  const rateHeaders = Object.fromEntries(
    [...res.headers].filter(([name]) => /ratelimit|request-id/i.test(name)),
  );
  const raw = await res.text();

  console.log(`\n=== ${message.id} | HTTP ${res.status} | ${latencyMs} ms`);
  console.log("headers:", JSON.stringify(rateHeaders));
  if (!res.ok) {
    console.log("error body:", raw.slice(0, 800));
    failures++;
    continue;
  }

  const json = JSON.parse(raw);
  const outputText = (json.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
  console.log("usage:", JSON.stringify(json.usage));

  let claims;
  try {
    claims = JSON.parse(outputText).claims;
  } catch {
    console.log("output was not valid JSON:", outputText.slice(0, 400));
    failures++;
    continue;
  }

  const { rows, misses, extras } = checkClaims(message, claims);
  for (const r of rows) console.log("claim:", JSON.stringify(r));
  const quoteFailures = rows.filter((r) => !r.quote_ok).length;
  console.log(
    `quote check: ${rows.length - quoteFailures}/${rows.length} verbatim | ` +
      `expected claims missed: ${misses.length} | extra claims: ${extras.length}`,
  );
  if (misses.length) console.log("missed:", JSON.stringify(misses));
  if (quoteFailures || misses.length) failures++;
}

console.log(`\nD0 result: ${failures === 0 ? "PASS" : `FAIL (${failures} message(s))`}`);
process.exit(failures === 0 ? 0 : 1);
