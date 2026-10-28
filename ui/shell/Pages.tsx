// A sidebar page in the work area (0015, S5), with the way back to the
// case, and the Agent access page (Z1): what an agent connected over MCP
// can do, where its actions show, and how to connect one.
import type { ReactNode } from "react";
import { useAgent } from "../agent/AgentContext.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { Icon } from "../components/Icon.tsx";

export function PageFrame({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <div className="page-inner">
      <div>
        <button type="button" className="btn btn-ghost btn-sm page-back" onClick={onBack}>
          <Icon name="chevronLeft" size="sm" /> Back to your case
        </button>
      </div>
      {children}
    </div>
  );
}

const CAN = [
  "Read the schedule, the checklist and the activity",
  "Import an office message and accept or reject its facts",
  "Explain a clash, ask and answer its question, and start a reply draft",
  "Add notes and tags, archive an appointment, and undo",
  "Set the time zone, and use Gmail and Google Calendar when you connected them",
];

const CANNOT = ["Approve or send a reply, or edit its text", "Enter a fact by hand", "Delete the case"];

const COMMAND = "claude mcp add appointments -e APP_DB=/path/to/meta-hackathon-appointments/data/app.sqlite -- /path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh";

export function AgentAccessPage({ onActivity }: { onActivity: () => void }) {
  const { activity } = useAgent();
  const theirs = activity?.entries.filter((e) => e.actor === "mcp") ?? null;
  return (
    <div className="stack settings">
      <section className="card stack-sm" aria-labelledby="access-what">
        <h2 id="access-what">An agent you already use</h2>
        <p className="small">
          An agent such as Claude Code, Grok Build or OpenCode can work on this case over MCP, with the same tools and rules as the assistant. The MCP server runs on this computer, opens no
          port and needs no token.
        </p>
        <div className="access-lists">
          <div className="stack-xs">
            <h3 className="field-label">It can</h3>
            <ul className="grants">
              {CAN.map((x) => (
                <li key={x} className="is-on">
                  <Icon name="check" size="sm" />
                  <span>{x}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="stack-xs">
            <h3 className="field-label">It cannot</h3>
            <ul className="grants">
              {CANNOT.map((x) => (
                <li key={x} className="is-off">
                  <Icon name="close" size="sm" />
                  <span>{x}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
      <section className="card stack-sm" aria-labelledby="access-did">
        <h2 id="access-did">What it did</h2>
        <p className="small">
          {theirs === null
            ? "The activity could not be read just now."
            : theirs.length === 0
              ? "No agent has acted on this case over MCP yet."
              : `${theirs.length} action${theirs.length === 1 ? "" : "s"} by an external agent in this case.`}{" "}
          Each one is in Activity as an external agent, with Undo.
        </p>
        <div>
          <button type="button" className="btn btn-sm" onClick={onActivity}>
            <Icon name="activity" size="sm" /> Open Activity
          </button>
        </div>
      </section>
      <section className="card stack-sm" aria-labelledby="access-how">
        <h2 id="access-how">Connect one</h2>
        <p className="small">
          In Claude Code, run this on the computer that runs the app, with your own folder in place of <code>/path/to</code>:
        </p>
        <pre className="command">
          <code>{COMMAND}</code>
        </pre>
        <div>
          <CopyButton text={COMMAND} label="Copy the command" />
        </div>
        <p className="small muted">
          <code>docs/connect-agent.md</code> has the commands for Grok Build and OpenCode, and how to start the agent with only these tools, because an agent with a shell or file tools can
          change the app's files.
        </p>
      </section>
    </div>
  );
}
