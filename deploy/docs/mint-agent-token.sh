#!/usr/bin/env bash
# Turns the MCP server on (Settings > MCP - a signed-in administrator's
# change, never a token's) and issues the agent's token: a plane="ADMIN"
# personal access token of the lab's administrator (the same as My account >
# Tokens with Access "Admin"), valid 30 days. Prints only the key - shown once:
#
#   export TOTALBASE_TOKEN=$(./mint-agent-token.sh)
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env; set +a
BASE="${TOTALBASE_URL:-http://localhost:3080}"

session=$(curl -fsS -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$TOTALBASE_ADMIN_EMAIL\",\"password\":\"$TOTALBASE_ADMIN_PASSWORD\"}")
token=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).data.token)' "$session")
user=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).data.user.id)' "$session")

curl -fsS -o /dev/null -X PATCH "$BASE/admin/api/settings/mcp" -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -d '{"data":{"enabled":true}}'

issued=$(curl -fsS -X POST "$BASE/admin/api/tokens" -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -d "{\"data\":{\"userId\":\"$user\",\"name\":\"agent-$(date +%Y%m%d-%H%M%S)\",\"plane\":\"ADMIN\",\"ttlDays\":30}}")
node -e 'process.stdout.write(JSON.parse(process.argv[1]).data.key)' "$issued"
