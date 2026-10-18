#!/bin/bash
# Runs once, on an empty data directory: the database TotalBase owns, the plain LOGIN role it
# connects as (never a superuser, AGENTS.md §4A), and btree_gist - the demo's no-double-booking
# exclusion constraint needs it, and only a superuser may create it, so the installation does.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v db="$TOTALBASE_DB_NAME" -v role="$TOTALBASE_DB_USER" -v password="$TOTALBASE_DB_PASSWORD" <<'EOSQL'
CREATE ROLE :"role" LOGIN PASSWORD :'password';
CREATE DATABASE :"db" OWNER :"role";
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$TOTALBASE_DB_NAME" -c 'CREATE EXTENSION btree_gist'
