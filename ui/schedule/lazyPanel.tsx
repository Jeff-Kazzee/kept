// 0019, P18: the schedule panel is its own chunk. It starts loading with
// the page, in parallel with the first reads, so the chat, which holds the
// first paint, never waits for it. On a phone it starts closed.
import { onDemand } from "../components/onDemand.tsx";

const panel = onDemand(() => import("./SchedulePanel.tsx"));
export const loadPanel = panel.ensure;
export const SchedulePanel = panel.part((m) => m.SchedulePanel, "SchedulePanel", <div className="panel-loading" aria-busy="true" />);
