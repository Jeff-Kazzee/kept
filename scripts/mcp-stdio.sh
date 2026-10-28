#!/bin/sh
# Starts the appointment records MCP server over stdio, for an MCP client
# that runs it as a local command, directly or through ssh:
#
#   ssh <host> /path/to/meta-hackathon-appointments/scripts/mcp-stdio.sh
#
# The grant token comes from a file, never from the command line. The file
# is APPT_GRANT_TOKEN_FILE, by default ~/.config/appointments/grant-token on
# the host that runs this script. Create it with:
#
#   pnpm grant create --name <name> --tier <tier> --token-file ~/.config/appointments/grant-token
#
# APP_DB selects the event log, as for the app. APPT_NODE selects the Node 24
# binary when `node` on the PATH is another version. stdout carries only MCP
# messages, so this script prints nothing.
set -eu
cd -P "$(dirname "$0")/.."
: "${APPT_GRANT_TOKEN_FILE:=${HOME}/.config/appointments/grant-token}"
export APPT_GRANT_TOKEN_FILE
exec "${APPT_NODE:-node}" mcp/main.ts
