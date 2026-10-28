// The app's provider settings and secrets (0010, design item 2): the
// chosen provider, the user's Meta key and the ChatGPT connection. One JSON
// file beside the event log, outside it, so Delete case leaves it alone.
//
// - Mode 600, owned by the user that runs the app. A file with wider
//   permissions is narrowed to 600 when read.
// - Written atomically: a new file with a random name is written, flushed
//   and renamed over the old one, so a crash leaves the old file or the new
//   one, never half of one.
// - Never followed through a symbolic link. Reads open with O_NOFOLLOW, and
//   a rename replaces a link itself, never its target.
// - Read from disk on every use, so the app and `pnpm eval:live` see each
//   other's token refreshes.
// - `withLock` serializes the steps that read, call OpenAI and write the
//   ChatGPT session (refresh, sign-in completion, sign-out), within this
//   process through a queue and between processes through a lock file made
//   with O_EXCL beside the secrets file. A lock file older than
//   LOCK_STALE_MS is taken over, as its holder has stopped.
//
// Nothing here logs, and no error message holds a value from the file.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { z } from "zod";
import { appDbPath } from "../../paths.ts";

export const SECRETS_FILE_NAME = "app-secrets.json";

// The secrets file sits in the event log's folder: data/ by default.
export function appSecretsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(appDbPath(env)), SECRETS_FILE_NAME);
}

export const ProviderKind = z.enum(["meta", "chatgpt"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

const ChatGptSession = z
  .object({
    // Made at sign-in and kept through refreshes. A refresh stores its
    // result only while the same session is still stored.
    id: z.string().min(1),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).nullable(),
    // Unix milliseconds.
    expiresAt: z.number().int(),
    earliestRefreshAt: z.number().int().nullable(),
    scopes: z.array(z.string()),
    savedAt: z.string(),
  })
  .strict();
export type ChatGptSession = z.infer<typeof ChatGptSession>;

const ChatGptAccount = z
  .object({ issuer: z.string(), subject: z.string().min(1), email: z.string().nullable(), name: z.string().nullable() })
  .strict();
export type ChatGptAccount = z.infer<typeof ChatGptAccount>;

const ChatGptModel = z.object({ slug: z.string().min(1).max(200), displayName: z.string().min(1).max(200) }).strict();
export type ChatGptModel = z.infer<typeof ChatGptModel>;

const ChatGptRecord = z
  .object({
    // The host's ext_agent_host_id, made once, kept through sign-out.
    hostId: z.string().nullable(),
    // The issued client id from the first registration, kept through
    // sign-out so a later sign-in reuses it.
    clientId: z.string().nullable(),
    account: ChatGptAccount.nullable(),
    session: ChatGptSession.nullable(),
    models: z.array(ChatGptModel),
    // The user's model choice. Null uses the code default (see models.ts).
    model: z.string().nullable(),
  })
  .strict();
export type ChatGptRecord = z.infer<typeof ChatGptRecord>;

const ModelProblem = z
  .object({ provider: ProviderKind, model: z.string(), capability: z.enum(["tool_calling", "structured_output", "streaming", "other"]) })
  .strict();
export type ModelProblem = z.infer<typeof ModelProblem>;

const StoredSettings = z
  .object({
    format: z.literal(1),
    // Counts every change the settings page can see. Token refreshes do
    // not count.
    version: z.number().int().nonnegative(),
    provider: ProviderKind.nullable(),
    meta: z.object({ key: z.string().min(1) }).strict().nullable(),
    // The user's Meta model choice. Null uses the default (models.ts).
    metaModel: z.string().nullable().default(null),
    chatgpt: ChatGptRecord,
    // The last model that failed a capability the app needs, shown in
    // settings until the user picks another model or provider.
    modelProblem: ModelProblem.nullable().default(null),
  })
  .strict();
export type StoredSettings = z.infer<typeof StoredSettings>;

export const EMPTY_SETTINGS: StoredSettings = {
  format: 1,
  version: 0,
  provider: null,
  meta: null,
  metaModel: null,
  chatgpt: { hostId: null, clientId: null, account: null, session: null, models: [], model: null },
  modelProblem: null,
};

export class SecretsFileError extends Error {
  override name = "SecretsFileError";
}

// A lock older than this is taken over. Longer than any step it guards:
// the token request times out after 30 seconds.
export const LOCK_STALE_MS = 60_000;
// How long a step waits for the lock before it gives up.
export const LOCK_WAIT_MS = 75_000;

export class SecretsLockError extends Error {
  override name = "SecretsLockError";
  constructor() {
    super("The app's settings file stayed locked by another process.");
  }
}

// One queue per file in this process, shared by every store on that file.
const queues = new Map<string, Promise<unknown>>();

export class SecretsStore {
  readonly file: string;
  readonly #now: () => number;

  constructor(file: string, options: { now?: () => number } = {}) {
    this.file = file;
    this.#now = options.now ?? Date.now;
  }

  get lockFile(): string {
    return `${this.file}.lock`;
  }

  // Runs `fn` holding the lock: first this process's queue, then the lock
  // file. Not reentrant: `fn` must not call withLock.
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.file) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      const token = await this.#acquire();
      try {
        return await fn();
      } finally {
        this.#release(token);
      }
    });
    const tail = run.catch(() => {});
    queues.set(this.file, tail);
    void tail.then(() => {
      if (queues.get(this.file) === tail) queues.delete(this.file);
    });
    return run;
  }

  async #acquire(): Promise<string> {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const started = Date.now();
    for (;;) {
      try {
        const fd = openSync(this.lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          writeSync(fd, `${token} ${process.pid} ${this.#now()}\n`);
        } finally {
          closeSync(fd);
        }
        return token;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      this.#takeOverStale();
      if (Date.now() - started > LOCK_WAIT_MS) throw new SecretsLockError();
      await delay(25);
    }
  }

  // Moves a stale lock aside under a new name, then checks that what moved
  // is the stale lock that was read. If another process put a fresh lock
  // there in between, the fresh one is put back.
  #takeOverStale(): void {
    let held: { token: string; at: number };
    try {
      const st = lstatSync(this.lockFile);
      const [tok, , at] = readFileSync(this.lockFile, "utf8").trim().split(" ");
      held = { token: tok ?? "", at: Number(at) || st.mtimeMs };
    } catch {
      return;
    }
    if (this.#now() - held.at < LOCK_STALE_MS) return;
    const aside = `${this.lockFile}.${randomUUID()}.stale`;
    try {
      renameSync(this.lockFile, aside);
    } catch {
      return;
    }
    try {
      const moved = readFileSync(aside, "utf8").trim().split(" ")[0];
      if (moved !== held.token) {
        try {
          linkSync(aside, this.lockFile);
        } catch {
          // A newer lock is in place already.
        }
      }
    } finally {
      rmSync(aside, { force: true });
    }
  }

  #release(token: string): void {
    try {
      if (readFileSync(this.lockFile, "utf8").split(" ")[0] === token) rmSync(this.lockFile, { force: true });
    } catch {
      // Already gone, or taken over after going stale.
    }
  }

  read(): StoredSettings {
    let fd: number;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return structuredClone(EMPTY_SETTINGS);
      if (code === "ELOOP") throw new SecretsFileError(`The app's settings file is a symbolic link. Remove it: ${this.file}`);
      throw new SecretsFileError(`The app's settings file could not be opened (${code ?? "unknown"}).`);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new SecretsFileError(`The app's settings file is not a regular file: ${this.file}`);
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new SecretsFileError(`The app's settings file belongs to another user: ${this.file}`);
      }
      if ((stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
      const text = readFileSync(fd, "utf8");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new SecretsFileError(`The app's settings file is not valid JSON: ${this.file}`);
      }
      const parsed = StoredSettings.safeParse(json);
      // The issue paths only, never the values.
      if (!parsed.success) throw new SecretsFileError(`The app's settings file has an unexpected shape at ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}.`);
      return parsed.data;
    } finally {
      closeSync(fd);
    }
  }

  // Reads, applies `change` and writes the result. `bump` adds one to the
  // settings version, for a change the settings page can see.
  update(change: (current: StoredSettings) => StoredSettings, options: { bump: boolean }): StoredSettings {
    const next = change(this.read());
    const written = StoredSettings.parse(options.bump ? { ...next, version: next.version + 1 } : next);
    this.#write(written);
    return written;
  }

  #write(settings: StoredSettings): void {
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.${path.basename(this.file)}.${randomUUID()}.tmp`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      // The umask may have narrowed it further, never widened it. Set it
      // exactly.
      fchmodSync(fd, 0o600);
      writeSync(fd, JSON.stringify(settings, null, 2) + "\n");
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      rmSync(temp, { force: true });
      throw err;
    }
    closeSync(fd);
    try {
      renameSync(temp, this.file);
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
    // Flush the rename itself.
    try {
      const dfd = openSync(dir, constants.O_RDONLY);
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // Some file systems do not allow fsync on a folder.
    }
  }
}
