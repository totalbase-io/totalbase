#!/usr/bin/env bash
# Verifies that a pg_dump of the configured database can be restored into
# a throwaway database and that row counts match afterward.
#
# NOT run automatically by any test suite or CI step in V1 - this is an
# operational script for a human (or a scheduled job) to run
# periodically against a real backup target. See docs/content/17.operations/04.backup-restore.md
# for the full runbook (Specification.md §23: "backup/restore
# verification").
#
# Usage:
#   bash scripts/backup-restore-check.sh
#
# Reads connection details from .env (same variables as
# scripts/test-integration.sh). Set BACKUP_RESTORE_CHECK_DB to override
# the throwaway database name (default: a timestamped
# totalbase_restore_check_<epoch> name so repeated runs never collide).
#
# The script:
#   1. pg_dump's POSTGRES_DB to a temp file (custom format, -Fc).
#   2. Creates a throwaway database.
#   3. pg_restore's the dump into it.
#   4. Compares row counts for totalbase.users, totalbase.resources, and
#      totalbase.roles between source and restored target.
#   5. Drops the throwaway database and removes the dump file.
#
# It NEVER touches the source database beyond a read-only pg_dump.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${POSTGRES_HOST:?POSTGRES_HOST not set}"
: "${POSTGRES_PORT:?POSTGRES_PORT not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"
: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD not set}"

RESTORE_DB="${BACKUP_RESTORE_CHECK_DB:-totalbase_restore_check_$(date +%s)}"
DUMP_FILE="$(mktemp -u).dump"

export PGPASSWORD="$POSTGRES_PASSWORD"

cleanup() {
  echo "Cleaning up..."
  psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\";" >/dev/null 2>&1 || true
  rm -f "$DUMP_FILE"
}
trap cleanup EXIT

echo "==> Dumping $POSTGRES_DB to $DUMP_FILE"
pg_dump -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" -f "$DUMP_FILE"

echo "==> Creating throwaway database: $RESTORE_DB"
psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
  -c "CREATE DATABASE \"$RESTORE_DB\";"

echo "==> Restoring into $RESTORE_DB"
pg_restore -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$RESTORE_DB" "$DUMP_FILE"

echo "==> Comparing row counts"
FAILED=0
for TABLE in totalbase.users totalbase.roles totalbase.resources; do
  SOURCE_COUNT=$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM $TABLE")
  RESTORED_COUNT=$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$RESTORE_DB" -tAc "SELECT count(*) FROM $TABLE")
  if [ "$SOURCE_COUNT" != "$RESTORED_COUNT" ]; then
    echo "MISMATCH: $TABLE source=$SOURCE_COUNT restored=$RESTORED_COUNT"
    FAILED=1
  else
    echo "OK: $TABLE ($SOURCE_COUNT rows)"
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "==> Backup/restore verification FAILED"
  exit 1
fi

echo "==> Backup/restore verification PASSED"
