// stdio entry for the MCP server. The agent's client launches this process
// and sets APPT_GRANT_TOKEN in its own config. The server opens the app's
// event log (APP_DB, default data/app.sqlite in the package), so it reads
// the grants and records the app writes. It opens no network port and
// makes no model calls. Diagnostics go to stderr. stdout carries only MCP
// messages.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CaseService } from "../src/case/service.ts";
import { GrantStore } from "../src/grants/grants.ts";
import { IntakeService } from "../src/intake/service.ts";
import type { ModelClient } from "../src/model/client.ts";
import { appDbPath } from "../src/paths.ts";
import { RecordsService } from "../src/records/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { RateLimiter } from "./rate-limit.ts";
import { createMcpServer, sweepRateWindows } from "./server.ts";

const token = process.env.APPT_GRANT_TOKEN ?? "";
// Keep the token out of the environment of anything this process starts.
delete process.env.APPT_GRANT_TOKEN;
if (token.length === 0) {
  console.error("Set APPT_GRANT_TOKEN in this server's entry in your MCP client config. Create a grant with: pnpm grant create --name <name> --tier read");
  process.exit(2);
}

const noModel: ModelClient = {
  label: "none",
  call: () => Promise.reject(new Error("The MCP server makes no model calls.")),
};

const store = new EventStore(appDbPath());
// Finish a Delete case that stopped before it cleared the file, before
// serving. A failure is reported and the server still starts.
try {
  store.finishPendingErase();
} catch (err) {
  console.error(`Could not finish clearing a deleted case from the database file: ${err instanceof Error ? err.message : String(err)}`);
}
const intake = new IntakeService(store, noModel);
const records = new RecordsService(store, intake, new CaseService(store, intake, noModel));
const grants = new GrantStore(store);
const limiter = new RateLimiter(store);
const deps = { records, grants, token, limiter };
// Summarize rate-limit windows that ended while no server was running.
try {
  sweepRateWindows(deps);
} catch (err) {
  console.error(`Could not close old rate-limit windows: ${err instanceof Error ? err.message : String(err)}`);
}

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
