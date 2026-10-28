# Connect an agent over MCP

The MCP server gives an agent you already use the same tools as the
app's assistant, with the same rules (`docs/decisions/0009-agent-first.md`).
It runs over stdio on the host that runs the app, opens no port and needs
no token: whoever can start it can already open the app's database file.
Every action it takes is in the app's activity log as "an external
agent", and you can undo it there. It cannot approve or send a reply,
edit a reply's text, enter a fact by hand or delete the case.

`scripts/mcp-stdio.sh` starts the server. `APP_DB` names the app's
database, the same file the app uses (`data/app.sqlite` in the app's
folder by default). In the commands below, use your own folder for
`/path/to/meta-hackathon-appointments`. From another machine, put
`ssh <host>` in front of the command, with key login so it runs with no
prompt.

Grok Build:

```sh
grok mcp add appointments --scope project -e APP_DB=/path/to/meta-hackathon-appointments/data/app.sqlite -- /path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh
```

OpenCode, in `opencode.json` in a working folder outside the repository:

```json
{ "mcp": { "appointments": { "type": "local", "command": ["/path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh"], "environment": { "APP_DB": "/path/to/meta-hackathon-appointments/data/app.sqlite" } } } }
```

Claude Code:

```sh
claude mcp add appointments -e APP_DB=/path/to/meta-hackathon-appointments/data/app.sqlite -- /path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh
```

The server uses recorded model responses for extraction, explanations and
questions unless `APP_LIVE_MODEL=1` and `MODEL_API_KEY` are set for it, as
for the app. `APPT_NODE` selects the Node 24 binary when `node` on the
PATH is another version. Ask the agent to list the appointments tools: it
should name the same tools as the app's assistant, from `get_schedule` to
`set_timezone`.

## Run the agent with only the tools it needs

An agent that runs as your OS user with a shell, file or web tools can read
and change the app's files, its database included, and the MCP server's
rules do not limit those tools. Give the agent the appointments server and
nothing else: in Grok Build remove the built-in tools with
`--disallowed-tools` and `--deny`, in OpenCode turn off `bash`, `edit`,
`write`, `read` and `webfetch` under `tools`, and in Claude Code start it
with `--tools "" --allowedTools "mcp__appointments__*"`.
Its model provider may receive the case data the agent reads.
