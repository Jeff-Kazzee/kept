// Copies text to the clipboard and says so for a moment. Where the browser
// refuses, it says to select the text instead.
import { useEffect, useState } from "react";
import { Icon } from "./Icon.tsx";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className="link-btn link-quiet"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      <Icon name={state === "copied" ? "check" : "copy"} size="sm" />
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Select the text to copy it" : label}</span>
    </button>
  );
}
