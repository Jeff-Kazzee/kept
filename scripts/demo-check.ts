// pnpm demo:check (SP12.6): starts the app on a free port with a temporary
// database, runs the demo path end to end through the HTTP routes as the
// page does, checks each step and stops the app. It checks the real
// product, so it runs on the live model (J12): the provider is Meta with
// MODEL_API_KEY, for example through varlock.
//
// The demo path is the chat script fixtures/chat/demo-story.json: "Try the
// demo" loads the demo calendar through its route, then each `say` step is
// a POST /api/chat read as the page reads its event stream, and the
// approval is the reply card's approve route with every field read back.
// Each turn must call the tools, take the actions and show the cards the
// script expects, end with the error it expects, and not fall back to a
// fixed sentence. At the end Monday must be confirmed, Thursday canceled,
// the checklist must hold the insurance card, and only the person's one
// approval may have sent a reply.
//
//   pnpm demo:check             the live app on the live model
//   pnpm demo:check --recorded  offline, for CI: the same routes in this
//                               process with the recorded test doubles. Its
//                               output says "recorded, not a product run".
//
// The live app gets the key and no Google client. It is stopped by the
// process id it was started with, after checking that the process runs
// from this package.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApi } from "../server/api.ts";
import { createChat, sseFrame } from "../server/chat.ts";
import { CaseAgent } from "../src/agent/agent.ts";
import { RecordedChatClient, fixtureMessageIds } from "../src/agent/recorded.ts";
import { defaultMessageId } from "../src/agent/tools.ts";
import type { ChatEvent } from "../src/agent/types.ts";
import { CaseService } from "../src/case/service.ts";
import { loadChatScripts, stepText, type ChatStep } from "../src/eval/chat-eval.ts";
import { loadCaseProfile } from "../src/fixtures/load.ts";
import { IntakeService } from "../src/intake/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { PACKAGE_ROOT } from "../src/paths.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";

type Line = (line: string) => void;
type SayStep = Extract<ChatStep, { say: string }>;
type Problem = { step: number; text: string; fatal: boolean };

export type DemoCheckOptions = { recorded?: boolean; log?: Line; env?: NodeJS.ProcessEnv; startTimeoutMs?: number };

export const RECORDED_LABEL = "recorded, not a product run";

// One request, as the page sends it, and the answer's status and body.
type Transport = { call(method: string, path: string, body: unknown, generation: number): Promise<{ status: number; text: string }>; close(): Promise<void> };
export type DemoCheckResult = { ok: boolean; problems: Problem[]; turns: number };

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

// The environment the live app starts with: the key, no Google client and
// no proxy host list, so the agent's tools are the same on every run.
export function appEnv(base: NodeJS.ProcessEnv, port: number, db: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(?:APP_|GOOGLE_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, APP_PORT: String(port), APP_DB: db };
}

function waitForStart(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`The app did not start within ${timeoutMs} ms.`)), timeoutMs);
    const read = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (/Serving the (?:UI|production build)/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", read);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The app exited with code ${code} before it started.`));
    });
  });
}

// Stops the app by its process id, after checking that the process with
// that id runs from this package.
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  const cwd = (() => {
    try {
      return readlinkSync(`/proc/${child.pid}/cwd`);
    } catch {
      return null;
    }
  })();
  if (cwd !== null && path.resolve(cwd) !== path.resolve(PACKAGE_ROOT)) throw new Error(`Process ${child.pid} does not run from this package. Not stopped.`);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

// The events of a chat turn from its event stream.
export function parseEvents(body: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const frame of body.split("\n\n")) {
    const name = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (name && data) events.push({ event: name, data: JSON.parse(data) } as ChatEvent);
  }
  return events;
}

// The live app: `node server/main.ts` on a free port, called over HTTP.
async function liveApp(dir: string, options: DemoCheckOptions, log: Line): Promise<Transport> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/main.ts"], {
    cwd: PACKAGE_ROOT,
    env: appEnv(options.env ?? process.env, port, path.join(dir, "app.sqlite")),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  try {
    await waitForStart(child, options.startTimeoutMs ?? 60_000);
  } catch (err) {
    await stop(child);
    throw err;
  }
  log(`App started on port ${port} with a temporary database, process ${child.pid}.`);
  return {
    async call(method, p, body, generation) {
      const res = await fetch(`${origin}${p}`, {
        method,
        headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Appointments-App": "1", Origin: origin, "X-Case-Generation": String(generation) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, text: await res.text() };
    },
    async close() {
      await stop(child);
      if (stderr.trim() !== "") log(`App errors:\n${stderr.trim()}`);
    },
  };
}

// --recorded: the same routes in this process, on the recorded test
// doubles. Not the product: the app has no recorded mode (J12).
function recordedApp(dir: string): Transport {
  const store = new EventStore(path.join(dir, "app.sqlite"));
  const client = RecordedModelClient.fromDirectory();
  const intake = new IntakeService(store, client);
  const kase = new CaseService(store, intake, client, { userName: loadCaseProfile().user_name });
  const reply = new ReplyService(store, kase, client);
  const records = new RecordsService(store, intake, kase);
  const api = createApi(intake, kase, {}, reply, { store, records });
  const chat = createChat(
    new CaseAgent(store, { intake, kase, reply, records }, RecordedChatClient.fromDirectory(), { messageIdFor: fixtureMessageIds(defaultMessageId) }),
  );
  return {
    async call(method, p, body, generation) {
      if (p !== "/api/chat") {
        const r = await api({ method, path: p, body, generation });
        return { status: r.status, text: JSON.stringify(r.body) };
      }
      let status = 200;
      let text = "";
      await chat.serve(
        { method, body, generation },
        {
          json: (s, payload) => {
            status = s;
            text = JSON.stringify(payload);
          },
          event: (e) => (text += sseFrame(e)),
          end: () => {},
        },
      );
      return { status, text };
    },
    async close() {
      store.close();
    },
  };
}

export async function runDemoCheck(options: DemoCheckOptions = {}): Promise<DemoCheckResult> {
  const recorded = options.recorded === true;
  const out = options.log ?? ((l) => console.log(l));
  // Every line of a recorded run says it is not the product.
  const log: Line = recorded ? (l) => out(`[${RECORDED_LABEL}] ${l}`) : out;
  const script = loadChatScripts().find((s) => s.id === "demo-story");
  if (!script) throw new Error("No chat script demo-story.");
  const dir = mkdtempSync(path.join(tmpdir(), "demo-check-"));
  const problems: Problem[] = [];
  let turns = 0;
  let app: Transport | null = null;
  try {
    app = recorded ? recordedApp(dir) : await liveApp(dir, options, log);
    if (recorded) log("Running the demo path in this process on the recorded test doubles.");
    let generation = 0;
    const transport = app;
    const call = (method: string, p: string, body?: unknown) => transport.call(method, p, body, generation);
    const json = async (method: string, p: string, body?: unknown) => {
      const r = await call(method, p, body);
      if (r.status !== 200) throw new Error(`${method} ${p} answered ${r.status}: ${r.text.slice(0, 200)}`);
      return JSON.parse(r.text);
    };
    // The page reads the state, and with it the case generation, first.
    const state = async () => {
      const s = await json("GET", "/api/state");
      generation = s.generation;
      return s;
    };

    // "Try the demo": the demo calendar through its route, as the page loads it.
    let s = await state();
    const demo = await json("GET", "/api/fixtures/calendar");
    await json("POST", "/api/calendar", { name: demo.name, text: demo.text, expectedVersion: s.case.calendarVersion });
    log(`Loaded the demo calendar ${demo.name}.`);

    for (const [i, step] of script.steps.entries()) {
      const n = i + 1;
      const fail = (text: string, fatal = true) => {
        problems.push({ step: n, text, fatal });
        log(`  step ${n}: ${fatal ? "FAILED" : "warning"}: ${text}`);
      };
      if ("do" in step) {
        if (step.do !== "approve_draft") throw new Error(`demo:check runs approve_draft only, not ${step.do}.`);
        s = await state();
        const draft = s.case.reply.draft;
        if (!draft) {
          fail("no reply draft to approve");
          continue;
        }
        // The reply card reads back every field before approval.
        await json("POST", `/api/reply/drafts/${encodeURIComponent(draft.id)}/approve`, {
          expectedVersion: s.case.reply.version,
          confirmedFields: draft.fields.map((f: { name: string }) => f.name),
          confirmClaim: false,
        });
        log(`step ${n}: approved the reply draft ${draft.template} for ${draft.slotKey}.`);
        continue;
      }
      turns++;
      const say = step as SayStep;
      await state();
      const chat = await json("GET", "/api/chat");
      const started = performance.now();
      const r = await call("POST", "/api/chat", { text: stepText(say), expectedVersion: chat.chatVersion });
      const ms = Math.round(performance.now() - started);
      if (r.status !== 200) {
        fail(`POST /api/chat answered ${r.status}`);
        continue;
      }
      const events = parseEvents(r.text);
      const of = <K extends ChatEvent["event"]>(name: K) => events.filter((e) => e.event === name).map((e) => e.data as Extract<ChatEvent, { event: K }>["data"]);
      const tools = of("tool.started").map((t) => t.tool);
      const cards = of("card").map((c) => c.card.kind);
      const actions = of("action").map((a) => a.entry.kind);
      const error = of("turn.error")[0]?.code ?? null;
      const text = of("text.delta").map((d) => d.text).join("");
      const e = say.expect;
      log(`step ${n}: ${ms} ms, tools ${tools.join(", ") || "none"}, actions ${actions.join(", ") || "none"}${error ? `, error ${error}` : ""}`);
      if (of("turn.done").length !== 1) fail("the turn did not finish");
      const missing = e.tools.filter((t) => !tools.includes(t));
      if (missing.length > 0) fail(`tools not called: ${missing.join(", ")}`);
      if (e.tools_any.length > 0 && !e.tools_any.some((t) => tools.includes(t))) fail(`none of these tools called: ${e.tools_any.join(", ")}`);
      const noCards = e.cards.filter((c) => !cards.includes(c));
      if (noCards.length > 0) fail(`cards not shown: ${noCards.join(", ")}`);
      const noActions = e.actions.filter((a) => !actions.includes(a));
      if (noActions.length > 0) fail(`actions not taken: ${noActions.join(", ")}`);
      const forbidden = e.actions_none.filter((a) => actions.includes(a));
      if (forbidden.length > 0) fail(`actions taken that must not be: ${forbidden.join(", ")}`);
      if (error !== e.error) fail(`error ${error ?? "none"}, expected ${e.error ?? "none"}`);
      const textOk = (e.text_any.length === 0 || e.text_any.some((p) => new RegExp(p, "i").test(text))) && e.text_none.every((p) => !new RegExp(p, "i").test(text));
      // The words of a live answer vary, so a text check only warns there.
      if (!textOk) fail(`the answer does not read as expected: ${JSON.stringify(text)}`, recorded);
    }

    s = await state();
    const slot = (key: string) => s.case.slots.find((x: { key: string }) => x.key === key)?.state ?? null;
    const end = (ok: boolean, text: string) => {
      if (!ok) problems.push({ step: 0, text, fatal: true });
      log(`end: ${ok ? "ok" : "FAILED"}: ${text}`);
    };
    end(slot("2026-11-16T13:00") === "confirmed", `Monday 11/16 1:00 PM is ${slot("2026-11-16T13:00")}, expected confirmed`);
    end(slot("2026-11-12T10:30") === "canceled", `Thursday 11/12 10:30 AM is ${slot("2026-11-12T10:30")}, expected canceled`);
    const items = s.case.checklist.map((x: { text: string }) => x.text);
    end(items.some((t: string) => /insurance card/i.test(t)), `the checklist holds ${items.length} items, with the insurance card`);
    end(s.case.reply.sent.length === 1, `${s.case.reply.sent.length} reply sent, only the person's approval`);
  } finally {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
    log("App stopped and its temporary database removed.");
  }
  return { ok: problems.every((p) => !p.fatal), problems, turns };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const unknown = args.filter((a) => a !== "--recorded");
  const recorded = args.includes("--recorded");
  if (unknown.length > 0) {
    console.error(`Unknown option ${unknown.join(" ")}. Usage: pnpm demo:check [--recorded]`);
    process.exitCode = 2;
  } else if (!recorded && !process.env.MODEL_API_KEY) {
    console.error("MODEL_API_KEY is not set. The demo check runs the live app: run it through varlock, or use --recorded offline.");
    process.exitCode = 2;
  } else {
    const r = await runDemoCheck({ recorded });
    const label = recorded ? ` (${RECORDED_LABEL})` : " (live)";
    console.log(r.ok ? `Demo check passed${label}: ${r.turns} turns.` : `Demo check failed${label}: ${r.problems.filter((p) => p.fatal).length} problems.`);
    process.exitCode = r.ok ? 0 : 1;
  }
}
