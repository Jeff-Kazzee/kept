// Grant command for the app's event log, until the app has a grant screen.
//
//   pnpm grant create --name <name> --tier <read|annotate|propose>
//   pnpm grant list
//   pnpm grant revoke <id>
//
// create prints the new token once, to this terminal only. Only its hash is
// stored. Set APP_DB to use another event log file.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { appDbPath } from "../paths.ts";
import { EventStore } from "../store/event-log.ts";
import { GrantStore, TIERS, type Tier } from "./grants.ts";

const USAGE = `Usage:
  pnpm grant create --name <name> --tier <${TIERS.join("|")}>
  pnpm grant list
  pnpm grant revoke <id>`;

export function runGrantCommand(argv: string[], grants: GrantStore, out: (line: string) => void): number {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: { name: { type: "string" }, tier: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });

  if (command === "create" && values.name && values.tier && positionals.length === 0) {
    const { grant, token } = grants.create(values.name, values.tier as Tier);
    out(`Created grant ${grant.id} "${grant.name}" with the ${grant.tier} tier.`);
    out("Token (shown once, copy it into your MCP client config as APPT_GRANT_TOKEN):");
    out(token);
    return 0;
  }
  if (command === "list" && positionals.length === 0 && !values.name && !values.tier) {
    const list = grants.list();
    if (list.length === 0) out("No grants.");
    for (const g of list) out(`${g.id}  ${g.status.padEnd(7)}  ${g.tier.padEnd(8)}  ${g.name}  created ${g.createdAt}${g.revokedAt ? `, revoked ${g.revokedAt}` : ""}`);
    return 0;
  }
  if (command === "revoke" && positionals.length === 1 && !values.name && !values.tier) {
    const id = positionals[0]!;
    const g = grants.revoke(id, grants.get(id).version);
    out(`Revoked grant ${g.id} "${g.name}". Its next call fails.`);
    return 0;
  }
  out(USAGE);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = appDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new EventStore(dbPath);
  let code: number;
  try {
    code = runGrantCommand(process.argv.slice(2), new GrantStore(store), (line) => console.log(line));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    code = 1;
  } finally {
    store.close();
  }
  process.exit(code);
}
