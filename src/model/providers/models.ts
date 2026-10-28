// The model choice, per provider (0010). One choice drives every call on
// that provider: the chat agent, extraction, explanations, questions and
// templates. A model that fails a capability the app needs is named in
// settings and the call fails. No call moves to another model by itself.
import { assertAllowedModel, type ModelCallError } from "../client.ts";
import type { ModelProblem, ProviderKind, StoredSettings } from "./secrets.ts";

export type ModelOption = { id: string; label: string; costHint: "lower" | "higher" | null };

// Meta's Muse models. No model listing for the Meta Model API was
// available to check, so this fixed list is used. A contributor model is
// never listed and never accepted.
export const META_MODELS: readonly ModelOption[] = [
  { id: "muse-spark-1.3", label: "Muse Spark 1.3", costHint: "lower" },
  { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", costHint: "higher" },
];
export const DEFAULT_META_MODEL = "muse-spark-1.3";

// The code default for the ChatGPT model: the model the guide's examples
// use. The connection's own listing wins when it does not list this one.
export const DEFAULT_CHATGPT_MODEL = "gpt-6.1-sol";

const allowed = (id: string) => {
  try {
    assertAllowedModel(id);
    return true;
  } catch {
    return false;
  }
};

// The connection's listed models with any contributor model removed. The
// one list both the picker and the call's model come from.
function listedChatGptModels(settings: StoredSettings): ModelOption[] {
  return settings.chatgpt.models.filter((m) => allowed(m.slug)).map((m) => ({ id: m.slug, label: m.displayName, costHint: null }));
}

// The models the user may pick for a provider.
export function modelOptions(settings: StoredSettings, provider: ProviderKind): ModelOption[] {
  if (provider === "meta") return META_MODELS.filter((m) => allowed(m.id));
  const listed = listedChatGptModels(settings);
  return listed.length > 0 ? listed : [{ id: DEFAULT_CHATGPT_MODEL, label: DEFAULT_CHATGPT_MODEL, costHint: null }];
}

export function metaModel(settings: StoredSettings): string {
  const choice = settings.metaModel;
  return choice !== null && META_MODELS.some((m) => m.id === choice) ? choice : DEFAULT_META_MODEL;
}

// The model for ChatGPT calls: the user's choice if the connection lists
// it, else the code default if listed, else the first listed model. With no
// listing, the user's choice or the code default.
// A contributor model is never returned, listed or chosen.
export function chatGptModel(settings: StoredSettings): string {
  const { model } = settings.chatgpt;
  const models = listedChatGptModels(settings);
  if (models.length === 0) return model !== null && allowed(model) ? model : DEFAULT_CHATGPT_MODEL;
  const listed = (id: string | null) => id !== null && models.some((m) => m.id === id);
  if (listed(model)) return model!;
  if (listed(DEFAULT_CHATGPT_MODEL)) return DEFAULT_CHATGPT_MODEL;
  return models[0]!.id;
}

export function currentModel(settings: StoredSettings, provider: ProviderKind): string {
  return provider === "meta" ? metaModel(settings) : chatGptModel(settings);
}

const CAPABILITY_TEXT: Record<ModelProblem["capability"], string> = {
  tool_calling: "tool calling",
  structured_output: "structured output",
  streaming: "streaming",
  other: "a request feature",
};

export function modelProblemText(problem: ModelProblem, label: string): string {
  return `The model ${label} does not support ${CAPABILITY_TEXT[problem.capability]}, which this app needs. Choose another model in settings. Nothing in your case changed.`;
}

// Error codes that say a request feature is not supported. ChatGPT's code
// is documented (errors-and-recovery). The others are the Responses API's
// usual codes for an unsupported parameter, assumed for Meta's API.
const UNSUPPORTED_CODES = new Set(["subscription_sharing_unsupported_capability", "unsupported_parameter", "unsupported_value", "unsupported_model_feature"]);

// The capability a failed call shows the model lacks, or null. `param` is
// the error's param when the client read it. Without one, the request
// decides: a tool turn needs tool calling, a JSON call structured output.
export function capabilityProblem(err: ModelCallError, request: { tools: boolean; json: boolean }): ModelProblem["capability"] | null {
  if (err.status !== 400 || err.errorCode === null || !UNSUPPORTED_CODES.has(err.errorCode)) return null;
  const param = err.errorParam ?? "";
  if (/^(tools|tool_choice|parallel_tool_calls)/.test(param)) return "tool_calling";
  if (/^text/.test(param)) return "structured_output";
  if (/^stream/.test(param)) return "streaming";
  if (param === "") return request.tools ? "tool_calling" : request.json ? "structured_output" : "other";
  return "other";
}
