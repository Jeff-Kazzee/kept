// Email and password, and passkeys, through Better Auth at /api/auth/*
// (0020). Its own chunk, loaded with the sign-in screen or when a person
// adds a passkey, so the WebAuthn library stays out of the first load
// (0019, P18; sprint 19 round 2).
import { WebAuthnError, startAuthentication, startRegistration } from "@simplewebauthn/browser";

// A Better Auth route: JSON, no app header. Its errors come as
// { code, message } and become an AuthError with the page's own sentence.
export class AuthError extends Error {
  override name = "AuthError";
}

// Better Auth's codes, in the page's words. Anything else gets the
// general sentence, never the server's own text.
const AUTH_ERRORS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password do not match an account. Check them and try again.",
  // Fix round 1, item 6: never more than that the email cannot be used.
  EMAIL_UNAVAILABLE: "That email cannot be used here. Try another, or sign in if it is yours.",
  USER_ALREADY_EXISTS: "That email cannot be used here. Try another, or sign in if it is yours.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "That email cannot be used here. Try another, or sign in if it is yours.",
  PASSWORD_TOO_SHORT: "Use a password of at least 10 characters.",
  PASSWORD_TOO_LONG: "Use a password of at most 128 characters.",
  INVALID_EMAIL: "Enter a full email address, such as name@example.com.",
  INVALID_ORIGIN: "Open this site at its own address, then try again.",
  PASSKEY_NOT_FOUND: "This site does not know that passkey. Sign in with your email and password, then add a passkey from the account menu.",
  SESSION_EXPIRED: "For safety, sign in again before you add a passkey.",
};

export function authErrorText(status: number, body: { code?: unknown; message?: unknown; error?: unknown } | null): string {
  if (body?.error === "signup_closed" && typeof body.message === "string") return body.message;
  if (status === 429) return typeof body?.message === "string" && body.error === "rate_limited" ? body.message : "Too many tries from here. Wait a minute and try again.";
  const code = typeof body?.code === "string" ? body.code : "";
  if (AUTH_ERRORS[code]) return AUTH_ERRORS[code]!;
  if (status === 413) return "That was too long. Check the fields and try again.";
  if (status === 400 && code === "") return "Check the email and password, then try again.";
  return "Signing in did not work just now. Try again in a moment.";
}

async function authCall<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/auth${path}`, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AuthError("The site did not answer. Check your connection and try again.");
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON. The status says enough.
  }
  if (!res.ok) throw new AuthError(authErrorText(res.status, json as never));
  return json as T;
}

// The browser's passkey prompt, in the page's words.
function passkeyFailure(e: unknown, adding: boolean): AuthError {
  if (e instanceof AuthError) return e;
  const names = new Set<string>();
  if (e instanceof WebAuthnError) names.add(e.code);
  if (e instanceof Error) {
    names.add(e.name);
    if (e.cause instanceof Error) names.add(e.cause.name);
  }
  const any = (...n: string[]) => n.some((x) => names.has(x));
  if (any("NotAllowedError", "AbortError", "ERROR_CEREMONY_ABORTED")) return new AuthError("The passkey prompt was closed. Nothing changed.");
  if (any("InvalidStateError", "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED")) return new AuthError("This device already has a passkey for this account.");
  if (typeof window !== "undefined" && !("PublicKeyCredential" in window)) return new AuthError("This browser cannot use passkeys. Use your email and password.");
  return new AuthError(adding ? "The passkey was not added. Try again." : "That passkey did not sign you in. Try again, or use your email and password.");
}

export const accountAuth = {
  signUp: (email: string, password: string, name: string) => authCall<unknown>("POST", "/sign-up/email", { email, password, name }),
  signIn: (email: string, password: string) => authCall<unknown>("POST", "/sign-in/email", { email, password }),
  async passkeySignIn(): Promise<void> {
    try {
      const optionsJSON = await authCall<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("GET", "/passkey/generate-authenticate-options");
      const response = await startAuthentication({ optionsJSON });
      await authCall("POST", "/passkey/verify-authentication", { response });
    } catch (e) {
      throw passkeyFailure(e, false);
    }
  },
  async addPasskey(): Promise<void> {
    try {
      const optionsJSON = await authCall<Parameters<typeof startRegistration>[0]["optionsJSON"]>("GET", "/passkey/generate-register-options");
      const response = await startRegistration({ optionsJSON });
      await authCall("POST", "/passkey/verify-registration", { response, name: "Passkey" });
    } catch (e) {
      throw passkeyFailure(e, true);
    }
  },
};

