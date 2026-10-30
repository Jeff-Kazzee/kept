// The checks every hosted database file gets before and after it is
// opened (0010's secrets store pattern, 0014 and 0020): mode 600, owned by
// the user that runs the app, a regular file and never a symbolic link.
// `what` names the file in the error, such as "The accounts database".
// No error holds a value from the file.
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

export function checkPrivateFile(file: string, what: string, create: boolean, fail: (message: string) => Error): void {
  if (create) mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw fail(`${what} could not be checked: ${file}`);
    try {
      closeSync(openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw fail(`${what} could not be made: ${file}`);
    }
    return checkPrivateFile(file, what, false, fail);
  }
  if (st.isSymbolicLink()) throw fail(`${what} is a symbolic link. Remove it: ${file}`);
  if (!st.isFile()) throw fail(`${what} is not a regular file: ${file}`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw fail(`${what} belongs to another user: ${file}`);
  if ((st.mode & 0o077) !== 0) chmodSync(file, 0o600);
}
