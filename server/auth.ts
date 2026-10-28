// Provider settings and sign-in routes (0010). Kept free of sockets, like
// api.ts, so tests call them directly. The server runs its host allowlist,
// same-origin and app header checks before these, as for every /api route.
// They are app
// settings, not case data: they need no case generation header, and Delete
// case does not touch them.
//
// GET /api/settings and PUT /api/settings/timezone are served by
// server/settings.ts, with this module's part through `source`.
// Every write but the sign-in start carries the settingsVersion the page
// read, and a stale one gets 409 stale_edit with nothing written.
//
// PUT    /api/settings/provider     { provider, expectedVersion }
// PUT    /api/settings/model        { model, expectedVersion }, a model from
//                                   the current provider's list
// POST   /api/auth/meta-key         { key, expectedVersion } stores the
//                                   user's Meta key
// DELETE /api/auth/meta-key         { expectedVersion } removes it
// POST   /api/auth/chatgpt/start    { authorizeUrl } for the page to open
// POST   /api/auth/chatgpt/signout  { expectedVersion } revokes and clears
//                                   the ChatGPT tokens
// GET    /auth/callback             the loopback redirect from OpenAI. Not
//                                   under /api: the browser arrives here
//                                   from auth.openai.com, so the page's
//                                   source checks cannot apply. The one-use
//                                   state is the check.
//
// A Meta key or ChatGPT token never appears in a response, an error or a
// log line written here.
import { z } from "zod";
import { DEFAULT_TIME_ZONE } from "../src/domain/zone.ts";
import { CALLBACK_PATH, ChatGptAuth, type CallbackCode } from "../src/model/providers/chatgpt-auth.ts";
import { activeProvider, metaKey } from "../src/model/providers/factory.ts";
import { currentModel, modelOptions, modelProblemText, type ModelOption } from "../src/model/providers/models.ts";
import { IdentityError } from "../src/model/providers/oidc.ts";
import { ProviderKind, SecretsBusyError, SecretsFileError, type SecretsStore, type StoredSettings } from "../src/model/providers/secrets.ts";
import type { ApiResponse } from "./api.ts";

export { CALLBACK_PATH };

export type TimezoneSettings = { timezone: string; timezoneSource: "you" | "agent" | "browser" | "default"; version: number };

// With no time zone source, as in tests of these routes alone, the default
// zone at version 0. The app passes sprint 8's (server/main.ts).
export const DEFAULT_TIMEZONE: () => TimezoneSettings = () => ({ timezone: DEFAULT_TIME_ZONE, timezoneSource: "default", version: 0 });

export type SettingsView = {
  settingsVersion: number;
  timezone: string;
  timezoneSource: TimezoneSettings["timezoneSource"];
  provider: ProviderKind | null;
  meta: { keySet: boolean; source: "you" | "server" | null };
  chatgpt: { signedIn: boolean; name: string | null; email: string | null; planUsage: boolean };
  // The model for the current provider and the ones the user may pick.
  // Empty with no provider.
  model: string;
  models: ModelOption[];
  // Set when the chosen model failed a capability the app needs.
  modelNotice: string | null;
};

export type AuthRequest = { method: string; path: string; body: unknown };

const ProviderBody = z.object({ provider: ProviderKind, expectedVersion: z.number().int().nonnegative() }).strict();
const ModelBody = z.object({ model: z.string().min(1).max(200), expectedVersion: z.number().int().nonnegative() }).strict();

export const KEY_FORMAT_TEXT = "That does not look like a Meta Model API key. Paste the key on its own, with no spaces. Nothing was saved.";
export const SETTINGS_UNREADABLE_TEXT = "The app could not read its settings file. The app's terminal says why. Nothing was saved.";
export const SIGN_IN_UNAVAILABLE_TEXT = "ChatGPT sign-in is not reachable just now. Try again in a moment, or use a Meta key.";
export const SIGNED_OUT_UNCONFIRMED_TEXT =
  "You are signed out of ChatGPT in this app. ChatGPT did not confirm the sign-out on its side. You can also disconnect the app in ChatGPT settings.";
export const NO_PROVIDER_MODEL_TEXT = "Choose a provider first: add a Meta key or sign in with ChatGPT. Nothing was changed.";
export const UNKNOWN_MODEL_TEXT = "That model is not in the list for the current provider. Pick one from the list. Nothing was changed.";
export const NOT_READY_TEXT: Record<ProviderKind, string> = {
  meta: "Add a Meta Model API key first, then choose Meta. Nothing was changed.",
  chatgpt: "Sign in with ChatGPT first, then choose ChatGPT. Nothing was changed.",
};

export const SETTINGS_BUSY_TEXT = "The app's settings are busy in another window or process. Try again in a moment. Nothing was changed.";
export const SETTINGS_BUSY: ApiResponse = { status: 503, body: { error: "settings_busy", retryable: true, message: SETTINGS_BUSY_TEXT } };

export const VERSION_REQUIRED: ApiResponse = {
  status: 400,
  body: { error: "invalid_body", issues: [{ path: "expectedVersion", message: "Send the settingsVersion this page read, a whole number of 0 or more." }] },
};

const versionOf = (fields: Record<string, unknown> | null): number | null => {
  const v = fields?.expectedVersion;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
};

// A body of only { expectedVersion }.
const versionOnly = (body: unknown): number | null => {
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!fields || Object.keys(fields).some((k) => k !== "expectedVersion")) return null;
  return versionOf(fields);
};

// A key is one run of printable characters with no spaces. Nothing more is
// known about Meta's key format, so nothing more is checked.
const KEY = /^[\x21-\x7e]{8,512}$/;

export function createAuth(options: {
  store: SecretsStore;
  auth: ChatGptAuth;
  serverMetaKey: string | null;
  timezone?: () => TimezoneSettings;
}) {
  const { store, auth } = options;
  const serverMetaKey = options.serverMetaKey || null;
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;

  // The provider part of the view, without a version.
  const providerPart = (settings: StoredSettings) => {
    const ctx = { settings, serverMetaKey };
    const key = metaKey(ctx);
    const provider = activeProvider(ctx);
    const models = provider ? modelOptions(settings, provider) : [];
    const model = provider ? currentModel(settings, provider) : "";
    const problem = settings.modelProblem;
    const modelNotice =
      provider && problem && problem.provider === provider && problem.model === model
        ? modelProblemText(problem, models.find((m) => m.id === model)?.label ?? model)
        : null;
    return {
      provider,
      meta: { keySet: key !== null, source: key?.source ?? null },
      chatgpt: ChatGptAuth.view(settings),
      model,
      models,
      modelNotice,
    };
  };

  // The whole view, as GET /api/settings gives it (server/settings.ts):
  // one version for both stores, the sum of the time zone part's and this
  // one's (0010 P32). Each part only grows, so the sum grows on any change.
  const viewOf = (settings: StoredSettings): SettingsView => {
    const tz = timezone();
    return { settingsVersion: settings.version + tz.version, timezone: tz.timezone, timezoneSource: tz.timezoneSource, ...providerPart(settings) };
  };

  const invalid = (err: z.ZodError): ApiResponse => ({
    status: 400,
    body: { error: "invalid_body", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
  });

  // Null when the page read the current settings, else the 409 answer.
  const stale = (current: SettingsView, expectedVersion: number): ApiResponse | null =>
    current.settingsVersion === expectedVersion
      ? null
      : {
          status: 409,
          body: { error: "stale_edit", message: "The settings changed since this page read them. Nothing was changed.", currentVersion: current.settingsVersion, current },
        };

  const ok = (body: unknown): ApiResponse => ({ status: 200, body });

  // A write made only if the settings still have the version the page saw,
  // checked in the same read as the write. A stale page gets 409 and
  // nothing is written. `decide` gives the settings to write, or an answer
  // that writes nothing.
  type Decision = { write: StoredSettings } | { answer: ApiResponse };
  const writeAt = (expectedVersion: number, decide: (settings: StoredSettings, view: SettingsView) => Decision): ApiResponse => {
    let answer: ApiResponse | null = null;
    const after = store.update(
      (settings) => {
        const view = viewOf(settings);
        const conflict = stale(view, expectedVersion);
        if (conflict) {
          answer = conflict;
          return null;
        }
        const decision = decide(settings, view);
        if ("answer" in decision) {
          answer = decision.answer;
          return null;
        }
        return decision.write;
      },
      { bump: true },
    );
    return answer ?? ok(viewOf(after));
  };

  const routes: Record<string, Partial<Record<string, (body: unknown) => Promise<ApiResponse> | ApiResponse>>> = {
    "/api/settings/provider": {
      PUT: (body) => {
        const parsed = ProviderBody.safeParse(body);
        if (!parsed.success) return invalid(parsed.error);
        const { provider, expectedVersion } = parsed.data;
        return writeAt(expectedVersion, (settings, current) => {
          const ready = provider === "meta" ? current.meta.keySet : current.chatgpt.signedIn;
          if (!ready) return { answer: { status: 422, body: { error: "provider_not_ready", message: NOT_READY_TEXT[provider] } } };
          if (settings.provider === provider) return { answer: ok(current) };
          return { write: { ...settings, provider, modelProblem: null } };
        });
      },
    },
    "/api/settings/model": {
      PUT: (body) => {
        const parsed = ModelBody.safeParse(body);
        if (!parsed.success) return invalid(parsed.error);
        const { model, expectedVersion } = parsed.data;
        return writeAt(expectedVersion, (settings, current) => {
          if (!current.provider) return { answer: { status: 422, body: { error: "provider_not_ready", message: NO_PROVIDER_MODEL_TEXT } } };
          // Only a listed model. The lists never hold a contributor model.
          if (!current.models.some((m) => m.id === model)) return { answer: { status: 422, body: { error: "unknown_model", message: UNKNOWN_MODEL_TEXT } } };
          const choice = current.provider === "meta" ? { metaModel: model } : { chatgpt: { ...settings.chatgpt, model } };
          return { write: { ...settings, ...choice, modelProblem: null } };
        });
      },
    },
    "/api/auth/meta-key": {
      POST: (body) => {
        const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
        const version = versionOf(fields);
        if (version === null) return VERSION_REQUIRED;
        const key = fields!.key;
        const extra = Object.keys(fields!).filter((k) => k !== "key" && k !== "expectedVersion");
        // A fixed message: the key itself is never echoed.
        if (typeof key !== "string" || extra.length > 0 || !KEY.test(key.trim())) {
          return { status: 400, body: { error: "invalid_key", message: KEY_FORMAT_TEXT } };
        }
        return writeAt(version, (settings) => ({ write: { ...settings, provider: settings.provider ?? "meta", meta: { key: key.trim() } } }));
      },
      DELETE: (body) => {
        const version = versionOnly(body);
        if (version === null) return VERSION_REQUIRED;
        return writeAt(version, (settings, current) => (settings.meta ? { write: { ...settings, meta: null } } : { answer: ok(current) }));
      },
    },
    "/api/auth/chatgpt/start": {
      POST: async () => {
        try {
          return ok(await auth.start());
        } catch (err) {
          if (err instanceof IdentityError) return { status: 503, body: { error: "sign_in_unavailable", message: SIGN_IN_UNAVAILABLE_TEXT } };
          throw err;
        }
      },
    },
    "/api/auth/chatgpt/signout": {
      POST: async (body) => {
        const version = versionOnly(body);
        if (version === null) return VERSION_REQUIRED;
        // Checked under the sign-out lock, so a tab that has not seen a
        // newer sign-in cannot end it.
        const result = await auth.signOut({ onlyIf: (settings) => viewOf(settings).settingsVersion === version });
        if (result.refused) return stale(viewOf(store.read()), version)!;
        return ok({ ...viewOf(store.read()), notice: result.revoked ? null : SIGNED_OUT_UNCONFIRMED_TEXT });
      },
    },
  };

  return {
    paths: Object.keys(routes),
    view: () => viewOf(store.read()),
    // For server/settings.ts, which serves GET /api/settings and the time
    // zone write.
    source: { version: () => store.read().version, view: () => providerPart(store.read()) },

    // The answer for a settings or sign-in route, or null for any other path.
    async handle(req: AuthRequest): Promise<ApiResponse | null> {
      const route = routes[req.path];
      if (!route) return null;
      const run = route[req.method];
      if (!run) return { status: 405, body: { error: "method_not_allowed" } };
      try {
        return await run(req.body);
      } catch (err) {
        // Another process kept the settings busy: nothing was written, and
        // trying again is safe.
        if (err instanceof SecretsBusyError) return SETTINGS_BUSY;
        if (err instanceof SecretsFileError) {
          // The path and the reason, never the file's contents.
          console.error(err.message);
          return { status: 503, body: { error: "settings_unreadable", message: SETTINGS_UNREADABLE_TEXT } };
        }
        return { status: 500, body: { error: "server_error", message: "The server could not complete the request." } };
      }
    },

    // The loopback callback. Always a redirect to the app's page, with the
    // outcome as a code in the query, never a token or the OAuth code.
    async callback(method: string, query: URLSearchParams): Promise<{ status: number; location: string | null }> {
      if (method !== "GET") return { status: 405, location: null };
      let code: CallbackCode | "server_error" | "settings_busy";
      try {
        const result = await auth.callback(query);
        if (result.ok) return { status: 302, location: "/?signedIn=chatgpt" };
        code = result.code;
      } catch (err) {
        if (err instanceof SecretsFileError) console.error(err.message);
        code = err instanceof IdentityError ? "identity_unavailable" : err instanceof SecretsBusyError ? "settings_busy" : "server_error";
      }
      return { status: 302, location: `/?signInError=${code}` };
    },
  };
}
