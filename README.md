<p align="center">
  <img src="brand/svg/app-icon.svg" alt="TotalBase" width="72">
</p>

<h1 align="center">TotalBase</h1>

<p align="center">
  From your PostgreSQL database to APIs, screens, dashboards and automations.<br>
  PostgreSQL stays the authority.
</p>

---

TotalBase connects to a PostgreSQL database, new or existing, and gives you, on top of it:

- **A REST Data API** over the tables, views and functions you choose to expose: filters, relations, aggregates, nested writes and transactions, with a generated OpenAPI document.
- **Users, roles and permissions** down to individual rows and fields: row filters, field grants and payload checks, compiled into the SQL PostgreSQL runs.
- **DataViews**: screens over your data - tables, cards, kanban boards, calendars, Gantt charts, maps, trees, forms and custom pages - that end users open in the App, on a desktop, a tablet or a phone.
- **Dashboards** built from SQL queries, which you can also embed in another site.
- **Workflows** started by a data change, a schedule, a webhook or a person.
- **An audit log** of every write, and an **MCP server** so an AI agent can build and run all of the above under the same permissions as a person.

TotalBase doesn't replace or hide PostgreSQL. Your tables stay ordinary PostgreSQL tables, constraints, triggers and functions keep deciding, and anything you change with `psql` or a migration tool shows up in TotalBase too.

## Status

**Beta** (`0.1.0-beta.1`). It runs, it's tested on PostgreSQL 15 to 18, and its data model is final from this release on: a beta database upgrades in place. APIs may still change before 1.0, and every change is in the release notes.

## Requirements

- **PostgreSQL 15, 16, 17 or 18** (18 recommended for new installations).
- **A database role that is not a superuser.** TotalBase can do exactly what its role can do, and nothing more.
- **Docker**, or any container runtime.

## Quick start

TotalBase runs as one container, on one port: the admin at `/admin/`, the Data API at `/api/`, the MCP server at `/mcp`.

```yaml
# docker-compose.yml - PostgreSQL 18 and TotalBase together
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_SUPERUSER_PASSWORD}
      TOTALBASE_DB_PASSWORD: ${TOTALBASE_DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql
      - ./postgres-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d acme"]
      interval: 5s
      retries: 20

  totalbase:
    image: totalbase/totalbase:beta
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_DB: acme
      POSTGRES_USER: totalbase
      POSTGRES_PASSWORD: ${TOTALBASE_DB_PASSWORD}
    volumes:
      - data:/var/lib/totalbase   # uploaded files and the generated master key
    ports:
      - "3050:3050"

volumes:
  pgdata:
  data:
```

```bash
# postgres-init/01-totalbase.sh - a non-superuser role and the database it owns
#!/bin/bash
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<EOSQL
CREATE ROLE totalbase LOGIN PASSWORD '${TOTALBASE_DB_PASSWORD}';
CREATE DATABASE acme OWNER totalbase;
EOSQL
```

Put the two passwords in an `.env` file beside it and run `docker compose up -d`. `docker compose logs totalbase` shows the link that creates the first administrator. Against a PostgreSQL you already run, keep only the `totalbase` service and point `POSTGRES_HOST` at it.

The first start generates the master key, which encrypts stored secrets, into `/var/lib/totalbase/master.key` (or set your own, at least 32 characters, in `TOTALBASE_MASTER_KEY`). Keep a copy outside the database: a full recovery needs both a PostgreSQL backup and the key.

## Building from source

```bash
pnpm install
pnpm -r run build
docker build --target server -t totalbase:local .
```

For development, `pnpm dev` runs the server and the admin together on one origin (`http://localhost:3050/admin/`); copy `.env.example` to `.env` first. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it has the project's rules, and a contribution needs the [Contributor License Agreement](CLA.md), signed once from the pull request. Security problems go privately, as [SECURITY.md](SECURITY.md) says - never in a public issue.

## License

[Apache License 2.0](LICENSE). Copyright 2026 César Echazú and the TotalBase contributors.
