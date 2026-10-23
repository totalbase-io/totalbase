# TotalBase - one service on one port: the Data/Admin APIs and the built admin
# SPA (at the root), served by apps/server (AGENTS.md §4B). The image keeps the
# monorepo's layout, so the server finds the admin build and the migrations
# where it always does (apps/admin/.output/public, migrations/totalbase).
#
#   docker build -t totalbase:local .                     the server
#   docker build -t totalbase-mcp:local --target mcp .    the MCP server (Administration.md §11)
#
# Debian slim, not Alpine: argon2, isolated-vm and sharp are native modules,
# compiled here against glibc and loaded by the same base at runtime.

ARG NODE_VERSION=22
# Optional: another Debian mirror for the build stage's apt (its main archive; security stays
# deb.debian.org) - for when deb.debian.org is slow or unreachable from the build host. Empty: the default.
#   docker build --build-arg APT_MIRROR=http://debian.mirror.constant.com/debian ...
ARG APT_MIRROR=

# --- build: every package, the server and the admin's static build ---------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG APT_MIRROR
RUN if [ -n "$APT_MIRROR" ]; then sed -i -E "s#^URIs: http://deb.debian.org/debian\$#URIs: $APT_MIRROR#" /etc/apt/sources.list.d/debian.sources; fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

COPY . .
# isolated-vm compiles here (pnpm-workspace.yaml's onlyBuiltDependencies); the
# admin's postinstall builds what its nuxt.config imports, then prepares it.
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter=./packages/* run build \
  && pnpm --filter @totalbase/server run build \
  && pnpm --filter @totalbase/admin run generate

# The packages' tsconfigs compile their tests into dist too (so `typecheck` covers them): the image carries none.
RUN find packages apps/server -path '*/dist/*' \( -name '*.test.js' -o -name '*.test.d.ts' -o -name '*.test.js.map' -o -name '*test-support*' \) -delete

# Production dependencies only, in place: the same layout, without dev tools.
RUN pnpm install --frozen-lockfile --prod --offline --ignore-scripts --config.confirmModulesPurge=false
# The native modules load - or the image fails here, not at its first start.
RUN cd packages/workflows && node -e "require('isolated-vm')" \
  && cd ../auth && node -e "require('argon2')" \
  && cd ../files && node -e "require('sharp')"

# --- runtime: the server ------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS server
# PostgreSQL 18's client tools from PostgreSQL's own repository (PGDG) - pg_dump, pg_restore and psql for the built-in
# backups (Administration.md §12); 18 dumps and restores every supported server, 15 to 18. Its key is fetched over
# HTTPS from postgresql.org, and curl leaves with the build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    TOTALBASE_HOST=0.0.0.0 \
    TOTALBASE_PORT=3030 \
    TOTALBASE_PG_BIN=/usr/lib/postgresql/18/bin
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/admin/.output/public ./apps/admin/.output/public
COPY --from=build --chown=node:node /app/migrations ./migrations
# The data directory (TOTALBASE_DATA_DIR): uploaded files (files.storage_local_path) and a generated master key -
# mount a volume here.
# Its backups (backups.local_path) go in /var/lib/totalbase/backups - better a volume on another disk.
RUN mkdir -p /var/lib/totalbase/files /var/lib/totalbase/backups && chown -R node:node /var/lib/totalbase
# The image's command line: `totalbase restore <archive>` (Administration.md §12.5).
RUN printf '#!/bin/sh\nexec node /app/apps/server/dist/cli.js "$@"\n' > /usr/local/bin/totalbase && chmod 755 /usr/local/bin/totalbase
USER node
EXPOSE 3030
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TOTALBASE_PORT||3030)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
