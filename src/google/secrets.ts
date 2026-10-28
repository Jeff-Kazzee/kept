// A small JSON file that only the server's OS user can read (0012, item 3).
// It holds the Google refresh token and the connection's settings, outside
// the event log, so a Delete case, an export or an event read never sees a
// token. Writes are atomic: a new file with mode 600 is written, flushed and
// renamed over the old one, so a crash leaves the old file or the new one,
// never half of one. A file whose mode lets others read it is set back to
// 600 when read.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
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
    let text: string;
    try {
      const mode = statSync(this.path).mode & 0o777;
      if ((mode & 0o077) !== 0) chmodSync(this.path, 0o600);
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new SecretFileError(`Could not read ${path.basename(this.path)}.`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SecretFileError(`${path.basename(this.path)} is not valid JSON.`);
    }
    const parsed = this.#schema.safeParse(json);
    if (!parsed.success) throw new SecretFileError(`${path.basename(this.path)} does not have the expected fields.`);
    return parsed.data;
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
