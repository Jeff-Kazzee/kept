# Connect an agent over MCP

This guide connects an MCP client to your appointment records and runs the
connect test. The MCP server runs on the host that runs the app, over
stdio. A client on another machine starts it through `ssh`. No port is
opened, and the token never appears on a command line.

In the examples:

- `linveo-16gb` is an example SSH host name. Use your own.
- `/path/to/meta-hackathon-appointments` is the app's folder on that host.
  Use the folder whose app you open, because the server reads that app's
  database (`data/app.sqlite`, or `APP_DB` if you set it for the app).

The client's own model and its API key are your choice, set in the client.
That model's provider may receive the case data the agent reads:
appointment times, places, notes and quotes from your messages. Grant only
what you are comfortable sharing with it.

## 1. Create a grant and its token file

On the app's host, in the app's folder. Pick a name you will recognize and
the lowest tier that does the job. The demo beat needs `annotate`. The
optional proposal step needs `propose`.

```sh
cd /path/to/meta-hackathon-appointments
pnpm grant create --name "Laptop agent" --tier annotate --token-file ~/.config/appointments/grant-token
```

It prints the grant id and the path. It does not print the token. The file
is readable by you only (mode 600), and the command refuses to overwrite an
existing file. That path is the launcher's default. For a second grant, use
a second path and set `APPT_GRANT_TOKEN_FILE` to it (see below).

You can also create the grant in the app, in "Agent access (MCP)". The app
shows the token once. Save it to a file with mode 600 yourself, for example
with `install -m 600 /dev/null <path>` and then an editor. Do not paste it
into a chat, a screenshot or a file in the repository.

## 2. Check the launcher

From the machine that runs the client:

```sh
ssh -o BatchMode=yes linveo-16gb /path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh < /dev/null; echo "exit $?"
```

It prints nothing and `exit 0` when the token file is in place. This does
not check that the token matches a grant. Step 4 does: a token with no
active grant sees no tools. Anything on the screen is a problem to fix
first:

| Message | Fix |
|---|---|
| `Could not open the token file ...` | Create it with step 1, or set `APPT_GRANT_TOKEN_FILE`. |
| `... can be read by other users. Run chmod 600 ...` | `chmod 600` the file. |
| `Set APPT_GRANT_TOKEN or APPT_GRANT_TOKEN_FILE, not both.` | Remove `APPT_GRANT_TOKEN` from the client's config. |
| `node: not found`, or a syntax error | Node 24 is not first on the non-interactive PATH. Run it as `ssh linveo-16gb env APPT_NODE=/path/to/node24 /path/to/.../scripts/mcp-stdio.sh`. |
| A password or host key prompt | Set up key login for `ssh`, so it runs with no prompt. |

To use a token file at another path on the host, put it in the command:
`ssh linveo-16gb env APPT_GRANT_TOKEN_FILE=/other/path /path/to/.../scripts/mcp-stdio.sh`.
A path is not a secret. The token stays in the file.

## 3. Add the server to your client

Use a working folder outside this repository for project config, so the
client's config is never committed.

### Grok Build (first choice)

On the same machine as the app:

```sh
mkdir -p ~/agent-work && cd ~/agent-work
grok mcp add appointments --scope project -e APPT_GRANT_TOKEN_FILE=$HOME/.config/appointments/grant-token -- /path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh
grok mcp list
grok mcp doctor
```

From another machine, run the server through `ssh`. The token file path is
the default on the host, so no variable is passed:

```sh
mkdir -p ~/agent-work && cd ~/agent-work
grok mcp add appointments --scope project -- ssh linveo-16gb /path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh
grok mcp list
grok mcp doctor
```

Pass only the token file path, never the token.

### OpenCode

Put this in `opencode.json` in your working folder outside the repository,
or in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "appointments": {
      "type": "local",
      "command": ["ssh", "linveo-16gb", "/path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh"],
      "enabled": true
    }
  }
}
```

On the app's own host, use
`"command": ["/path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh"]`
instead. Run `opencode mcp list` to see the server.

### Claude Code (fallback)

```sh
claude mcp add appointments --scope user -- ssh linveo-16gb /path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh
claude mcp list
```

In a session, `/mcp` shows the server and its tools.

## 4. The connect test

Open the app in a browser on the host, so you can watch the changes arrive.
It refreshes within about 2 seconds of each agent call.

1. List the tools. Ask the agent: "List the tools of the appointments MCP
   server." With an `annotate` grant the answer is `list_appointments`,
   `get_appointment`, `list_open_questions`, `add_note` and `set_tags`.
   `propose` adds `propose_change`. No tool manages grants, deletes the
   case, sends a reply or confirms a proposal.
2. Call `get_appointment` once. Ask: "Call get_appointment for
   appointment 2026-11-16T13:00 and show the state." The app's case history
   shows "Agent call by Laptop agent: get_appointment · ok".
3. The demo beat. With the demo case at the approved Monday reply:
   - "Am I booked for Monday?" The agent should answer that Monday 11/16
     1:00 PM is requested and waiting for the office to confirm. The tool
     result says `state: requested` and "You asked the office for this
     time. The office has not confirmed it yet."
   - "Add a note to Monday to bring my parking pass." The note shows on
     Monday in the open app, labeled with the grant name, without a
     reload. Thursday still shows "Confirmed · office message, change
     proposed".
4. Optional, with a `propose` grant: "The office confirmed Monday by phone.
   Propose that change." The proposal waits in the app's review queue,
   labeled "Proposed by <grant name>". Nothing changes until you confirm
   it in the app.

### Headless form for Grok Build

Run these from `~/agent-work`, one at a time:

```sh
grok -p "List the tools of the appointments MCP server. Answer with their names only." -m grok-4.7 --reasoning-effort high --output-format json --cwd ~/agent-work
grok -p "Call get_appointment on the appointments MCP server for appointment_id 2026-11-16T13:00 and report its state and state_meaning." -m grok-4.7 --reasoning-effort high --output-format json --cwd ~/agent-work
grok -p "Using the appointments MCP server: am I booked for Monday 11/16?" -m grok-4.7 --reasoning-effort high --output-format json --cwd ~/agent-work
grok -p "Using the appointments MCP server, add the note 'Bring parking pass' to appointment 2026-11-16T13:00. Read it first and pass its version as expected_version." -m grok-4.7 --reasoning-effort high --output-format json --cwd ~/agent-work
```

## 5. When you are done

Revoke the grant in the app ("Agent access (MCP)", then Revoke), or with
`pnpm grant list` and `pnpm grant revoke <id>`. The agent's next call
fails with `permission_denied`, even if the client is still running.
Remove the token file with `rm ~/.config/appointments/grant-token`.
