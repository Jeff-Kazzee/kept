// Every file path resolves from the package root, never from the current
// directory, so scripts work when run as `pnpm --dir <package> ...`.
import { fileURLToPath } from "node:url";
import path from "node:path";

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES_DIR = path.join(PACKAGE_ROOT, "fixtures");
export const RECORDINGS_DIR = path.join(FIXTURES_DIR, "recordings");

export function fromPackage(...parts: string[]): string {
  return path.join(PACKAGE_ROOT, ...parts);
}

// The app's event log. The app, the MCP server and the grant command open
// this one file, so a grant revoked in the app stops the next agent call.
export function appDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(PACKAGE_ROOT, env.APP_DB ?? "data/app.sqlite");
}
