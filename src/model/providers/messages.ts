// Fixed sentences for provider problems (0010, design item 4). Code writes
// them, never a model, and none holds a key, a token or response text. A
// provider failure becomes a ModelCallError whose message and userText are
// one of these, so the chat shows it and extraction records it as is.
import { ModelCallError } from "../client.ts";

export const NO_PROVIDER_TEXT =
  "No model is set up yet. Add your Meta Model API key in settings, or sign in with ChatGPT. Nothing in your case changed.";
export const META_KEY_MISSING_TEXT =
  "Meta is selected, but no Meta Model API key is set. Add your key in settings, or switch to ChatGPT. Nothing in your case changed.";
export const CHATGPT_SIGNED_OUT_TEXT =
  "ChatGPT is selected, but you are not signed in. Sign in with ChatGPT again in settings, or switch to Meta. Nothing in your case changed.";
export const CHATGPT_SESSION_ENDED_TEXT =
  "Your ChatGPT sign-in ended, so you are signed out. Sign in with ChatGPT again in settings, or switch to Meta. Nothing in your case changed.";
export const CHATGPT_NOT_ACCEPTED_TEXT =
  "ChatGPT did not accept this app's sign-in. Sign in with ChatGPT again in settings, or switch to Meta. Nothing in your case changed.";
export const PLAN_USAGE_OFF_TEXT =
  "You are signed in with ChatGPT, but this app may not use your ChatGPT plan. Sign in with ChatGPT again and allow plan usage, or switch to Meta in settings. Nothing in your case changed.";
export const USAGE_LIMIT_TEXT =
  "This app reached its usage limit on your ChatGPT plan. See ChatGPT settings, Usage (https://chatgpt.com/settings/usage), or switch to Meta in settings. Nothing in your case changed.";
export const NOT_ELIGIBLE_TEXT =
  "ChatGPT plan usage is not available for this account or workspace. Switch to Meta in settings. Nothing in your case changed.";
export const CHATGPT_UNAVAILABLE_TEXT = "ChatGPT could not answer just now. Nothing in your case changed. Try again in a moment.";
export const CHATGPT_REQUEST_REFUSED_TEXT =
  "ChatGPT refused this request from the app. Switch to Meta in settings, or try again later. Nothing in your case changed.";

export const SETTINGS_FILE_TEXT =
  "The app could not read its settings file, so no model was called. The app's terminal says why. Nothing in your case changed.";

export function providerError(
  text: string,
  options: { status?: number | null; latencyMs?: number; type?: string | null; code?: string | null; param?: string | null } = {},
): ModelCallError {
  return new ModelCallError(text, options.status ?? null, options.latencyMs ?? 0, { type: options.type ?? null, code: options.code ?? null, param: options.param ?? null }, text);
}

// The sentence for a ChatGPT Responses failure, by the documented error
// code first and the HTTP status second (errors-and-recovery).
export function chatGptFailureText(status: number | null, code: string | null): string {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return USAGE_LIMIT_TEXT;
    case "subscription_sharing_user_not_eligible":
      return NOT_ELIGIBLE_TEXT;
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return CHATGPT_UNAVAILABLE_TEXT;
    case "subscription_sharing_invalid_user":
      return CHATGPT_NOT_ACCEPTED_TEXT;
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
    case "subscription_sharing_unsupported_capability":
    case "subscription_sharing_route_not_supported":
      return CHATGPT_REQUEST_REFUSED_TEXT;
  }
  if (status === 401) return CHATGPT_NOT_ACCEPTED_TEXT;
  if (status === 403) return CHATGPT_REQUEST_REFUSED_TEXT;
  return CHATGPT_UNAVAILABLE_TEXT;
}
