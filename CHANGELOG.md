# Changelog

What changes from one TotalBase version to the next: what's new, and what an upgrade asks of you. Each version's section is also its [GitHub release](https://github.com/totalbase-io/totalbase/releases)'s notes (`scripts/release-notes.sh`). The step-by-step upgrade guide is in the [documentation](https://docs.totalbase.io/operations/upgrading).

## 0.1.0-beta.10 - 2026-10-30

### Highlights

- **A Password column in a DataView.** A DataView over a table with a Password column loads its rows and opens its records again (every row was refused before). The column lives in the record form only, never in a grid, a filter or an export: its new **Password** field has an eye that shows what was typed, starts empty when editing - leave it empty to keep the password - and never shows a stored one.
- **A column dropped from a table no longer breaks its DataViews.** The rows keep loading without it, and the dropped column shows as a broken reference - the error icon on the DataView in the tree and on the table's **Columns** - until you remove it from the DataView and publish. A column renamed since the DataView was published shows under its new name.
- **Column titles read in an empty grid**: with no rows, a column is at least 120 px wide instead of "…".
- A wizard's wide step (New DataView's Columns) scrolls inside the modal instead of stretching it.

### Before you upgrade

- **Nothing to do to upgrade.** No migration applies on start.
- **An App API change**: `GET /app/api/dataviews/:slug/fields` leaves out a Password column and a column the table no longer has; the admin's field read marks the latter `orphaned: true`.

## 0.1.0-beta.9 - 2026-10-29

### Highlights

- **Your own regional format.** Each user picks how numbers, dates and times read in **My account › Preferences** (40 formats, found by typing a country); the instance's **Regional format** (Settings › General) is the default, the browser's the last resort. Always Latin digits and the Gregorian calendar.
- **Midnight color mode** - the rail and the panel dark over light content - and a **Color mode** for the whole instance in Settings › General › Appearance. A viewer's own pick in the avatar menu still wins.
- **Settings switches read "Enable ..."**, and a page whose switch turns its feature on (MCP, Files, SQL Console, GraphQL, Realtime, S3, Backups, the worker, the audit log) shows it first; what depends on it waits until it's on.
- **Spanish complete**: every screen, notice and formula error is translated.
- My account's tabs are **Profile, Preferences, Tokens, Sessions, Activity**.

### Before you upgrade

- **The date and time format patterns are gone.** One migration applies on start: it removes the instance's **Default date format**, **Default time format** and **Default date/time format**, and each user's date and time format. Dates and times now follow the regional format - set the instance's in Settings › General, or each user's own.
- **An API change**: a user's preferences (`PATCH /app/api/me/preferences`) take `regionalFormat`; `dateFormat` and `timeFormat` are no longer accepted.

## 0.1.0-beta.8 - 2026-10-29

### Highlights

- **GraphQL API**, off by default: the tables, views and functions your roles allow at one endpoint, `POST /api/graphql` - relations both ways, nested create, `Idempotency-Key`, and subscriptions over a WebSocket when Realtime is on. Turn it on in Settings › Data API › GraphQL.
- **A regional format for the instance** in Settings › General: how numbers and dates read for everyone.
- **Grids like a spreadsheet's**: cells cut to their column, widths dragged at the header's edge, columns dragged to reorder, and a menu on each header - sort, filter, hide, alignment, one line or several.
- **A column's control by its type**: a `text` column is a box of several lines, a `varchar` one line, a number typed with a numeric keyboard, a `uuid` a field that generates one.
- **New table columns** reach their DataViews by themselves, shown and at the end of the record form, unless the DataView says otherwise.

### Before you upgrade

- **An API change: an `interval` column reads as text.** REST, GraphQL and Realtime return PostgreSQL's own text (`"1 day 02:03:00"`), no longer an object (`{ "days": 1, "hours": 2, … }`). Writing that text back works as before.
- No migration applies on start.

## 0.1.0-beta.7 - 2026-10-27

### Highlights

- **Realtime**, off by default: a table's changes over a WebSocket at `/api/realtime`, read from PostgreSQL's WAL through logical replication, each subscriber seeing only the rows and fields its roles allow.
- **The role hierarchy page**: every role in one org chart, arranged by dragging a role onto another.
- **Copy a role's permissions** from another, in one transaction.
- A role's **Members** tab and a user's **Roles** tab are a switch per user or role, with a search.

### Before you upgrade

- One migration applies on start.
- **Realtime** needs PostgreSQL's logical replication (`wal_level = logical`, which needs a PostgreSQL restart) and the `REPLICATION` attribute on TotalBase's role - only when you turn it on.

## 0.1.0-beta.6 - 2026-10-25

### Highlights

- **The role hierarchy**: roles in a tree, each parent the ceiling of what the roles below it can be granted, and **delegated management** - a role with *Can manage the roles below it* creates, assigns and grants them within that ceiling.
- **Access governance**: incompatible roles nobody may hold together, and role assignments that end on a date.
- **Session security**: the admin's session in an `HttpOnly` cookie, security headers with a strict Content-Security-Policy, sign-out after inactivity, deactivating unused accounts, and confirming your identity again (15 minutes) before the actions that could hand over the instance.
- **Passwords** of at most 128 characters and never one of the most common.
- **Security notices** by email when two-factor authentication is turned off or reset, and when an API token is created or regenerated.

### Before you upgrade

- **Everyone signs in again**: sessions opened before the upgrade aren't picked up. API clients and tokens are not affected.
- **An `https://` public URL means HTTPS only**: the session cookie is `Secure`, so reach the admin over HTTPS, at the public URL.
- **Don't let a proxy replace the Content-Security-Policy**: TotalBase sends its own.
- **An existing account's email changes only through its own route** (`PUT /admin/api/users/{id}/email`), no longer through the Data API.
- Five migrations apply on start; every new setting is off or unchanged by default.

## 0.1.0-beta.5 - 2026-10-23

### Highlights

- **The admin and the App at the root** of the instance's address: `/` signs in, `/app` is the App, `/status` the admin's home. The APIs keep their paths. An unknown API path answers `404 RESOURCE_NOT_FOUND`.
- **The default port is 3030.**
- **Rate limiting starts off**, and when on it also limits failed sign-ins per IP address.
- **Screens with many images** load only the images on screen, a few at a time.

### Before you upgrade

- **Proxy**: remove any redirect from `/` to `/admin/` - the root is now the admin itself.
- **Port**: an instance that relies on the default port now listens on 3030 (it was 3050): update the port mapping, the proxy's upstream and health checks, or set `TOTALBASE_PORT=3050`.
- **Old addresses stop working**: bookmarks under `/admin/...`, embedded dashboards with an `/admin/embed/...` address (copy the new one from Settings › Share), and invitation, reset and verification links sent before the upgrade.
- **Rate limiting**: an instance that never changed it now has it off.

## 0.1.0-beta.4 - 2026-10-22

### Highlights

- **A workflow on a function call**: a Database event on a function starts one run per call through the Data API, with its arguments and result.
- **Sign**, a workflow operation: an HMAC-SHA256 with a secret as its key - a webhook's signature, or a pseudonym.
- **Dashboards warn** when a published widget's SQL never names `$USER` and reads a table some viewing role may read only some rows of.
- The sign-in page shows and hides the password.

## 0.1.0-beta.3 - 2026-10-21

0.1.0-beta.2 was tagged but never published as an image; its changes are here.

### Highlights

- **Two-factor authentication** with any authenticator app, recovery codes, and an instance setting to require it for administrators or everyone.
- **Backups** built in, scheduled to the local disk or S3, and `totalbase restore`.
- **Several server processes** behind a load balancer, with no extra infrastructure.
- **S3-compatible file storage**, many-to-many links in DataViews, and single dashboard widgets you can embed.

## 0.1.0-beta.1 - 2026-10-18

The first beta: from your PostgreSQL database to APIs, screens, dashboards and automations.

- A REST **Data API** over the tables, views and functions you expose - filters, relations, aggregates, nested writes, transactions - with a generated OpenAPI document.
- **Users, roles and permissions** down to rows and fields: row filters, field grants, payload checks.
- **DataViews**: tables, cards, kanban, calendar, Gantt, map, tree and org chart, forms, master-detail and custom pages, in an App for desktop, tablet and phone.
- **Dashboards** from SQL queries, embeddable in other sites.
- **Workflows** on a data change, a schedule, a webhook or a person.
- An **audit log**, and an **MCP server** at `/mcp` for AI agents.
