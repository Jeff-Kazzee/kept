// stdio entry for the MCP server. The agent's client launches this process
// (scripts/mcp-stdio.sh) with APP_DB, the app's event log, default
// data/app.sqlite in the package. There is no token: whoever can start it
// can already open that file. It opens no network port. Model calls (for
// extraction, explanations and questions) go to the provider and model
// chosen in the app's settings (0010), as for the app, with no recorded
// mode (J12). The settings are read from the
// settings database beside APP_DB: the user's Meta key, the server's
// MODEL_API_KEY, or the ChatGPT connection the app saved. The Google tools
// (0012) use the Google connection the app saved in the same database,
// with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from the environment.
// Without them they answer google_not_configured. Keys and tokens stay in
// the client objects and are never logged. Diagnostics go to
// stderr. stdout carries only MCP messages.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CaseService } from "../src/case/service.ts";
import { loadCaseProfile } from "../src/fixtures/load.ts";
import { IntakeService } from "../src/intake/service.ts";
import { ChatGptAuth } from "../src/model/providers/chatgpt-auth.ts";
import { createProviderClient } from "../src/model/providers/factory.ts";
import { SecretsStore, appSecretsPath } from "../src/model/providers/secrets.ts";
import { appDbPath } from "../src/paths.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { RateLimiter } from "./rate-limit.ts";
import { createMcpServer } from "./server.ts";
import { GoogleCalendar } from "../src/google/calendar.ts";
import { GoogleConnection, clientFromEnv } from "../src/google/connection.ts";
import { GoogleCalendarEvents } from "../src/google/events.ts";
import { Gmail } from "../src/google/gmail.ts";
import type { GoogleServices } from "../src/google/tools.ts";

// Local mode only (0014): the hosted site keeps one workspace per account,
// and no MCP client is tied to an account.
if ((process.env.APP_MODE ?? "").trim().toLowerCase() === "hosted") {
  console.error("The MCP server runs in local mode only. Unset APP_MODE to run it beside a local app.");
  process.exit(2);
}

const secrets = new SecretsStore(appSecretsPath());
// The same provider factory as the app. The ChatGPT redirect port only
// matters for a sign-in, which happens in the app, not here.
const auth = new ChatGptAuth({ store: secrets, port: Number(process.env.APP_PORT ?? 5180) });
const client = createProviderClient({ store: secrets, auth, serverMetaKey: process.env.MODEL_API_KEY || null });
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
const googleConnection = new GoogleConnection({ client: clientFromEnv(), store: secrets });
const googleCalendar = new GoogleCalendar(googleConnection, { timeZone: () => kase.timeZone() });
const googleEvents = new GoogleCalendarEvents(googleCalendar);
const google: GoogleServices = { connection: googleConnection, gmail: new Gmail(googleConnection), calendar: googleCalendar, events: googleEvents };
// The secret is in the connection object now. Nothing this process starts
// inherits it.
delete process.env.GOOGLE_CLIENT_SECRET;
const intake = new IntakeService(store, client);
const kase = new CaseService(store, intake, client, { userName: loadCaseProfile().user_name, externalCalendar: () => googleEvents.snapshot() });
const reply = new ReplyService(store, kase, client);
const records = new RecordsService(store, intake, kase);
// J12: a tool that needs the model is refused while no provider is ready.
const deps = { store, services: { intake, kase, reply, records, google }, limiter: new RateLimiter(), ready: () => client.ready() };

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
