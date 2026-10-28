// stdio entry for the MCP server. The agent's client launches this process
// (scripts/mcp-stdio.sh) with APP_DB, the app's event log, default
// data/app.sqlite in the package. There is no token: whoever can start it
// can already open that file. It opens no network port. Model calls (for
// extraction, explanations and questions) use the recorded responses
// unless APP_LIVE_MODEL=1 and MODEL_API_KEY are set, as for the app. The
// key stays in the client object and is never logged. Diagnostics go to
// stderr. stdout carries only MCP messages.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CaseService } from "../src/case/service.ts";
import { loadCaseProfile } from "../src/fixtures/load.ts";
import { IntakeService } from "../src/intake/service.ts";
import { MetaResponsesClient, type ModelClient } from "../src/model/client.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { appDbPath } from "../src/paths.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { fixtureMessageIds } from "../src/agent/recorded.ts";
import { defaultMessageId } from "../src/agent/tools.ts";
import { RateLimiter } from "./rate-limit.ts";
import { createMcpServer } from "./server.ts";

const live = process.env.APP_LIVE_MODEL === "1";
let client: ModelClient;
if (live) {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    console.error("APP_LIVE_MODEL=1 needs MODEL_API_KEY in the environment.");
    process.exit(2);
  }
  client = new MetaResponsesClient({ apiKey });
} else {
  client = RecordedModelClient.fromDirectory();
}
// Nothing this process starts inherits the key.
delete process.env.MODEL_API_KEY;

const store = new EventStore(appDbPath());
// Finish a Delete case that stopped before it cleared the file, before
// serving. A failure is reported and the server still starts.
try {
  store.finishPendingErase();
} catch (err) {
  console.error(`Could not finish clearing a deleted case from the database file: ${err instanceof Error ? err.message : String(err)}`);
}
const intake = new IntakeService(store, client);
const kase = new CaseService(store, intake, client, { userName: loadCaseProfile().user_name });
const reply = new ReplyService(store, kase, client);
const records = new RecordsService(store, intake, kase);
// In recorded mode a fixture message keeps its fixture id, as in the app.
const deps = { store, services: { intake, kase, reply, records }, limiter: new RateLimiter(), messageIdFor: live ? undefined : fixtureMessageIds(defaultMessageId) };

const handle = serveStdio(() => createMcpServer(deps), {
  onerror: (err) => console.error(`MCP server error: ${err.message}`),
});

const shutdown = async () => {
  await handle.close();
  store.close();
  process.exit(0);
};
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
