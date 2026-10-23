#!/usr/bin/env bash
# The end-to-end suite (Playwright, e2e/) on a fresh instance - what gates a release, after scripts/test-matrix.sh
# and before scripts/publish-public.sh (Foundations.md §21.5). Never against the development database: the suite
# creates and drops tables, roles and objects, and a database a previous run left behind makes its fixtures collide.
#
#   scripts/test-e2e.sh                         the whole suite
#   scripts/test-e2e.sh tests/ui-users.spec.ts  only these (any Playwright argument)
#
# Steps, each one here so none is forgotten:
#   1. build the packages and the admin (the production code path: one process serves the API and /admin/);
#   2. drop and create the test database (TOTALBASE_E2E_DB, default totalbase_e2e) on TOTALBASE_E2E_PG_PORT
#      (default 5415, PostgreSQL 15 - the baseline, Foundations.md §21.4), as POSTGRES_USER - it needs CREATEDB, never superuser - and migrate it;
#   3. start the server on it, on TOTALBASE_PORT, with a throwaway data directory;
#   4. raise the two limits a whole suite exceeds from one IP and one admin: security.rate_limit_per_minute (300)
#      and auth.max_sessions_per_user (20) - on this instance only, the product's defaults stay;
#   5. run Playwright (e2e/playwright.config.ts: the v1 files one at a time, the rest in parallel);
#   6. stop the server, whatever happened. The database stays, to look into a failure; the next run drops it.
# TOTALBASE_E2E_SKIP_BUILD=1 skips step 1. Playwright's report: e2e/test-results/.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
source .env
set +a

DB="${TOTALBASE_E2E_DB:-totalbase_e2e}"
PG_PORT="${TOTALBASE_E2E_PG_PORT:-5415}"
PORT="${TOTALBASE_PORT:-3050}"
BASE_URL="http://localhost:$PORT"

if curl -s -o /dev/null "$BASE_URL/"; then
  echo "Something already answers on $BASE_URL - stop the dev server first (the suite needs its own instance)." >&2
  exit 1
fi

if [ "${TOTALBASE_E2E_SKIP_BUILD:-}" != "1" ]; then
  pnpm -r run build
  pnpm --filter @totalbase/admin run generate
fi

echo "=== $DB on $POSTGRES_HOST:$PG_PORT (dropped and created)"
(cd packages/database && PGPORT_="$PG_PORT" node -e '
  const pg = require("pg");
  const { POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_HOST: host } = process.env;
  const db = process.argv[1], quoted = `"${db.replace(/"/g, "\"\"")}"`;
  const client = new pg.Client({ host, port: Number(process.env.PGPORT_), user, password, database: "postgres" });
  (async () => {
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoted}`);
    await client.end();
  })().catch((error) => { console.error(`${host}:${process.env.PGPORT_}: ${error.message} (POSTGRES_USER needs CREATEDB)`); process.exit(1); });
' "$DB")
export POSTGRES_PORT="$PG_PORT" POSTGRES_DB="$DB" TOTALBASE_PUBLIC_URL="$BASE_URL"
node packages/migrations/dist/cli.js up >/dev/null

DATA_DIR="$(mktemp -d)"
LOG="$DATA_DIR/server.log"
(cd apps/server && TOTALBASE_DATA_DIR="$DATA_DIR" exec node dist/index.js >"$LOG" 2>&1) &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do curl -s -o /dev/null -f "$BASE_URL/admin/" && break; sleep 1; done
curl -s -o /dev/null -f "$BASE_URL/admin/" || { echo "The server didn't start - $LOG:" >&2; tail -20 "$LOG" >&2; exit 1; }

BASE_URL="$BASE_URL" node -e '
  const { BASE_URL: base, TOTALBASE_ADMIN_EMAIL: email, TOTALBASE_ADMIN_PASSWORD: password } = process.env;
  const send = (method, path, token, data) => fetch(base + path, {
    method, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(data),
  }).then(async (res) => { if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`); return res.json(); });
  (async () => {
    const { data: { token } } = await send("POST", "/api/auth/login", null, { email, password });
    await send("PATCH", "/admin/api/settings/security", token, { data: { "security.rate_limit_per_minute": 100000 } });
    await send("PATCH", "/admin/api/settings/auth", token, { data: { "auth.max_sessions_per_user": 10000 } });
  })().catch((error) => { console.error(error.message); process.exit(1); });
'

echo "=== Playwright against $BASE_URL (server log: $LOG)"
(cd e2e && E2E_BASE_URL="$BASE_URL" npx playwright test "$@")
