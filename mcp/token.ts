// Where the stdio server gets its grant token. The client's config sets
// either APPT_GRANT_TOKEN, the token itself, or APPT_GRANT_TOKEN_FILE, the
// path of a file that holds it. The file is read once at start. It must be
// a regular file that only its owner can read, because anyone who can read
// it can use the grant. Both variables are removed from the environment, so
// nothing this process starts inherits them. No message names the token.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

// A token is 48 characters. Anything much longer is not a token file.
const MAX_FILE_BYTES = 1024;

export class TokenSourceError extends Error {
  override name = "TokenSourceError";
}

function readTokenFile(file: string): string {
  let fd: number;
  try {
    // O_NONBLOCK, so a FIFO or a device at the path cannot hang the start.
    // The checks below refuse anything but a regular file. On a regular
    // file the flag changes nothing.
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    throw new TokenSourceError(`Could not open the token file ${file}: ${(err as { code?: string }).code ?? "error"}.`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new TokenSourceError(`The token file ${file} is not a regular file.`);
    if ((stat.mode & 0o077) !== 0) {
      throw new TokenSourceError(`The token file ${file} can be read by other users. Run chmod 600 on it, then start the server again.`);
    }
    if (stat.size > MAX_FILE_BYTES) throw new TokenSourceError(`The token file ${file} is too large to hold a token.`);
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, length).toString("utf8").trim();
    if (token.length === 0) throw new TokenSourceError(`The token file ${file} is empty.`);
    return token;
  } finally {
    closeSync(fd);
  }
}

export function takeGrantToken(env: NodeJS.ProcessEnv): string {
  const direct = env.APPT_GRANT_TOKEN;
  const file = env.APPT_GRANT_TOKEN_FILE;
  delete env.APPT_GRANT_TOKEN;
  delete env.APPT_GRANT_TOKEN_FILE;
  const hasDirect = direct !== undefined && direct.length > 0;
  const hasFile = file !== undefined && file.length > 0;
  if (hasDirect && hasFile) throw new TokenSourceError("Set APPT_GRANT_TOKEN or APPT_GRANT_TOKEN_FILE, not both.");
  if (hasFile) return readTokenFile(file);
  if (hasDirect) return direct;
  throw new TokenSourceError(
    "Set APPT_GRANT_TOKEN_FILE (or APPT_GRANT_TOKEN) in this server's entry in your MCP client config. " +
      "Create a grant in the app, or with: pnpm grant create --name <name> --tier read --token-file <path>",
  );
}
