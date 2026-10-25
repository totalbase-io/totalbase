#!/usr/bin/env bash
# Runs the backend and the admin UI together behind ONE port
# (TOTALBASE_PORT, default 3030 per .env) - the same "one service, one
# origin" shape production uses (apps/server/src/admin-ui.ts serves
# the SPA at the root itself there), instead of two separate dev ports that keep
# drifting (3000 taken -> Nuxt falls back to 3001, etc.).
#
# The admin UI still hot-reloads: a real `nuxt dev` process runs on its
# own internal port, and apps/server reverse-proxies every path outside
# its own to it via TOTALBASE_ADMIN_UI_DEV_PROXY_TARGET - see
# admin-ui.ts's own doc comment for the mechanism. There is only ever
# one URL to open: http://localhost:$TOTALBASE_PORT/.
#
# See AGENTS.md section 4B for the full explanation.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
source .env
set +a

PORT="${TOTALBASE_PORT:?TOTALBASE_PORT must be defined in .env}"
# The admin's internal `nuxt dev` port - never opened directly (AGENTS.md 4B).
ADMIN_DEV_PORT="${TOTALBASE_ADMIN_DEV_PORT:-3031}"

# Development owns these ports. A stale watcher can keep a port bound after
# its terminal has gone away, leaving the next `pnpm dev` stuck while it
# waits for a process that will never become ready. Release every configured
# listener before starting this run so the public origin is always PORT.
release_port() {
  local port="$1"

  if ! fuser -s -n tcp "$port"; then
    return
  fi

  echo "==> Stopping process listening on port $port..."
  fuser -k -TERM -n tcp "$port" >/dev/null 2>&1 || true

  for _ in $(seq 1 20); do
    if ! fuser -s -n tcp "$port"; then
      return
    fi
    sleep 0.25
  done

  echo "==> Force stopping process listening on port $port..."
  fuser -k -KILL -n tcp "$port" >/dev/null 2>&1 || true

  for _ in $(seq 1 20); do
    if ! fuser -s -n tcp "$port"; then
      return
    fi
    sleep 0.25
  done

  echo "Could not release port $port." >&2
  exit 1
}

release_port "$PORT"
release_port "$ADMIN_DEV_PORT"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

echo "==> Starting admin UI (nuxt dev) on port $ADMIN_DEV_PORT..."
(cd apps/admin && PORT="$ADMIN_DEV_PORT" pnpm run dev) &
pids+=("$!")

echo "==> Waiting for admin UI to accept connections..."
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:$ADMIN_DEV_PORT/"; then
    break
  fi
  sleep 1
done

echo "==> Starting backend (tsx watch) on port $PORT, proxying the admin UI..."
echo "==> Open http://localhost:$PORT/"
(
  cd apps/server
  TOTALBASE_PORT="$PORT" TOTALBASE_ADMIN_UI_DEV_PROXY_TARGET="http://localhost:$ADMIN_DEV_PORT" pnpm run dev
) &
pids+=("$!")

wait
