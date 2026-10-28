// 0010, design item 2, the eval flags (item 6) and the chat wiring: the
// secrets database is mode 600, written in transactions, never opened
// through a symbolic link, and kept through Delete case. The scan covers
// its name and its token fields.
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasSecret, isSecretFileName, jsonSecretFields, scanBytes } from "../scripts/scan-secrets.ts";
import { ModelCallError } from "../src/model/client.ts";
import type { ToolModelClient } from "../src/model/responses.ts";
import { main } from "../src/eval/cli.ts";
import { CHATGPT_SESSION_ENDED_TEXT, providerError } from "../src/model/providers/messages.ts";
import { EMPTY_SETTINGS, SecretsFileError, SecretsStore, appSecretsPath } from "../src/model/providers/secrets.ts";
import { EventStore } from "../src/store/event-log.ts";
import { CLOCK, agentFor, say, services } from "./agent-helpers.ts";
import { FakeOpenAi, RESPONSES, signIn } from "./provider-fakes.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "secrets-"));
  dirs.push(dir);
  return dir;
}

describe("0010 secrets file", () => {
  const stores: SecretsStore[] = [];
  afterEach(() => {
    for (const st of stores.splice(0)) st.close();
  });
  const open = (file: string) => {
    const st = new SecretsStore(file);
    stores.push(st);
    return st;
  };

  it("lives beside the event log, in its own database", () => {
    expect(appSecretsPath({ APP_DB: "/tmp/x/app.sqlite" })).toBe("/tmp/x/app-secrets.sqlite");
  });

  it("is a SQLite file with mode 600, and its WAL and shared-memory files get the same mode", () => {
    const dir = tempDir();
    const file = path.join(dir, "data", "app-secrets.sqlite");
    const store = open(file);
    expect(store.read()).toEqual(EMPTY_SETTINGS);
    const saved = store.update((x) => ({ ...x, meta: { key: "key-12345678" } }), { bump: true });
    expect(saved.version).toBe(1);
    expect(statSync(path.dirname(file)).mode & 0o077).toBe(0);
    for (const f of readdirSync(path.dirname(file))) expect(statSync(path.join(path.dirname(file), f)).mode & 0o777, f).toBe(0o600);
    expect(readdirSync(path.dirname(file)).sort()).toEqual(["app-secrets.sqlite", "app-secrets.sqlite-shm", "app-secrets.sqlite-wal"]);
    expect(readFileSync(file).subarray(0, 15).toString("latin1")).toBe("SQLite format 3");
    expect(store.read().meta).toEqual({ key: "key-12345678" });
    // A refresh-like write does not move the version, and a null change
    // writes nothing.
    expect(store.update((x) => x, { bump: false }).version).toBe(1);
    expect(store.update(() => null, { bump: true }).version).toBe(1);
    // Another process's connection sees the write.
    expect(open(file).read().meta).toEqual({ key: "key-12345678" });
  });

  it("narrows wider permissions to 600 when opened", () => {
    const dir = tempDir();
    const file = path.join(dir, "app-secrets.sqlite");
    open(file).update((x) => x, { bump: true });
    stores.splice(0).forEach((st) => st.close());
    chmodSync(file, 0o644);
    open(file).read();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a symbolic link and never opens through one", () => {
    const dir = tempDir();
    const target = path.join(dir, "elsewhere.sqlite");
    writeFileSync(target, "");
    chmodSync(target, 0o644);
    const file = path.join(dir, "app-secrets.sqlite");
    symlinkSync(target, file);
    const store = open(file);
    expect(() => store.read()).toThrow(SecretsFileError);
    expect(() => store.update((x) => x, { bump: true })).toThrow(SecretsFileError);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(statSync(target).size).toBe(0);
  });

  it("names a bad row by its path and the failing fields, never its values", () => {
    const dir = tempDir();
    const file = path.join(dir, "app-secrets.sqlite");
    open(file).read();
    stores.splice(0).forEach((st) => st.close());
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO settings (id, version, data) VALUES (1, 0, ?)").run(JSON.stringify({ ...EMPTY_SETTINGS, meta: { key: "", leaked: "value-abcdef" } }));
    raw.close();
    const err = (() => {
      try {
        open(file).read();
      } catch (e) {
        return e as Error;
      }
    })()!;
    expect(err).toBeInstanceOf(SecretsFileError);
    expect(err.message).not.toContain("value-abcdef");
  });

  it("review round 2, finding 1: a session saved without an id reads, and gets one on the next write", () => {
    const dir = tempDir();
    const file = path.join(dir, "app-secrets.sqlite");
    open(file).read();
    stores.splice(0).forEach((st) => st.close());
    const old = { accessToken: "a", refreshToken: "r", expiresAt: 1, earliestRefreshAt: null, scopes: ["openid"], savedAt: "2026-10-28T00:00:00.000Z" };
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO settings (id, version, data) VALUES (1, 3, ?)").run(JSON.stringify({ ...EMPTY_SETTINGS, version: 3, chatgpt: { ...EMPTY_SETTINGS.chatgpt, session: old } }));
    raw.close();
    const store = open(file);
    expect(store.read().chatgpt.session).toEqual(old);
    const written = store.update((x) => ({ ...x, metaModel: "muse-wonder-1.0" }), { bump: true });
    expect(written.chatgpt.session!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.read().chatgpt.session).toEqual({ ...old, id: written.chatgpt.session!.id });
  });

  it("an update is one transaction: a version check and its write are a compare-and-swap across connections", () => {
    const dir = tempDir();
    const file = path.join(dir, "app-secrets.sqlite");
    const a = open(file);
    const b = open(file);
    const casAt = (st: SecretsStore, expected: number, key: string) => st.update((x) => (x.version === expected ? { ...x, meta: { key } } : null), { bump: true });
    expect(casAt(a, 0, "key-from-a-0001").version).toBe(1);
    // b read version 0 earlier and writes at it: refused, nothing written.
    expect(casAt(b, 0, "key-from-b-0002").meta).toEqual({ key: "key-from-a-0001" });
    expect(a.read().version).toBe(1);
  });

  it("Delete case leaves it alone: the event log and the secrets database are separate files", async () => {
    const dir = tempDir();
    const db = path.join(dir, "app.sqlite");
    const secrets = open(appSecretsPath({ APP_DB: db }));
    secrets.update((x) => ({ ...x, meta: { key: "key-12345678" } }), { bump: true });
    const app = services(new EventStore(db, CLOCK));
    app.kase.deleteCase(app.kase.caseVersion(), "DELETE");
    app.store.close();
    expect(secrets.read().meta).toEqual({ key: "key-12345678" });
  });
});

describe("0010 secret scan patterns", () => {
  it("finds the settings file's token fields and the Meta key, and skips placeholders", () => {
    // Made at test time, so no sample secret is written in this file.
    const token = randomBytes(18).toString("base64url");
    const metaKey = `LLM|${randomBytes(9).toString("hex")}`;
    expect(hasSecret(`    "accessToken": "${token}",`)).toBe(true);
    expect(hasSecret(`"refresh_token":"${token}"`)).toBe(true);
    expect(hasSecret('  "meta": { "key": "' + metaKey + '" },')).toBe(true);
    expect(hasSecret('  "access_token": "<ACCESS_TOKEN>",')).toBe(false);
    expect(hasSecret('  "refresh_token": "<REFRESH_TOKEN>",')).toBe(false);
    expect(hasSecret('  "meta": { "key": "<META_KEY>" },')).toBe(false);
    expect(hasSecret('  "accessToken": "short",')).toBe(false);
  });

  it("review round 2, finding 8: a key the app accepts with angle brackets or a backslash is found", () => {
    const tail = randomBytes(6).toString("hex");
    for (const key of [`<${tail}>`, `ab<cd>${tail}`, `k\\ey${tail}`, `q"uo${tail}`]) {
      const stored = JSON.stringify({ meta: { key } });
      expect(hasSecret(stored), key).toBe(true);
      expect(jsonSecretFields(stored), key).toEqual(["meta.key"]);
      const pretty = JSON.stringify({ meta: { key } }, null, 2);
      let lines: number[] = [];
      scanBytes(Buffer.from(pretty), (line) => lines.push(line));
      expect(lines, key).toEqual([3]);
      lines = [];
    }
    const token = `<${randomBytes(12).toString("hex")}>`;
    expect(hasSecret(JSON.stringify({ accessToken: token }))).toBe(true);
    // Only the exact placeholder shape is skipped.
    expect(jsonSecretFields(JSON.stringify({ meta: { key: "<META_KEY>" }, refreshToken: "<REFRESH_TOKEN_VALUE>" }))).toEqual([]);
  });

  it("finds the settings database, its side files, the older JSON file and local env files by name", () => {
    for (const name of [
      "data/app-secrets.sqlite",
      "app-secrets.sqlite-wal",
      "app-secrets.sqlite-shm",
      "app-secrets.sqlite-journal",
      "data/app-secrets.json",
      "data/.app-secrets.json.0f1e.tmp",
      ".env.local",
      "x/.env.production.local",
    ]) {
      expect(isSecretFileName(name), name).toBe(true);
    }
    for (const name of [".env.schema", "docs/app-secrets.md", "src/model/providers/secrets.ts", ".env", "data/app.sqlite"]) expect(isSecretFileName(name), name).toBe(false);
  });
});

describe("0010 live eval --provider and --model", () => {
  const run = async (args: string[], env: Record<string, string | undefined> = {}, fetch?: FakeOpenAi) => {
    const errors: string[] = [];
    const code = await main(args, { MODEL_API_KEY: "", ...env }, { error: (l) => errors.push(l), log: () => {}, chatGptFetch: fetch?.fetch });
    return { code, errors };
  };

  it("refuses a bad provider or model, and ChatGPT without a saved connection", async () => {
    expect(await run(["--provider", "openai"])).toEqual({ code: 2, errors: ["--provider must be meta or chatgpt."] });
    expect(await run(["--model", "muse-spark-1.3-contributor"])).toEqual({ code: 2, errors: ["--model for meta must be one of muse-spark-1.3, muse-wonder-1.0."] });
    expect(await run(["--provider", "chatgpt", "--recorded"])).toMatchObject({ code: 2 });
    const dir = tempDir();
    const none = await run(["--provider", "chatgpt"], { APP_DB: path.join(dir, "app.sqlite") });
    expect(none.code).toBe(2);
    expect(none.errors[0]).toMatch(/^No ChatGPT connection is saved/);
  });

  it("with a saved connection, checks --model against its listing", async () => {
    const dir = tempDir();
    const db = path.join(dir, "app.sqlite");
    const fake = new FakeOpenAi();
    await signIn(fake, new SecretsStore(appSecretsPath({ APP_DB: db })));
    const bad = await run(["--provider", "chatgpt", "--model", "gpt-unknown", "--chat"], { APP_DB: db }, fake);
    expect(bad.code).toBe(2);
    expect(bad.errors[0]).toBe("--model for chatgpt must be a model the connection lists: gpt-6.1-terra, gpt-6.1-sol.");
  });

  it("runs the chat eval on the ChatGPT connection with the chosen model", async () => {
    const dir = tempDir();
    const db = path.join(dir, "app.sqlite");
    const fake = new FakeOpenAi();
    await signIn(fake, new SecretsStore(appSecretsPath({ APP_DB: db })));
    const out = path.join(dir, "chat.json");
    const r = await run(["--provider", "chatgpt", "--model", "gpt-6.1-terra", "--chat", "--chat-runs", "1", "--chat-script", "booked-monday", "--out", out], { APP_DB: db }, fake);
    expect([0, 1]).toContain(r.code);
    const bodies = fake.to(RESPONSES).map((q) => JSON.parse(q.body) as { model: string; store: boolean; stream: boolean });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).toMatchObject({ model: "gpt-6.1-terra", store: false, stream: true });
  });
});

describe("0010 chat wiring", () => {
  it("a provider's fixed sentence reaches the chat in place of the generic one", async () => {
    const app = services(new EventStore(":memory:", CLOCK));
    const client: ToolModelClient = {
      label: "test",
      respond: async () => {
        throw providerError(CHATGPT_SESSION_ENDED_TEXT, { type: "chatgpt_auth", code: "session_ended" });
      },
    };
    const r = await say(agentFor(app, client), app, "Am I booked Monday?");
    expect(r.text).toBe(CHATGPT_SESSION_ENDED_TEXT);
    expect(r.of("turn.error")).toEqual([{ turnId: r.report.turnId, code: "model_unavailable", message: CHATGPT_SESSION_ENDED_TEXT }]);
  });

  it("a plain model error still shows the generic sentence", () => {
    expect(new ModelCallError("x").userText).toBeNull();
  });
});
