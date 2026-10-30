// The sidebar's pages: Connections, Agent access, Settings and Usage. They
// are not on the case screen, so the shell loads this module only when one
// opens, or when the browser is idle after the first load (0019, P18).
import type { AppState } from "../api.ts";
import type { Run } from "../components/ActionButton.tsx";
import { ConnectionsPage, SettingsPage, UsagePage } from "../pages/Settings.tsx";
import { AgentAccessPage, PageFrame } from "./Pages.tsx";
import type { View } from "./shell.ts";

export default function PageView({
  view,
  state,
  run,
  onBack,
  onActivity,
  caseDeleted,
  onCaseDeleted,
}: {
  view: Exclude<View, "case">;
  state: AppState;
  run: Run;
  onBack: () => void;
  onActivity: () => void;
  caseDeleted: boolean;
  onCaseDeleted: () => void;
}) {
  return (
    <PageFrame onBack={onBack}>
      {view === "connections" && <ConnectionsPage modelClient={state.modelClient} run={run} />}
      {view === "access" && <AgentAccessPage onActivity={onActivity} />}
      {view === "settings" && <SettingsPage version={state.caseVersion} erasePending={state.erasePending} run={run} caseDeleted={caseDeleted} onCaseDeleted={onCaseDeleted} />}
      {view === "usage" && <UsagePage run={run} />}
    </PageFrame>
  );
}
