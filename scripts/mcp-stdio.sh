#!/bin/sh
# Starts the appointment case MCP server over stdio, for an MCP client that
# runs it as a local command, directly or through ssh:
#
#   APP_DB=/path/to/app.sqlite /path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh
#
# APP_DB selects the event log, as for the app (default data/app.sqlite in
# the package). There is no token: whoever can run this script can already
# read that file. APPT_NODE selects the Node 24 binary when `node` on the
# PATH is another version. stdout carries only MCP messages, so this script
# prints nothing.
set -eu
cd -P "$(dirname "$0")/.."
exec "${APPT_NODE:-node}" mcp/main.ts
