// 0019, P30: the server renders the case screen to HTML for the current
// case, so the page shows it before any script runs, and the page then
// hydrates it. Built by `pnpm build` into dist/ssr (vite build --ssr) and
// used by server/static.ts in local mode only. It renders from the same
// boot data the page receives, so both renders match. The on-demand parts
// the screen shows are loaded first, so nothing waits during the render:
// the HTML holds the cards and the panel, and React writes no inline
// script, which the CSP would refuse.
import { renderToString } from "react-dom/server";
import type { BootData } from "./api.ts";
import { Root } from "./App.tsx";
import { loadCaseCards } from "./case/lazyCards.tsx";
import { DEFAULT_SETTINGS, type Settings } from "./contract.ts";
import { setCaseZone } from "./format.ts";
import { loadPanel } from "./schedule/lazyPanel.tsx";

export async function renderCase(boot: BootData): Promise<string> {
  await Promise.all([loadCaseCards(), loadPanel()]);
  setCaseZone((boot.settings as Settings | null)?.timezone ?? DEFAULT_SETTINGS.timezone);
  return renderToString(<Root initial={{ session: { mode: "local" }, boot }} />);
}
