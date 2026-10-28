// 0010, design item 2, the eval flags (item 6) and the chat wiring: the
// secrets file is mode 600, written atomically, never followed through a
// symbolic link, and kept through Delete case. The scan covers its name and
// its token fields.
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasSecret, isSecretFileName } from "../scripts/scan-secrets.ts";
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
  it("lives beside the event log, outside it", () => {
    expect(appSecretsPath({ APP_DB: "/tmp/x/app.sqlite" })).toBe("/tmp/x/app-secrets.json");
  });

  it("is written with mode 600, atomically, with no temporary file left", () => {
    const dir = tempDir();
    const file = path.join(dir, "data", "app-secrets.json");
    const store = new SecretsStore(file);
    expect(store.read()).toEqual(EMPTY_SETTINGS);
    const saved = store.update((s) => ({ ...s, meta: { key: "key-12345678" } }), { bump: true });
    expect(saved.version).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o077).toBe(0);
    expect(readdirSync(path.dirname(file))).toEqual(["app-secrets.json"]);
    expect(store.read().meta).toEqual({ key: "key-12345678" });
    // A refresh-like write does not move the version.
    expect(store.update((s) => s, { bump: false }).version).toBe(1);
  });

  it("narrows wider permissions to 600 when read", () => {
    const dir = tempDir();
    const file = path.join(dir, "app-secrets.json");
    writeFileSync(file, JSON.stringify(EMPTY_SETTINGS));
    chmodSync(file, 0o644);
    new SecretsStore(file).read();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a symbolic link and never writes through one", () => {
    const dir = tempDir();
    const target = path.join(dir, "elsewhere.json");
    writeFileSync(target, JSON.stringify(EMPTY_SETTINGS));
    chmodSync(target, 0o644);
    const file = path.join(dir, "app-secrets.json");
    symlinkSync(target, file);
    const store = new SecretsStore(file);
    expect(() => store.read()).toThrow(SecretsFileError);
    expect(() => store.update((s) => s, { bump: true })).toThrow(SecretsFileError);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it("names a bad file by its path and the failing fields, never its values", () => {
    const dir = tempDir();
    const file = path.join(dir, "app-secrets.json");
    writeFileSync(file, JSON.stringify({ ...EMPTY_SETTINGS, meta: { key: "", leaked: "value-abcdef" } }), { mode: 0o600 });
    const err = (() => {
      try {
        new SecretsStore(file).read();
      } catch (e) {
        return e as Error;
      }
    })()!;
    expect(err).toBeInstanceOf(SecretsFileError);
    expect(err.message).not.toContain("value-abcdef");
  });

  it("Delete case leaves it alone: the event log and the secrets file are separate files", async () => {
    const dir = tempDir();
    const db = path.join(dir, "app.sqlite");
    const secrets = new SecretsStore(appSecretsPath({ APP_DB: db }));
    secrets.update((s) => ({ ...s, meta: { key: "key-12345678" } }), { bump: true });
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
    expect(hasSecret('  "accessToken": "short",')).toBe(false);
  });

  it("finds the settings file and local env files by name", () => {
    for (const name of ["data/app-secrets.json", "app-secrets.json", "data/.app-secrets.json.0f1e.tmp", ".env.local", "x/.env.production.local"]) {
      expect(isSecretFileName(name), name).toBe(true);
    }
    for (const name of [".env.schema", "docs/app-secrets.md", "src/model/providers/secrets.ts", ".env"]) expect(isSecretFileName(name), name).toBe(false);
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
