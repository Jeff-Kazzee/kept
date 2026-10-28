// Offline fakes of OpenAI's sign-in and Responses endpoints and of the Meta
// Responses endpoint, for the provider tests (0010). Nothing here reaches
// the network: the fake is passed as `fetch`, or stubbed over the global
// one that test/setup.ts blocks. Keys are made at test time.
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatGptAuth } from "../src/model/providers/chatgpt-auth.ts";
import { DISCOVERY_URL, OPENAI_ISSUER } from "../src/model/providers/oidc.ts";
import { SecretsStore } from "../src/model/providers/secrets.ts";

export const AUTHORIZE_URL = `${OPENAI_ISSUER}/api/accounts/authorize`;
export const TOKEN_URL = `${OPENAI_ISSUER}/api/accounts/oauth/token`;
export const JWKS_URL = `${OPENAI_ISSUER}/.well-known/jwks.json`;
export const REVOKE_URL = `${OPENAI_ISSUER}/oauth/revoke`;
export const MODELS = "https://api.openai.com/v1/models";
export const RESPONSES = "https://api.openai.com/v1/responses";
export const META_URL = "https://api.meta.ai/v1/responses";
export const ISSUED_CLIENT = "oaiapp_test_client";
export const PORT = 5190;

// Values that must never leave the server. Each is unique per run.
export const fakeSecret = (name: string) => `${name}-${randomBytes(12).toString("hex")}`;

export type Recorded = { url: string; method: string; headers: Record<string, string>; body: string };

export function signingKey(kid = "key-1") {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, publicKey, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

export function jwt(payload: Record<string, unknown>, key: { kid: string; privateKey: KeyObject }, header: Record<string, unknown> = {}): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = sign("sha256", Buffer.from(`${h}.${p}`), key.privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}

export function sse(events: Array<{ event: string; data: unknown }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

export const completed = (output: unknown[], usage = { input_tokens: 10, output_tokens: 5 }) =>
  sse([
    { event: "response.created", data: { type: "response.created" } },
    { event: "response.completed", data: { type: "response.completed", response: { output, usage } } },
  ]);

export const message = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

type Handler = (req: Recorded) => Response | Promise<Response>;

export class FakeOpenAi {
  key = signingKey();
  jwksCacheControl: string | null = null;
  readonly requests: Recorded[] = [];
  now = Date.parse("2026-11-05T17:00:00.000Z");
  // The next authorization's nonce, read from the authorize URL by tests.
  nonce = "";
  subject = "user-sub-1";
  email: string | null = "dana@example.test";
  name: string | null = "Dana";
  scope = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";
  accessToken = fakeSecret("access");
  refreshToken = fakeSecret("refresh");
  idTokens: string[] = [];
  token: Handler | null = null;
  responses: Handler = () => new Response(completed([message("ok")]), { headers: { "content-type": "text/event-stream" } });
  meta: Handler = (req) =>
    JSON.parse(req.body).stream
      ? new Response(completed([message("meta ok")]), { headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify({ output: [message("meta ok")], usage: { input_tokens: 1, output_tokens: 1 } }));
  revoke: Handler = () => new Response(null, { status: 200 });
  models: Handler = () =>
    Response.json({
      models: [
        { slug: "gpt-6.1-terra", display_name: "GPT-6.1 Terra", visibility: "list" },
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
        { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" },
      ],
    });
  discovery = (): Record<string, unknown> => ({
    issuer: OPENAI_ISSUER,
    authorization_endpoint: AUTHORIZE_URL,
    token_endpoint: TOKEN_URL,
    jwks_uri: JWKS_URL,
    revocation_endpoint: REVOKE_URL,
  });

  idToken(overrides: Record<string, unknown> = {}, clientId = ISSUED_CLIENT): string {
    const t = Math.floor(this.now / 1000);
    const token = jwt(
      { iss: OPENAI_ISSUER, aud: clientId, sub: this.subject, email: this.email, name: this.name, nonce: this.nonce, iat: t, exp: t + 3600, ...overrides },
      this.key,
    );
    this.idTokens.push(token);
    return token;
  }

  tokenResponse(extra: Record<string, unknown> = {}): Response {
    return Response.json({
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      id_token: this.idToken(),
      token_type: "Bearer",
      expires_in: 3600,
      scope: this.scope,
      ...extra,
    });
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const req: Recorded = { url: String(input), method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : "" };
    this.requests.push(req);
    const url = req.url;
    if (url === DISCOVERY_URL) return Response.json(this.discovery());
    if (url === JWKS_URL) return Response.json({ keys: [this.key.jwk] }, this.jwksCacheControl ? { headers: { "cache-control": this.jwksCacheControl } } : {});
    if (url === TOKEN_URL) return this.token ? this.token(req) : this.tokenResponse();
    if (url === REVOKE_URL) return this.revoke(req);
    if (url === MODELS) return this.models(req);
    if (url === RESPONSES) return this.responses(req);
    if (url === META_URL) return this.meta(req);
    throw new Error(`The fake has no route for ${url}.`);
  };

  form(req: Recorded): URLSearchParams {
    return new URLSearchParams(req.body);
  }

  to(url: string): Recorded[] {
    return this.requests.filter((r) => r.url === url);
  }
}

export function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "providers-"));
  const store = new SecretsStore(path.join(dir, "app-secrets.sqlite"));
  return {
    dir,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A signed-in connection, through the real start and callback.
export async function signIn(fake: FakeOpenAi, store: SecretsStore, auth = new ChatGptAuth({ store, port: PORT, fetch: fake.fetch, now: () => fake.now })) {
  const { authorizeUrl } = await auth.start();
  const url = new URL(authorizeUrl);
  fake.nonce = url.searchParams.get("nonce")!;
  const query = new URLSearchParams({ code: "auth-code", state: url.searchParams.get("state")!, scope: fake.scope });
  if (url.searchParams.get("client_id") === "dynamic_agent_client") query.set("client_id", ISSUED_CLIENT);
  const result = await auth.callback(query);
  return { auth, url, result };
}
