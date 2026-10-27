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
