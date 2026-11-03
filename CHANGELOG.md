# Changelog

What changes from one TotalBase version to the next: what's new, and what an upgrade asks of you. Each version's section is also its [GitHub release](https://github.com/totalbase-io/totalbase/releases)'s notes (`scripts/release-notes.sh`). The step-by-step upgrade guide is in the [documentation](https://docs.totalbase.io/operations/upgrading).

## 0.1.0-beta.12 - 2026-11-03

### Highlights

- **The standalone App.** **App shell: Standalone** (Arrange menu › Menu settings) takes the rail away for everyone who is not an administrator: the App menu is the only sidebar, your logo and name at its head as **Menu header** says, the signed-in user at its foot with the account menu the rail had. Administrators always keep the rail, and **See as** shows the App as a user gets it.
- **Modules in the menu.** Standalone, the App menu holds the admin's own screens too - **Users**, **Roles**, **Files**, **Templates** and **Logs** -, a switch each in the menu's settings, each once, with a label and an icon of its own. A viewer sees a module by the rail's rule - READ on its table - never by a grant; while its screen is open, its own panel (Users' **Invite**, the roles tree, the log filters) shows under the menu. The MCP server's `get_app_menu` and `set_app_menu` carry the modules, the shell and the menu header.
- **The menu's settings beside the tree.** Arrange menu's settings move to a column to the right of the tree (behind ⚙ on a phone or a tablet): a short line under each label and a "?" with the full text, the display as a segmented control, the shell as cards, the rest as icon radios and switches. Every change applies at once.
- **A date range to the minute.** A dashboard's **Date range** variable takes a **Precision**: **Day** (the default) or **Minute**, so a custom range is two dates or two times of day in the viewer's time zone - *between 22:30 last night and 09:00 today*. The widgets' SQL never changes (`$VAR.period.from` and `.to` stay `timestamptz`), and every value a day range accepted stays valid: a date alone still means the whole day.
- **One range picker.** In the bar, a date range is one button reading the range in effect - a preset's name or the custom range in the viewer's regional format, what `{{vars.period.label}}` shows too. It opens the quick ranges beside the custom range: both bounds typed or picked on a calendar, **Apply**, and at its foot the time zone the times are read in. A drawer on a phone.
- **Which time zone ran.** Every dashboard run answers which time zone the query ran in and where it came from (the request, the user's preference, the instance, PostgreSQL's own), and the editor says it under the bar - a warning when PostgreSQL's own did.
- **A time zone as PostgreSQL names it.** A browser reports some twenty zones under IANA's older alias (`America/Buenos_Aires`, `Asia/Calcutta`, `Europe/Kiev`), which the official images' PostgreSQL doesn't know, so the zone was dropped in silence and a widget's SQL ran in UTC under a grid shown in the viewer's zone. The header, a user's preference and **Timezone** in Settings › General now resolve to PostgreSQL's own name.
- **Descriptions on a dashboard.** A variable's **Description** shows behind an ⓘ beside its label, a widget's beside its title; the dashboard's **Show descriptions** (Settings › General) decides whether viewers see them - off, they stay as documentation for the editor and the agent. The App header's auto-refresh is a short badge ("1 min", the sentence and "Updated 2 min ago" in its tooltip) beside an icon-only **Refresh**.
- **The admin says which version it runs.** Settings › General ends with **About this instance** - TotalBase's version, the environment, PostgreSQL's version and the database, from the new `GET /admin/api/system` (administrators only) - and the account menu carries the version under the email. Nothing of it is public.
- **A guessed address lands somewhere.** `/admin` redirects to the root, where the sign-in is; a mistyped address or an old bookmark gets the admin's own *Page not found*, in the UI's language, with a button to the home or the sign-in, instead of Nuxt's generic error page.
- **A warning when `CREATE TABLE` would land in the reserved schema.** The server warns at start when the connection role's `current_schema()` is `totalbase` - a role named `totalbase` with PostgreSQL's default `search_path` -, since a `CREATE` without a schema name in the SQL Console would land there, unseen by the catalog. The installation guide's role setup now sets the role's `search_path` to `public`.
- **A workflow's `revision` is checked.** A draft, publish, restore or PATCH with a non-integer `revision` answers 400 `INVALID_QUERY` on the four routes; two of them passed it straight to PostgreSQL. The Admin API reference says where a workflow's revision and a resource's or a user's id come from, and `DashboardVariable.default`'s real shape.
- **For scripts and agents**: an HTTP request step's Basic authentication (the whole `Basic <base64>` value as a secret header) and a Schedule trigger's **Execute as** are documented where the pages left them out.

### Before you upgrade

- **Two migrations apply on start**, on the `totalbase` schema only: `totalbase.menus` gets a `module` column and the `MODULE` kind, `totalbase.dashboards` gets `show_descriptions` (on by default). Nothing changes in what people see until you set the App's shell or add a module.
- **An Admin API change**: a workflow's draft, publish, restore and PATCH refuse a non-integer `revision` with 400 `INVALID_QUERY` (two of them answered a PostgreSQL error before). `GET /admin/api/auth/me` carries `app` (the shell and the menu header) and `version`.
- **A time zone is applied as PostgreSQL names it**: an instance's or a user's zone stored under IANA's alias (`America/Buenos_Aires`) runs as PostgreSQL's name (`America/Argentina/Buenos_Aires`), the same offset, where it was dropped before.

## 0.1.0-beta.11 - 2026-10-31

### Highlights

- **Columns, a new layout widget for the Design form.** Drop it and the row has three columns of equal width, each an area of its own, named in **Structure**: a photo in one, fields stacked in the next, buttons in the last - no Boxes to size by hand. **Columns** in the inspector adds, removes and reorders them and sets each one's **Width** in the row's 12 columns. A phone stacks them. The palette now starts with **Layout**, the group a page begins with.
- **A widget's width is its nature.** A button, a badge, an icon, an avatar, a switch, a checkbox, a QR code, a PIN, a rating, a menu, a Camera and a Location are placed at **Fit content**: their own width, beside what precedes them - two buttons dropped one after the other sit side by side, no widths to set. Everything else fills its columns: an input dropped on a page now takes the whole of its cell instead of stopping at its own width. The "⋮" offers **Fit content** where it applies; dragging a fitting widget's edge gives it columns. On a phone the widgets that fill stack, the fitting ones stay in line.
- **A Modal's, a Slideover's, a Drawer's and a Card's footer gathers its buttons at the right**, on the canvas and in the App, instead of one under the other.
- **An Editor fills its box.** A rich-text Editor on a page stopped at its content's minimum height - a short editor in a tall box - whatever its **Height** or **Fill height** said; it now stretches to its box, so Fill height takes it to the bottom of the page, in a tab too.
- **An upload area in the theme's looks.** The File upload widget's **Variant** adds **soft** and **subtle** beside area and button: the drop area in its **Color**'s tint, without or with a border, like an input or a badge - a photo field that sits quietly in its card, no CSS classes.
- **The Design form notices a draft changed elsewhere.** With a page open in the Design form, a draft rewritten in another session - an AI agent rebuilding it by MCP, another tab - shows a warning above the canvas, with when, and **Reload**, instead of a *Field not found* error on the next save. A DataView's `updatedAt` is now its draft's revision: every write of a widget or a column moves it (a trigger, migration 000015).
- **One spacing scale.** Style's named sizes mean the same for a margin and a padding - XS 4, S 8, M 16, L 24, XL 32 px - and the inspector, the documentation and the agent's guides say how many pixels each one is. A margin at L or XL was 32 or 48 px before: a page using them gets a tighter margin until you pick another size.
- **A list to a `jsonb` argument.** A function called with a list of objects for a `json`/`jsonb` parameter - through the Data API, a page's Call or a workflow's Execute function step - now receives it as JSON. It reached PostgreSQL as an array literal before, refused with *invalid input syntax for type json*, and an empty list arrived as `{}`.
- **What a JavaScript step can use is written down**, in the step's documentation and the agent's guide: JavaScript's own library, `Intl` included, and now `URLSearchParams` to build a query string for an HTTP step. The agent's pages guide also says how a table, an editor or a map gets its height.
- **A button's Full width fills its row.** With **Full width** on, a button at Fit content takes the whole row - and its columns when given some - instead of staying its own size; it stacks on a phone like any widget that fills.
- **A field with a switch is as tall as one with an input.** A form field's input row is an input's height whatever it holds, a Switch or a Checkbox centered in it, so the fields of two side-by-side columns stay level instead of drifting a few pixels per field.
- **Text in the Style tab.** A widget's text gets its size on the theme's scale, its weight, italics, underline or strike-through, and a color of the theme's - the grays (muted to highlighted) and the meanings (primary to error) - from the Style tab, like its spacing and background: a bold Text, a muted Heading, a larger total, with no CSS classes. It cascades to what a Box or a Card holds.
- **An AI agent finds the Style props from the pages guide.** The guide lists them with their values, says where each one goes (a margin on the widget, Align on a container to place its buttons, Vertical align beside a taller widget) and gives three recipes - a button beside a field, a block centered in its column, a button at the right outside a footer - so the agent no longer reaches for CSS classes. The guide also tells it to look at the page it built when it has a browser - signed in, as the role that will use it through **See as** (nothing saved), on a desktop and a phone, each tab and each window - and each widget's box now carries `data-widget` and `data-name` so it finds a widget by its **Name**. A page widget whose CSS classes carry what Style has (`mt-6`, `text-center`) shows under the DataView's warnings as worth knowing, and in `check_app`.
- **A hidden column shown from the Columns menu now appears in the grid**, with its total and its conditional formatting. A column the DataView hides is only hidden by default: the viewer's own choice in **Columns** (a column ticked, **All**) wins, as the documentation already said. An embed whose own columns list a hidden one shows it too.

### Before you upgrade

- **Three migrations apply on start.** Every placed button, badge, icon, avatar, switch, checkbox, QR code, PIN, rating, menu, popover, tooltip, camera and location left at the default width is set to Fit content; one you sized yourself keeps its columns. A published page keeps its layout until you publish again - its DataView shows **Unpublished changes** once. The third adds a trigger on `totalbase.dataviews_fields` that moves a DataView's `updated_at` with every widget write - its draft's revision from now on.
- **Style's spacing changes size at L and XL.** Margin and padding now share one scale - XS 4, S 8, M 16, L 24, XL 32 px. A margin set to L or XL was 32 or 48 px: a page using them gets a tighter margin until you pick another size, or **Custom** for the exact step.
- **A function's `json`/`jsonb` argument** receives a list as JSON now, not as a PostgreSQL array: a call that worked around it by wrapping a list in an object can send the list itself.

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
