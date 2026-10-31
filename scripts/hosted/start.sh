#!/usr/bin/env bash
# Starts the hosted instance beside the local demo (0020, B10): hosted
# mode, port 5300 on 127.0.0.1, its own data folder, Tailscale as the
# trusted proxy, the request log on, and the production build. It refuses
# to start while a required setting is missing, and never prints a value.
#
# The secrets come from the environment, such as the systemd unit's
# EnvironmentFile (appointments-hosted.service). Required:
#   BETTER_AUTH_SECRET        at least 32 bytes
#   BETTER_AUTH_URL           the public origin, such as
#                             https://the-little-ai-co.tail374dd0.ts.net:10000
#   APP_DAILY_COST_CAP_USD    the most the server key may cost in a UTC day
#   APP_JUDGE_TOTAL_CAP_USD   the most all judge codes together may grant
#   MODEL_API_KEY             the server's Meta key, which credits pay for
# Optional: APP_WAITLIST_URL (the waitlist link, K9), APP_PUBLIC_SIGNUP
# (default off: judges only, K7), BETTER_AUTH_API_KEY (the dashboard
# plugin, kept unset for the hackathon, K6), APP_MARKUP,
# APP_HOSTED_DATA (the data folder, default ~/.local/share/appointments-hosted),
# APP_PORT (default 5300), NODE_BIN (default: node on PATH).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$here"

missing=()
for name in BETTER_AUTH_SECRET BETTER_AUTH_URL APP_DAILY_COST_CAP_USD APP_JUDGE_TOTAL_CAP_USD MODEL_API_KEY; do
  if [[ -z "${!name:-}" ]]; then missing+=("$name"); fi
done
if (( ${#missing[@]} > 0 )); then
  echo "Not starting: ${missing[*]} not set. Set them in the instance's env file." >&2
  exit 2
fi
if (( $(printf '%s' "$BETTER_AUTH_SECRET" | wc -c) < 32 )); then
  echo "Not starting: BETTER_AUTH_SECRET is shorter than 32 bytes." >&2
  exit 2
fi
if [[ ! -f dist/ui/index.html ]]; then
  echo "Not starting: no production build in $here/dist/ui. Run pnpm build first." >&2
  exit 2
fi

data="${APP_HOSTED_DATA:-$HOME/.local/share/appointments-hosted}"
umask 077
mkdir -p "$data"
chmod 700 "$data"

export APP_MODE=hosted
export APP_PORT="${APP_PORT:-5300}"
export APP_DB="$data/app.sqlite"
export APP_TRUSTED_PROXY=tailscale
export APP_REQUEST_LOG="${APP_REQUEST_LOG:-1}"
export NODE_ENV=production

node_bin="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" ]]; then
  echo "Not starting: node was not found. Set NODE_BIN to Node 24 or later." >&2
  exit 2
fi
exec "$node_bin" server/main.ts --static
