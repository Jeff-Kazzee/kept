// A small JSON file that only the server's OS user can read (0012, item 3).
// It holds the Google refresh token and the connection's settings, outside
// the event log, so a Delete case, an export or an event read never sees a
// token. Writes are atomic: a new file with mode 600 is written, flushed and
// renamed over the old one, so a crash leaves the old file or the new one,
// never half of one. A file whose mode lets others read it is set back to
// 600 when read.
//
// Reads never follow a symbolic link (review round 1, finding 3): the path
// is checked with lstat, opened with O_NOFOLLOW, and the open descriptor is
// checked again with fstat, so a link swapped in between is refused too.
// The file must be a regular file owned by the server's user.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";

export class SecretFileError extends Error {
  override name = "SecretFileError";
}

export class SecretFile<T> {
  readonly path: string;
  readonly #schema: z.ZodType<T>;

  constructor(file: string, schema: z.ZodType<T>) {
    this.path = file;
    this.#schema = schema;
  }

  // The file's value, or null when there is no file. A file that is not
  // valid is an error with a fixed message, so its contents never reach a
  // log.
  read(): T | null {
    const r = this.readChecked();
    if ("invalid" in r) throw new SecretFileError(`${path.basename(this.path)} ${r.invalid}.`);
    return r.value;
  }

  // Like read, but a file that is not valid JSON or not of the expected
  // shape comes back as `invalid` instead of an error, with the parsed JSON
  // when there is some, so the caller can still recover from it. A link, a
  // FIFO or a file of another user is still an error.
  readChecked(): { value: T | null } | { invalid: "is not valid JSON" | "does not have the expected fields"; json: unknown } {
    const text = this.#readText();
    if (text === null) return { value: null };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { invalid: "is not valid JSON", json: undefined };
    }
    const parsed = this.#schema.safeParse(json);
    return parsed.success ? { value: parsed.data } : { invalid: "does not have the expected fields", json };
  }

  #readText(): string | null {
    const name = path.basename(this.path);
    let fd: number;
    try {
      const st = lstatSync(this.path);
      if (!st.isFile()) throw new SecretFileError(`${name} is not a regular file, so the app does not read it.`);
      // O_NONBLOCK keeps a FIFO swapped in after the lstat from holding the
      // open. It changes nothing for a regular file.
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      if (err instanceof SecretFileError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") throw new SecretFileError(`${name} is not a regular file, so the app does not read it.`);
      throw new SecretFileError(`Could not read ${name}.`);
    }
    let text: string;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new SecretFileError(`${name} is not a regular file, so the app does not read it.`);
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new SecretFileError(`${name} is not owned by the server's user.`);
      if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
      text = readFileSync(fd, "utf8");
    } catch (err) {
      if (err instanceof SecretFileError) throw err;
      throw new SecretFileError(`Could not read ${name}.`);
    } finally {
      closeSync(fd);
    }
    return text;
  }

  write(value: T): void {
    const dir = path.dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(this.path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(this.#schema.parse(value)));
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw err;
    }
    closeSync(fd);
    renameSync(tmp, this.path);
    // Flush the rename itself. Some file systems do not allow opening a
    // folder, and then the rename is still in place.
    try {
      const dfd = openSync(dir, "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // Nothing to do.
    }
  }
}
