#!/usr/bin/env bash
# A published image, checked as someone installing it would run it (Foundations.md §21.5): the image's own command,
# user and paths, beside a PostgreSQL of its own - nothing of the repository's but this script. The public
# repository's Release workflow runs it on each architecture's image before moving the release's channel (`beta`,
# `latest`); locally it takes any image.
#
#   scripts/test-image.sh totalbase/totalbase:0.1.0-beta.9 0.1.0-beta.9   (the version the image must report)
#   scripts/test-image.sh totalbase:e2e                                    (any image; the version isn't checked)
#
# What it checks: the server boots and migrates an empty database; the admin is served; sign-in; a table created,
# exposed, written and read through the Data API; the MCP endpoint is there; a backup runs with the image's pg_dump
# and its manifest names the version; the `totalbase` command line answers. TOTALBASE_IMAGE_PG picks PostgreSQL's
# major (default 15, the baseline - the oldest server the image's client tools dump); TOTALBASE_IMAGE_PORT the host port (3090).
set -euo pipefail

IMAGE="${1:?usage: test-image.sh <image> [expected-version]}"
VERSION="${2:-}"
PG="${TOTALBASE_IMAGE_PG:-15}"
PORT="${TOTALBASE_IMAGE_PORT:-3090}"
BASE_URL="http://127.0.0.1:$PORT"
RUN="tb-image-check-$$"
EMAIL="admin@image-check.test"
PASSWORD="image-check-$RANDOM-$RANDOM"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && docker inspect "$RUN-server" >/dev/null 2>&1; then
    echo "--- server log (last 40 lines)" >&2
    docker logs --tail 40 "$RUN-server" >&2 || true
  fi
  docker rm -f "$RUN-server" "$RUN-db" >/dev/null 2>&1 || true
  docker network rm "$RUN" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker network create "$RUN" >/dev/null
docker run -d --name "$RUN-db" --network "$RUN" \
  -e POSTGRES_USER=totalbase -e POSTGRES_PASSWORD=totalbase -e POSTGRES_DB=totalbase \
  "postgres:$PG" >/dev/null
for _ in $(seq 1 60); do docker exec "$RUN-db" pg_isready -U totalbase -d totalbase >/dev/null 2>&1 && break; sleep 1; done

echo "=== $IMAGE on PostgreSQL $PG"
docker run -d --name "$RUN-server" --network "$RUN" -p "127.0.0.1:$PORT:3030" \
  -e POSTGRES_HOST="$RUN-db" -e POSTGRES_PORT=5432 -e POSTGRES_DB=totalbase \
  -e POSTGRES_USER=totalbase -e POSTGRES_PASSWORD=totalbase \
  -e TOTALBASE_ADMIN_EMAIL="$EMAIL" -e TOTALBASE_ADMIN_PASSWORD="$PASSWORD" \
  -e TOTALBASE_PUBLIC_URL="$BASE_URL" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 120); do curl -s -o /dev/null -f "$BASE_URL/health/ready" && break; sleep 1; done
curl -s -o /dev/null -f "$BASE_URL/health/ready" || { echo "Not ready after 120 s." >&2; exit 1; }
echo "ready"

BASE_URL="$BASE_URL" EMAIL="$EMAIL" PASSWORD="$PASSWORD" VERSION="$VERSION" node -e '
  const { BASE_URL: base, EMAIL: email, PASSWORD: password, VERSION: version } = process.env;
  const check = (ok, what) => { if (!ok) throw new Error(what); console.log(`ok   ${what}`); };
  let token = null;
  const send = async (method, path, data) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(data !== undefined && { "content-type": "application/json" }), ...(token && { authorization: `Bearer ${token}` }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  (async () => {
    const admin = await fetch(`${base}/`);
    check(admin.ok && (admin.headers.get("content-type") ?? "").includes("text/html"), "the admin is served at /");

    token = (await send("POST", "/api/auth/login", { email, password })).data.token;
    check(Boolean(token), "the first administrator signs in");

    await send("POST", "/admin/api/sql/execute", { data: { sql: "CREATE TABLE public.image_checks (id serial PRIMARY KEY, name text NOT NULL)" } });
    await send("POST", "/admin/api/catalog/refresh");
    const { data: resources } = await send("GET", "/api/totalbase/table/resources?fields=id&where[schema][_eq]=public&where[name][_eq]=image_checks");
    await send("PATCH", `/admin/api/resources/${resources[0].id}`, { data: { exposedMethods: ["GET", "POST"] } });
    await send("POST", "/api/public/table/image_checks", { data: { name: "from the image" } });
    const { data: rows } = await send("GET", "/api/public/table/image_checks?fields=name");
    check(rows.length === 1 && rows[0].name === "from the image", "a table is created, exposed, written and read");

    // Off by default (Settings > MCP): on, it answers - a request without a token is 401, not 404.
    await send("PATCH", "/admin/api/settings/mcp", { data: { "mcp.enabled": true } });
    const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check(mcp.status === 401, `the MCP endpoint answers at /mcp (${mcp.status})`);

    // Off by default too: on, Back up now runs the image pg_dump into its own backups directory.
    await send("PATCH", "/admin/api/settings/backups", { data: { "backups.enabled": true } });
    const { data: queued } = await send("POST", "/admin/api/backups", { data: {} });
    let backup = queued;
    for (let i = 0; i < 120 && (backup.status === "PENDING" || backup.status === "RUNNING"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      backup = (await send("GET", "/admin/api/backups")).data.find((b) => b.id === queued.id);
    }
    check(backup.status === "COMPLETED", `a backup completes with the image pg_dump (${backup.status}${backup.error ? `: ${backup.error}` : ""})`);
    if (version) check(backup.manifest?.totalbaseVersion === version, `the image is TotalBase ${version} (${backup.manifest?.totalbaseVersion})`);
  })().catch((error) => { console.error(`FAIL ${error.message}`); process.exit(1); });
'

# Without arguments it prints its usage (and exits 1).
usage="$(docker exec "$RUN-server" totalbase 2>&1 || true)"
[[ "$usage" == *"Usage: totalbase restore"* ]] || { echo "FAIL the totalbase command line doesn't answer" >&2; exit 1; }
echo "ok   the totalbase command line answers"
echo "=== $IMAGE passed"
