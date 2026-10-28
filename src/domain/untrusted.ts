// The label for text the app shows as data, never as instructions: words an
// agent wrote, such as a proposal statement, a place or an item it
// reported. Built here so every view, now and in later UIs, uses the same
// words. Runs in the browser and in Node, so it must not import Node modules.
export const UNTRUSTED_SUFFIX = "Untrusted text, shown as data.";

export const untrustedLabel = (what: string) => `${what}. ${UNTRUSTED_SUFFIX}`;

// "Words from Phone helper. Untrusted text, shown as data."
export const agentWordsLabel = (grantName: string | null | undefined) => untrustedLabel(`Words from ${grantName ?? "an agent"}`);
