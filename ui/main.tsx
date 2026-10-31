import { StrictMode, startTransition } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { api, type BootData } from "./api.ts";
import { Root } from "./App.tsx";
import { DEFAULT_SETTINGS, type Settings } from "./contract.ts";
import { setCaseZone } from "./format.ts";
import { setRenderedView } from "./layout.ts";
import { caseNeedsCards, loadCaseCards } from "./case/lazyCards.tsx";
import { loadPanel } from "./schedule/lazyPanel.tsx";
import "./styles.css";
import { applyTheme, readTheme } from "./theme.ts";

applyTheme(readTheme());
// "System" follows the device when it changes.
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (readTheme() === "system") applyTheme("system");
});

// 0019, P30: a page the server rendered carries its boot data as a JSON
// block (data, not code). The page hydrates what the server rendered from
// it. Otherwise it renders on its own, as before.
const root = document.getElementById("root")!;
const inline = document.getElementById("boot");
let boot: BootData | null = null;
try {
  boot = inline?.textContent && root.firstElementChild ? (JSON.parse(inline.textContent) as BootData) : null;
} catch {
  boot = null;
}
if (boot) {
  const initial = boot;
  api.adoptBoot(initial);
  setCaseZone((initial.settings as Settings | null)?.timezone ?? DEFAULT_SETTINGS.timezone);
  setRenderedView(initial.view);
  // The parts the server rendered hydrate with their code in place, so an
  // update before their chunk arrived never replaces what the server drew.
  // The page is on screen meanwhile. Not a top-level await: those chunks
  // import this module's chunk, which must finish first.
  // Only the chunks the rendered screen uses: the cards when the case shows
  // one, the panel when the server drew a laptop. An empty case on a phone
  // waits for neither (0019, round 3).
  void Promise.all([caseNeedsCards(initial.state) ? loadCaseCards() : null, initial.view === "phone" ? null : loadPanel()])
    .catch(() => {})
    .then(() =>
      // 0019, round 3: a transition, so React hydrates in slices and no
      // single task holds the page.
      startTransition(() => {
        hydrateRoot(
          root,
          <StrictMode>
            <Root initial={{ session: { mode: "local" }, boot: initial }} />
          </StrictMode>,
        );
      }),
    );
} else {
  createRoot(root).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
