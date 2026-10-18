#!/usr/bin/env bash
# Runs the workspace's integration test suite against a dedicated test
# database (never the demo/dev database), using connection details from
# .env with POSTGRES_DB overridden.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
source .env
set +a

export POSTGRES_DB="${TOTALBASE_TEST_DB:-totalbase_test}"

pnpm -r run build
# One package at a time: they share the test database too. --no-bail: every package runs, so one run shows every failure.
pnpm -r --workspace-concurrency=1 --no-bail run test
