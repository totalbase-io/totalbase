#!/usr/bin/env bash
# Builds the documentation demo from nothing (Docs_Demo_Field_Service.md §11): a fresh stack, then
# everything through the MCP server in the build guide's order. Re-running a step is safe; the
# whole build on an existing stack: ./build.sh --keep.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Copy .env.example to .env and fill it in."; exit 1; }
set -a; source .env; set +a
BASE=http://localhost:3080

if [ "${1:-}" != "--keep" ]; then
  docker compose down -v
  docker compose up -d --build
fi
until curl -fsS "$BASE/health/ready" >/dev/null 2>&1; do sleep 2; done

# What only a signed-in administrator changes: language, SMTP (Mailpit), SQL Console for tokens.
session=$(curl -fsS -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$TOTALBASE_ADMIN_EMAIL\",\"password\":\"$TOTALBASE_ADMIN_PASSWORD\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')
admin() { curl -fsS -o /dev/null -X "$1" "$BASE$2" -H "authorization: Bearer $session" -H 'content-type: application/json' -d "$3"; }
admin PATCH /admin/api/settings/system '{"data":{"language":"en"}}'
admin PATCH /admin/api/settings/smtp '{"data":{"host":"mailpit","port":1025,"secure":false,"from":"Acme Field Services <service@acme-field.example>"}}'
admin PATCH /admin/api/settings/sql_console '{"data":{"token_access":true}}'
# No rate limit raised: the build's few hundred MCP calls a minute fit the defaults (mcp.rate_limit_per_minute).
admin PUT /admin/api/secrets/accounting-api-key '{"data":{"value":"demo-accounting-key-not-real"}}'

export TOTALBASE_TOKEN=$(./mint-agent-token.sh)
cd build
sql() { node mcp.mjs execute_sql "$(node -e 'process.stdout.write(JSON.stringify({sql: require("fs").readFileSync(process.argv[1], "utf8"), confirm: true}))' "$1")" >/dev/null; }
sql 01-schema.sql
node mcp.mjs 02-expose.json
node 03-present.mjs >/dev/null && node mcp.mjs 03-present.json
sql 04-reference.sql
node 05-access.mjs
sql 06-seed.sql
node 07-dataviews.mjs
node 08-dashboards.mjs >/dev/null
node 09-workflows.mjs
node 10-images.mjs
sql 06-seed.sql   # again: it sets the images on their rows by file name
node 12-pages.mjs
node mcp.mjs 11-menu.json
node 13-extras.mjs
echo "Acme Field Services is up at $BASE/admin/ - Mailpit at http://localhost:8026"
