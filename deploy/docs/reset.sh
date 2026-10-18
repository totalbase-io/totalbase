#!/usr/bin/env bash
# Resets the demo's rows to the demo day (today): the seed clears what it writes and writes it again,
# dates relative to today, ids and random values fixed - a screenshot run only changes when the UI did.
set -euo pipefail
cd "$(dirname "$0")/build"
: "${TOTALBASE_TOKEN:?export TOTALBASE_TOKEN=\$(../mint-agent-token.sh)}"
node mcp.mjs execute_sql "$(node -e 'process.stdout.write(JSON.stringify({sql: require("fs").readFileSync("06-seed.sql", "utf8"), confirm: true}))')" >/dev/null
echo "reset to $(date +%F)"
