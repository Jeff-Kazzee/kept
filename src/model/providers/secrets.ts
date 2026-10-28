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
//
// Nothing here logs, and no error message holds a value from the file.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
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

export class SecretsStore {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
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
