#!/usr/bin/env bash
# The end-to-end suite (Playwright, e2e/) on a fresh instance - what gates a release, after scripts/test-matrix.sh
# and before scripts/publish-public.sh (Foundations.md §21.5). Never against the development database: the suite
# creates and drops tables, roles and objects, and a database a previous run left behind makes its fixtures collide.
#
#   scripts/test-e2e.sh                         the whole suite
#   scripts/test-e2e.sh tests/ui-users.spec.ts  only these (any Playwright argument)
#
# The instance is the release's Docker image, built here from the working tree (`docker build --target server`, tagged
# totalbase:e2e): its Dockerfile, its user, its paths and its pg_dump are what the suite runs on, as installed.
# TOTALBASE_E2E_FROM_SOURCE=1 runs `node apps/server/dist/index.js` instead - quicker while writing a test, never
# what a release is checked with.
#
# Steps, each one here so none is forgotten:
#   1. build the image (from source: the packages and the admin; either way the widget catalog the specs import);
#   2. drop and create the test database (TOTALBASE_E2E_DB, default totalbase_e2e) on TOTALBASE_E2E_PG_PORT
#      (default 5415, PostgreSQL 15 - the baseline, Foundations.md §21.4), as POSTGRES_USER - it needs CREATEDB, never superuser;
#   3. start the instance on it, on TOTALBASE_PORT, with a throwaway data directory - the container's own, or a
#      temporary one from source; it migrates the empty database as it boots (from source, the migrations CLI first);
#   4. raise the two limits a whole suite exceeds from one IP and one admin: security.rate_limit_per_minute (3000)
#      and auth.max_sessions_per_user (20) - on this instance only, the product's defaults stay;
#   5. run Playwright (e2e/playwright.config.ts: the v1 files one at a time, the rest in parallel - graphql, then its docs examples, after them - then ui-dataviews alone);
#   6. stop the instance, whatever happened, keeping its log. The database stays, to look into a failure; the next run drops it.
# TOTALBASE_E2E_SKIP_BUILD=1 skips step 1 (the image totalbase:e2e already built); TOTALBASE_E2E_PORT runs the instance
# on another port than TOTALBASE_PORT. Playwright's report: e2e/test-results/.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
source .env
set +a

DB="${TOTALBASE_E2E_DB:-totalbase_e2e}"
PG_PORT="${TOTALBASE_E2E_PG_PORT:-5415}"
# TOTALBASE_E2E_PORT: another port, to run beside a development server on TOTALBASE_PORT.
PORT="${TOTALBASE_E2E_PORT:-${TOTALBASE_PORT:-3030}}"
export TOTALBASE_PORT="$PORT"
BASE_URL="http://localhost:$PORT"

if curl -s -o /dev/null "$BASE_URL/"; then
  echo "Something already answers on $BASE_URL - stop the dev server first (the suite needs its own instance)." >&2
  exit 1
fi

FROM_SOURCE="${TOTALBASE_E2E_FROM_SOURCE:-}"
IMAGE=totalbase:e2e
if [ "${TOTALBASE_E2E_SKIP_BUILD:-}" != "1" ]; then
  if [ "$FROM_SOURCE" = "1" ]; then
    pnpm -r run build
    pnpm --filter @totalbase/admin run generate
  else
    docker build --target server -t "$IMAGE" .
    # The specs import the widget catalog's build (e2e/tests/v1).
    pnpm --filter @totalbase/tb-catalog run build
  fi
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

LOG_DIR="$(mktemp -d)"
LOG="$LOG_DIR/server.log"
if [ "$FROM_SOURCE" = "1" ]; then
  node packages/migrations/dist/cli.js up >/dev/null
  (cd apps/server && TOTALBASE_DATA_DIR="$LOG_DIR" exec node dist/index.js >"$LOG" 2>&1) &
  SERVER=$!
  trap 'kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true' EXIT
else
  # The host's network: PostgreSQL at POSTGRES_HOST as .env has it, the instance on 127.0.0.1 only. What .env says
  # about this machine's tools and mode (NODE_ENV, TOTALBASE_PG_BIN, TOTALBASE_HOST) stays out: the image's own apply.
  CONTAINER="totalbase-e2e-$PORT"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" --network host \
    -e TOTALBASE_HOST=127.0.0.1 -e TOTALBASE_PORT -e TOTALBASE_PUBLIC_URL \
    -e POSTGRES_HOST -e POSTGRES_PORT -e POSTGRES_DB -e POSTGRES_USER -e POSTGRES_PASSWORD \
    -e TOTALBASE_MASTER_KEY -e TOTALBASE_ADMIN_EMAIL -e TOTALBASE_ADMIN_PASSWORD \
    -e SMTP_HOST -e SMTP_PORT -e SMTP_USER -e SMTP_PASSWORD \
    "$IMAGE" >/dev/null
  trap 'docker logs "$CONTAINER" >"$LOG" 2>&1 || true; docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT
fi

for _ in $(seq 1 60); do curl -s -o /dev/null -f "$BASE_URL/" && break; sleep 1; done
if ! curl -s -o /dev/null -f "$BASE_URL/"; then
  [ "$FROM_SOURCE" = "1" ] || docker logs "$CONTAINER" >"$LOG" 2>&1 || true
  echo "The server didn't start - $LOG:" >&2; tail -20 "$LOG" >&2; exit 1
fi

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

echo "=== Playwright against $BASE_URL ($([ "$FROM_SOURCE" = "1" ] && echo "from source" || echo "image $IMAGE"); server log, once stopped: $LOG)"
# The whole suite in two passes: the dataviews project alone, after the rest (e2e/playwright.config.ts).
if [ $# -eq 0 ]; then
  status=0
  (cd e2e && E2E_BASE_URL="$BASE_URL" npx playwright test --project parallel --project v1 --project graphql --project graphql-docs) || status=$?
  (cd e2e && E2E_BASE_URL="$BASE_URL" npx playwright test --project dataviews) || status=$?
  exit "$status"
fi
(cd e2e && E2E_BASE_URL="$BASE_URL" npx playwright test "$@")
