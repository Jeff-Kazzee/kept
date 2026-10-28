// The fixed sentences of a hosted mode refusal (0014), shared by the
// server and the page. Runs in the browser and in Node, so it must not
// import Node modules.
export type UsageRefusal = "credits_exhausted" | "daily_cap" | "server_key_off";

// Fixed sentences, written by code. The `reason` part is the first
// sentence alone, for a turn that already changed something.
export const USAGE_TEXT: Record<UsageRefusal, { reason: string; text: string }> = {
  credits_exhausted: {
    reason: "Your usage credit has run out, so the assistant did not run this step. To get more, open Usage from your account menu, where you can enter a judge code. Plans to buy credit are coming soon.",
    text: "Your usage credit has run out, so the assistant did not run this step. To get more, open Usage from your account menu, where you can enter a judge code. Plans to buy credit are coming soon. Nothing in your case changed.",
  },
  daily_cap: {
    reason: "This site reached its daily limit for Meta usage, so the assistant did not run this step. Try again tomorrow. Your credit was not charged.",
    text: "This site reached its daily limit for Meta usage, so the assistant did not run this step. Try again tomorrow. Your credit was not charged. Nothing in your case changed.",
  },
  server_key_off: {
    reason: "Meta usage is paused on this site just now, so the assistant did not run this step. Your credit was not charged.",
    text: "Meta usage is paused on this site just now, so the assistant did not run this step. Your credit was not charged. Nothing in your case changed.",
  },
};

// The text a stopped turn stores in hosted mode: a refusal's whole
// sentence, or, after a tool wrote, the partial sentence and the reason.
export function usageStopText(text: string, partial: string): UsageRefusal | null {
  const t = text.trim();
  for (const [code, v] of Object.entries(USAGE_TEXT) as Array<[UsageRefusal, (typeof USAGE_TEXT)[UsageRefusal]]>) {
    if (t === v.text || t === `${partial} ${v.reason}`) return code;
  }
  return null;
}
