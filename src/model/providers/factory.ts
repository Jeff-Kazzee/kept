// The provider factory (0010, design item 1). One client object stands in
// for the model everywhere: extraction, explanations, questions, templates
// and the chat agent hold it as their ModelClient or ToolModelClient and
// never learn which provider answers. Each call reads the settings and goes
// to the provider the user chose, and only to it. A provider that cannot
// take the call fails it with a fixed sentence. It never hands the call to
// the other provider.
//
// A provider is one entry in the table passed to ProviderModelClient. A
// later kind, such as hosted credit on the app's own key with per-user
// metering, is a new entry and a new ProviderKind value. Callers do not
// change.
import { MetaResponsesClient, ModelCallError, type ModelCall, type ModelClient, type ModelReply } from "../client.ts";
import type { ToolCall, ToolModelClient, ToolReply } from "../responses.ts";
import { ChatGptAuth } from "./chatgpt-auth.ts";
import { ChatGptResponsesClient } from "./chatgpt-client.ts";
import {
  CHATGPT_SESSION_ENDED_TEXT,
  CHATGPT_SIGNED_OUT_TEXT,
  META_KEY_MISSING_TEXT,
  NO_PROVIDER_TEXT,
  PLAN_USAGE_OFF_TEXT,
  SETTINGS_BUSY_TEXT,
  SETTINGS_FILE_TEXT,
  providerError,
} from "./messages.ts";
import { capabilityProblem, chatGptModel, currentModel, metaModel, modelOptions, modelProblemText } from "./models.ts";
import type { FetchLike } from "./oidc.ts";
import { SecretsBusyError, SecretsFileError, type ProviderKind, type SecretsStore, type StoredSettings } from "./secrets.ts";

export type LiveClient = ModelClient & ToolModelClient;


export type ProviderContext = { settings: StoredSettings; serverMetaKey: string | null };

export type ProviderDefinition = {
  readonly kind: ProviderKind;
  // A fixed sentence when this provider cannot take a call, or null.
  unavailable(ctx: ProviderContext): string | null;
  client(ctx: ProviderContext): LiveClient;
};

// The Meta key in use: the user's own, else the server's MODEL_API_KEY.
export function metaKey(ctx: ProviderContext): { key: string; source: "you" | "server" } | null {
  if (ctx.settings.meta) return { key: ctx.settings.meta.key, source: "you" };
  if (ctx.serverMetaKey) return { key: ctx.serverMetaKey, source: "server" };
  return null;
}

// The provider calls go to: the user's choice, else Meta when a Meta key is
// set, else none. Meta is the default because it needs no sign-in.
export function activeProvider(ctx: ProviderContext): ProviderKind | null {
  if (ctx.settings.provider) return ctx.settings.provider;
  return metaKey(ctx) ? "meta" : null;
}

// The Meta client as it is, with the chosen Muse model put in each request.
// The Meta client still refuses a contributor model.
function withModel(inner: MetaResponsesClient, model: string): LiveClient {
  return {
    label: inner.label,
    call: (request) => inner.call({ ...request, body: { ...request.body, model } }),
    respond: (request) => inner.respond({ ...request, body: { ...request.body, model } }),
  };
}

export function metaProvider(options: { url?: string } = {}): ProviderDefinition {
  // One client per key, so a changed key gets a new client.
  let cached: { key: string; client: MetaResponsesClient } | null = null;
  return {
    kind: "meta",
    unavailable: (ctx) => (metaKey(ctx) ? null : META_KEY_MISSING_TEXT),
    client(ctx) {
      const { key } = metaKey(ctx)!;
      if (cached?.key !== key) cached = { key, client: new MetaResponsesClient({ apiKey: key, url: options.url }) };
      return withModel(cached.client, metaModel(ctx.settings));
    },
  };
}

export function chatGptProvider(options: { auth: ChatGptAuth; store: SecretsStore; url?: string; fetch?: FetchLike }): ProviderDefinition {
  const client = new ChatGptResponsesClient({
    auth: options.auth,
    model: () => chatGptModel(options.store.read()),
    url: options.url,
    fetch: options.fetch,
  });
  return {
    kind: "chatgpt",
    // Review round 1, finding 1: read from the stored connection, so a
    // signed-out ChatGPT, one without plan usage, or one whose expired token
    // cannot be renewed is not ready. The client still says so after a
    // refresh fails.
    unavailable: (ctx) => {
      const kind = ChatGptAuth.unavailable(ctx.settings, options.auth.now());
      return kind === "signed_out" ? CHATGPT_SIGNED_OUT_TEXT : kind === "plan_usage_off" ? PLAN_USAGE_OFF_TEXT : kind === "session_ended" ? CHATGPT_SESSION_ENDED_TEXT : null;
    },
    client: () => client,
  };
}

export class ProviderModelClient implements LiveClient {
  readonly #store: SecretsStore;
  readonly #serverMetaKey: string | null;
  readonly #providers: ReadonlyMap<ProviderKind, ProviderDefinition>;

  constructor(options: { store: SecretsStore; serverMetaKey: string | null; providers: ProviderDefinition[] }) {
    this.#store = options.store;
    this.#serverMetaKey = options.serverMetaKey || null;
    this.#providers = new Map(options.providers.map((p) => [p.kind, p]));
  }

  context(): ProviderContext {
    return { settings: this.#store.read(), serverMetaKey: this.#serverMetaKey };
  }

  get label(): string {
    try {
      const kind = activeProvider(this.context());
      return kind ? `${kind}-responses` : "no-provider";
    } catch {
      return "no-provider";
    }
  }

  // J12: true when the chosen provider can take a call: a Meta key from
  // the person or the server, or a ChatGPT sign-in that may use the plan.
  // A settings file that cannot be read counts as ready, so the call fails
  // with the sentence that says so.
  ready(): boolean {
    let ctx: ProviderContext;
    try {
      ctx = this.context();
    } catch (err) {
      if (err instanceof SecretsFileError || err instanceof SecretsBusyError) return true;
      throw err;
    }
    const kind = activeProvider(ctx);
    const provider = kind ? this.#providers.get(kind) : undefined;
    return provider !== undefined && provider.unavailable(ctx) === null;
  }

  #client(): { client: LiveClient; kind: ProviderKind; model: string; settings: StoredSettings } {
    let ctx: ProviderContext;
    try {
      ctx = this.context();
    } catch (err) {
      if (err instanceof SecretsFileError) throw providerError(SETTINGS_FILE_TEXT, { type: "provider", code: "settings_file" });
      if (err instanceof SecretsBusyError) throw providerError(SETTINGS_BUSY_TEXT, { type: "provider", code: "settings_busy" });
      throw err;
    }
    const kind = activeProvider(ctx);
    const provider = kind ? this.#providers.get(kind) : undefined;
    if (!provider) throw providerError(NO_PROVIDER_TEXT, { type: "provider", code: "none" });
    const problem = provider.unavailable(ctx);
    if (problem) throw providerError(problem, { type: "provider", code: `${kind}_unavailable` });
    return { client: provider.client(ctx), kind: kind!, model: currentModel(ctx.settings, kind!), settings: ctx.settings };
  }

  // A call the model refused for a missing capability is named in settings
  // and fails with a sentence that says so. It is not retried elsewhere.
  async #run<T>(json: boolean, tools: boolean, send: (client: LiveClient) => Promise<T>): Promise<T> {
    const { client, kind, model, settings } = this.#client();
    try {
      return await send(client);
    } catch (err) {
      if (!(err instanceof ModelCallError)) throw err;
      const capability = capabilityProblem(err, { tools, json });
      if (capability === null) throw err;
      const problem = { provider: kind, model, capability };
      if (JSON.stringify(settings.modelProblem) !== JSON.stringify(problem)) {
        try {
          this.#store.update((s) => ({ ...s, modelProblem: problem }), { bump: true });
        } catch {
          // The call still fails with the sentence below. The settings
          // notice waits for the next failure.
        }
      }
      const label = modelOptions(settings, kind).find((m) => m.id === model)?.label ?? model;
      const text = modelProblemText(problem, label);
      throw providerError(text, { status: err.status, latencyMs: err.latencyMs, type: err.errorType, code: err.errorCode, param: err.errorParam });
    }
  }

  call(request: ModelCall): Promise<ModelReply> {
    return this.#run(true, false, (client) => client.call(request));
  }

  respond(request: ToolCall): Promise<ToolReply> {
    return this.#run(false, request.body.tools.length > 0, (client) => client.respond(request));
  }
}

// The live providers for the app and the eval: Meta and ChatGPT.
export function createProviderClient(options: {
  store: SecretsStore;
  auth: ChatGptAuth;
  serverMetaKey: string | null;
  metaUrl?: string;
  chatGptUrl?: string;
  fetch?: FetchLike;
}): ProviderModelClient {
  return new ProviderModelClient({
    store: options.store,
    serverMetaKey: options.serverMetaKey,
    providers: [metaProvider({ url: options.metaUrl }), chatGptProvider({ auth: options.auth, store: options.store, url: options.chatGptUrl, fetch: options.fetch })],
  });
}
