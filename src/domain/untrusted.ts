// The label for text the app shows as data, never as instructions: words an
// agent wrote, such as a place or an item it reported. Built here so every view, now and in later UIs, uses the same
// words. Runs in the browser and in Node, so it must not import Node modules.
export const UNTRUSTED_SUFFIX = "Untrusted text, shown as data.";

export const untrustedLabel = (what: string) => `${what}. ${UNTRUSTED_SUFFIX}`;

// "Words from the assistant. Untrusted text, shown as data."
export const agentWordsLabel = (agentName: string | null | undefined) => untrustedLabel(`Words from ${agentName ?? "an agent"}`);
