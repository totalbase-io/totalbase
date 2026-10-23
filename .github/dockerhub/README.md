<p align="center">
  <img src="https://raw.githubusercontent.com/totalbase-io/totalbase/main/brand/svg/app-icon.svg" alt="TotalBase" width="64">
</p>

# TotalBase

**From your PostgreSQL database to APIs, screens, dashboards and automations** - built by hand, or by describing it to an AI agent. PostgreSQL stays the authority. Open source, Apache 2.0.

[Website](https://totalbase.io) · [Documentation](https://docs.totalbase.io) · [Installation](https://docs.totalbase.io/getting-started/installation) · [GitHub](https://github.com/totalbase-io/totalbase) · [Release notes](https://github.com/totalbase-io/totalbase/releases)

![Work orders as a table in the TotalBase App](https://raw.githubusercontent.com/totalbase-io/totalbase/main/.github/readme/type-table-dark.webp)

One image, one port, on top of your PostgreSQL 15 to 18:

- **A REST Data API** over the tables, views and functions you expose - filters, relations, aggregates, nested writes, transactions - with a generated OpenAPI document.
- **Users, roles and permissions** down to rows and fields.
- **DataViews**: tables, cards, kanban, calendar, Gantt, map, org chart, forms and custom pages, in an App for desktop, tablet and phone.
- **Dashboards** from SQL queries, **workflows**, an **audit log**, and an **MCP server** at `/mcp` for AI agents.

## Quick start

Against a PostgreSQL you already run, the connection is all it needs:

```bash
docker run -d --name totalbase -p 3050:3050 \
  -v totalbase-data:/var/lib/totalbase \
  -e POSTGRES_HOST=your-server -e POSTGRES_DB=acme \
  -e POSTGRES_USER=totalbase -e POSTGRES_PASSWORD=... \
  totalbase/totalbase:beta

docker logs totalbase   # the link that creates the first administrator
```

Open the link, create your administrator, and you're in the admin at `http://localhost:3050/admin/`. With PostgreSQL included, from scratch: the Docker Compose example in [Installation](https://docs.totalbase.io/getting-started/installation).

The database role should not be a superuser: TotalBase can do exactly what its role can do, and nothing more.

## Tags

| Tag | |
|---|---|
| `beta` | the latest beta |
| `0.1.0-beta.4` | this version - pin one in production |

Both for `linux/amd64` and `linux/arm64`. `latest` arrives with the first stable release.

## Configuration

| Variable | Required | |
|---|---|---|
| `POSTGRES_HOST`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | yes | The connection |
| `POSTGRES_PORT`, `POSTGRES_SSL` | no | `5432`; `off`, `require` or `verify-full` |
| `TOTALBASE_PUBLIC_URL` | no | The address users reach it at, for links in emails; the first setup asks for it too |
| `TOTALBASE_MASTER_KEY` | no | Encrypts stored secrets, at least 32 characters. Unset: generated into the data volume on the first start |
| `TOTALBASE_ADMIN_EMAIL`, `TOTALBASE_ADMIN_PASSWORD` | no | The first administrator, for automated installs. Unset: the setup link in the log |
| `TOTALBASE_PORT` | no | `3050` |

Every variable: [Environment](https://docs.totalbase.io/reference/environment).

| Path | |
|---|---|
| `/var/lib/totalbase` | **Mount a volume here**: uploaded files and the generated master key. Back it up apart from the database - a full recovery needs both |

| Port | |
|---|---|
| `3050` | The admin (`/admin/`), the App, the Data API (`/api/`) and the MCP server (`/mcp`); health at `/health/ready` |

## Upgrading

Back up the database and the data volume, then pull the new tag and restart: migrations run on start, each in its own transaction. See [Upgrading](https://docs.totalbase.io/operations/upgrading).

## Security

Report vulnerabilities privately to **security@totalbase.io**, never in a public issue.
