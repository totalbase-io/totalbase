#!/usr/bin/env bash
# The integration suite on every supported PostgreSQL major (15-18, Foundations.md §21.4) against this machine's
# servers - run before scripts/publish-public.sh, so the private repository spends no CI minutes: the public
# repository's CI runs the same matrix, free, on what is published.
#
#   scripts/test-matrix.sh           every major
#   scripts/test-matrix.sh 15 18     only these
#
# TOTALBASE_TEST_PG_PORTS maps each major to its port ("15:5415 16:5416 17:5417 18:5418" by default), on .env's
# POSTGRES_HOST (or TOTALBASE_TEST_PG_HOST). A server without the test database (TOTALBASE_TEST_DB) gets it,
# owned by POSTGRES_USER, created as POSTGRES_SUPERUSER (default postgres) with POSTGRES_SUPERUSER_PASSWORD.
# POSTGRES_USER needs CREATEDB and CREATEROLE (never superuser): the schema-ownership and object-ownership
# tests create databases and roles - as CI's test role can.
# Each major's output goes to $TMPDIR/totalbase-test-matrix/pg<major>.log; the summary is printed at the end.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
source .env
set +a

TEST_DB="${TOTALBASE_TEST_DB:-totalbase_test}"
HOST="${TOTALBASE_TEST_PG_HOST:-$POSTGRES_HOST}"
PORTS="${TOTALBASE_TEST_PG_PORTS:-15:5415 16:5416 17:5417 18:5418}"
LOGS="${TMPDIR:-/tmp}/totalbase-test-matrix"
mkdir -p "$LOGS"

declare -A PORT_OF
for pair in $PORTS; do PORT_OF[${pair%%:*}]=${pair#*:}; done
MAJORS=("$@")
[ ${#MAJORS[@]} -gt 0 ] || MAJORS=($(printf '%s\n' "${!PORT_OF[@]}" | sort -n))

# What CI prepares too (.github/workflows/ci.yml): files.storage_local_path's default, writable.
if ! mkdir -p /var/lib/totalbase/files 2>/dev/null || [ ! -w /var/lib/totalbase/files ]; then
  echo "/var/lib/totalbase/files must exist and be yours (files.storage_local_path's default), once:" >&2
  echo "  sudo mkdir -p /var/lib/totalbase/files && sudo chown -R \"\$USER\" /var/lib/totalbase" >&2
  exit 1
fi
[ -n "${TOTALBASE_TEST_PG_BIN:-}" ] || echo "note: TOTALBASE_TEST_PG_BIN is not set - the built-in backups' tests (pg_dump, pg_restore) are skipped."

# The test database on each server, created when missing - node-postgres from @totalbase/database, no psql needed.
ensure_database() {
  (cd packages/database && PGPORT_="$1" node -e '
    const pg = require("pg");
    const { POSTGRES_USER: owner, POSTGRES_SUPERUSER_PASSWORD: password } = process.env;
    const db = process.argv[1], host = process.argv[2], port = Number(process.env.PGPORT_);
    const client = new pg.Client({ host, port, user: process.env.POSTGRES_SUPERUSER || "postgres", password, database: "postgres" });
    (async () => {
      await client.connect();
      const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
      if (!rowCount) {
        await client.query(`CREATE DATABASE "${db.replace(/"/g, "\"\"")}" OWNER "${owner.replace(/"/g, "\"\"")}"`);
        console.log(`created ${db} on ${host}:${port}`);
      }
      await client.end();
    })().catch((error) => { console.error(`${host}:${port}: ${error.message}`); process.exit(1); });
  ' "$TEST_DB" "$HOST")
}

pnpm -r run build

declare -A RESULT
for major in "${MAJORS[@]}"; do
  port="${PORT_OF[$major]:-}"
  if [ -z "$port" ]; then echo "no port for PostgreSQL $major (TOTALBASE_TEST_PG_PORTS)" >&2; RESULT[$major]="no port"; continue; fi
  echo "=== PostgreSQL $major ($HOST:$port) - $LOGS/pg$major.log"
  if ! ensure_database "$port"; then RESULT[$major]="unreachable"; continue; fi
  # Migrated before the suite: a fresh database's baseline outlasts a test file's setup timeout.
  if ! POSTGRES_HOST="$HOST" POSTGRES_PORT="$port" POSTGRES_DB="$TEST_DB" node packages/migrations/dist/cli.js up >"$LOGS/pg$major.log" 2>&1; then
    RESULT[$major]="migrations failed"; echo "    ${RESULT[$major]}"; continue
  fi
  if TOTALBASE_TEST_PG_HOST="$HOST" TOTALBASE_TEST_PG_PORT="$port" TOTALBASE_TEST_SKIP_BUILD=1 \
      bash scripts/test-integration.sh >>"$LOGS/pg$major.log" 2>&1; then
    RESULT[$major]="passed"
  else
    RESULT[$major]="FAILED"
  fi
  echo "    ${RESULT[$major]}"
done

echo
echo "PostgreSQL  result"
failed=0
for major in "${MAJORS[@]}"; do
  printf '%-11s %s\n' "$major" "${RESULT[$major]}"
  [ "${RESULT[$major]}" = "passed" ] || failed=1
done
exit $failed
