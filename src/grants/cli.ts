// Grant command for the app's event log. The app's grant screen does the
// same.
//
//   pnpm grant create --name <name> --tier <read|annotate|propose> [--token-file <path>]
//   pnpm grant list
//   pnpm grant revoke <id>
//
// create prints the new token once, to this terminal only. With
// --token-file it writes the token to that file instead, readable by you
// only, and prints only the path. Only its hash is stored. Set APP_DB to use
// another event log file.
import { closeSync, fchmodSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { appDbPath } from "../paths.ts";
import { EventStore } from "../store/event-log.ts";
import { GrantStore, TIERS, type Tier } from "./grants.ts";

const USAGE = `Usage:
  pnpm grant create --name <name> --tier <${TIERS.join("|")}> [--token-file <path>]
  pnpm grant list
  pnpm grant revoke <id>`;

export class TokenFileError extends Error {
  override name = "TokenFileError";
}

// Creates the token file, readable and writable by its owner only. Refuses
// a path that already exists, so an old token is never overwritten. Opening
// with O_EXCL also refuses a symbolic link at the path.
export function openTokenFile(file: string): number {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(file, "wx", 0o600);
    fchmodSync(fd, 0o600);
    return fd;
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") throw new TokenFileError(`${file} already exists. Choose a new path or remove the old file first.`);
    throw new TokenFileError(`Could not create ${file}: ${(err as { code?: string }).code ?? "error"}.`);
  }
}

export function runGrantCommand(argv: string[], grants: GrantStore, out: (line: string) => void): number {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: { name: { type: "string" }, tier: { type: "string" }, "token-file": { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const tokenFile = values["token-file"];

  if (command === "create" && values.name && values.tier && positionals.length === 0) {
    if (tokenFile !== undefined) {
      // pnpm runs the command in the package folder. A relative path is
      // taken from the folder the user ran it in.
      const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), tokenFile);
      // The file is created first, so a path that cannot be written leaves
      // no grant behind.
      const fd = openTokenFile(file);
      try {
        const { grant, token } = grants.create(values.name, values.tier as Tier);
        writeSync(fd, `${token}\n`);
        out(`Created grant ${grant.id} "${grant.name}" with the ${grant.tier} tier.`);
        out(`Token written to ${file} (readable by you only). It is not shown here.`);
      } catch (err) {
        closeSync(fd);
        rmSync(file, { force: true });
        throw err;
      }
      closeSync(fd);
      return 0;
    }
    const { grant, token } = grants.create(values.name, values.tier as Tier);
    out(`Created grant ${grant.id} "${grant.name}" with the ${grant.tier} tier.`);
    out("Token (shown once, copy it into your MCP client config as APPT_GRANT_TOKEN):");
    out(token);
    return 0;
  }
  if (tokenFile !== undefined) {
    out(USAGE);
    return 2;
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
