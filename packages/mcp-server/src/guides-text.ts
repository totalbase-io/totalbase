import { COLUMN_INPUT_KEYS, COLUMN_INPUTS, DASHBOARD_DECISION_CODES, DATAVIEW_FEATURE_KEYS, DEFAULT_WIDGETS, dashboardWidgetDefinition, DASHBOARD_WIDGET_CARD_PROPS, DASHBOARD_WIDGET_GROUPS, DASHBOARD_WIDGET_TYPES, widgetDefinition, type DashboardRole, type DashboardValueKind, type DashboardWidgetProp } from "@totalbase/tb-catalog";
import { pagePropLine } from "./guides-pages.js";

/**
 * The guides' text (Administration.md §11.4). Whatever the code
 * already knows - DataView features, a column's default widget, every
 * dashboard widget type - is generated from the same catalog the server
 * validates against, so it can't drift; the rest restates the specification
 * for an agent, citing nothing it can't act on.
 */

export const INSTRUCTIONS = `TotalBase exposes a PostgreSQL database as an API, screens (DataViews), dashboards and workflows, with roles and permissions - and PostgreSQL stays the authority: constraints, types and errors are its own. You act as an administrator through this token: everything you do is authorized, validated and audited by TotalBase like any other caller.

How things fit together:
- Model in PostgreSQL first, with real constraints (create_table / alter_table; totalbase://guide/modeling). Files and images are a uuid foreign key to totalbase.files, never bytea (totalbase://guide/files).
- A table is reachable through the Data API only for the methods it exposes (expose_resource), and only for roles granted an action on it (grant_permission). A grant names its fields - there is no "all columns" wildcard - and may carry a row filter ({"owner":{"_eq":"$USER.id"}}) and payload checks. No grant means denied; any DENY wins. Check with get_permissions (totalbase://guide/permissions).
- Records are read and written with query_records / write_records - the application's tables and TotalBase's own (schema "totalbase": roles, users_roles, folders, ... - totalbase://guide/totalbase-tables). Users are created with create_user (a password or an invitation), never as bare rows.
- Make screens read well: set_column_presentation (labels, the labels and colors of a status's values) and set_row_presentation (how a referenced row shows - a customer by its name, not its uuid) before building DataViews.
- A screen that isn't a list or a form of one table - a point of sale, a registration with a check before saving, a search screen - is a CUSTOM page: create_dataview CUSTOM, then set_page_variables, add_page_widgets, save_page_code (totalbase://guide/pages).
- DataViews (create_dataview), dashboards (create_dashboard, save_widget) and workflows (create_workflow, save_workflow) are drafts: nobody but administrators sees or runs them until published (publish_dataview, publish_dashboard, publish_workflow) with the roles that may use them. A DataView never grants data - its roles also need the table's permissions; get_dataview shows what each one may do. Published and listed, DataViews and dashboards join the App menu.
- Email and PDF templates: save_template, test_template. The App menu's groups and order: set_app_menu.
- Read before you change: describe_table, get_dataview, get_dashboard, get_workflow, get_page. Try before you save: preview_query (widget SQL), run_workflow mode=test, alter_table preview=true.
- Views, functions, triggers and types: execute_sql (raw SQL, only when an administrator allowed API tokens in Settings > SQL Console - otherwise SQL_CONSOLE_DISABLED: tell the user). Tables still go through create_table / alter_table, rows through write_records (permissions, audit and events apply there, not to raw SQL).
- The API's own contract: get_openapi - the Data API as a role sees it, or the Admin API.
- Errors are TotalBase's CODE: message, PostgreSQL's when it decided (totalbase://guide/errors), most ending with "- fix:" and the tool that fixes it: fix the cause, don't retry blindly. Destructive calls need confirm=true - ask the user first.

Guides (read the ones your task touches): totalbase://guide/build (the order of things), modeling, permissions, data-api, totalbase-tables, files, dataviews, pages, widgets, dashboards, pdf-templates, workflows, errors.`;

export const BUILD = `# Building an application on TotalBase

A checklist, in order: each step says what to call and when it is done. Don't start a step before the previous one's "done when" holds - a later step relies on it.

- [ ] **1. Model** (totalbase://guide/modeling) - create_schema for a module that deserves its own (optional), then create_table per table with every column, the primary key, foreign keys, UNIQUE and CHECK in one call; referenced tables first. Files and images are a uuid foreign key to totalbase.files (totalbase://guide/files). Change a table later with alter_table (an ordered list, all or none) after describe_table. Views, functions and triggers: execute_sql - off for tokens until an administrator turns on Settings > SQL Console > Allow API tokens (SQL_CONSOLE_DISABLED until then: ask them).
  Done when: describe_table shows every table with its keys and constraints.
- [ ] **2. Expose** - create_table's expose_methods, or expose_resource: GET, POST, PATCH, DELETE (a view: GET; a function: POST).
  Done when: list_resources shows each table with the methods its screens need.
- [ ] **3. Present** - set_row_presentation on every table others point at (customers by name), set_column_presentations for labels, help and each status value's label and color - every column of a table in one call.
  Done when: every table a foreign key points at has a row presentation - otherwise screens show ids.
- [ ] **4. Roles** - a role is a row of totalbase.roles (write_records: name, description, app_access=true for people who use the App, api_access=true for API tokens). list_roles shows the existing ones.
  Done when: list_roles shows one role per kind of person.
- [ ] **5. Grants** (totalbase://guide/permissions) - grant_permissions for many at once (roles x tables x actions in one call), grant_permission for one: READ to see, CREATE / UPDATE / DELETE to change, EXECUTE for a function; fields default to every column of a new grant; a row filter restricts rows ({"owner":{"_eq":"$USER.id"}}). Every App role also gets apply_default_permissions (its own account, files, folders).
  Done when: get_permissions shows, per role, READ on every table its screens read - including the tables its foreign keys point at - and the writes it makes.
- [ ] **6. Users** - create_user with roles: a password (ready to sign in) or an invitation ('email' or 'link'). set_user_roles replaces a user's roles.
  Done when: each role has at least one user to try it with.
- [ ] **7. Records** - write_records (a list is all or nothing; "$<child_table>" nests child rows) and query_records.
  Done when: query_records returns the sample data on every table.
- [ ] **8. DataViews** (totalbase://guide/dataviews) - create_dataview over each table users work with, of the type that fits the data; update_dataview for its settings and fields; publish_dataview with the roles that open it. A tailored screen is a CUSTOM page (totalbase://guide/pages): set_page_variables, add_page_widgets, save_page_code, get_page.
  Done when: each is published with its roles, and check_app dataview=<slug> lists no warning.
- [ ] **9. Dashboards** (totalbase://guide/dashboards) - create_dashboard, update_dashboard for $VAR filters, preview_query then save_widget per chart (or apply_dashboard: the whole draft in one call), publish_dashboard with the roles that may view it.
  Done when: every widget's preview_query returns rows, and each dashboard is published with its roles.
- [ ] **10. Templates** - email (MAILING) and PDF templates a workflow sends or renders: save_template, test_template (a PDF without the designer: totalbase://guide/pdf-templates).
  Done when: test_template renders each with sample data.
- [ ] **11. Workflows** (totalbase://guide/workflows) - create_workflow with its trigger, save_workflow with its steps, run_workflow mode=test, publish_workflow (enabled, role_ids); set_workflow_enabled turns one on or off.
  Done when: each test run ends COMPLETED and each is published.
- [ ] **12. The App menu** - a published, LISTED DataView or dashboard is added at the end of the menu by itself; set_app_menu arranges it in groups (get_app_menu shows it).
  Done when: get_app_menu shows the groups in the order people work.
- [ ] **13. Check** - check_app: what still stops a DataView or a dashboard from working, and for whom (no READ for a role, an id where a row should show, a variable refused). Fix each warning with the tool its message names; an info is often intended.
  Done when: check_app answers warnings: 0.

Report what you built: tables, roles and their grants, users, DataViews, dashboards and workflows with their slugs, and which roles see what. Everything is audited under this token (Logs).`;

/** The value kind of a PostgreSQL type, and the widget a DataView gives it by default. */
const VALUE_KINDS: [kind: keyof typeof DEFAULT_WIDGETS, types: string][] = [
  ["text", "text, varchar(n), citext"],
  ["number", "integer, bigint, smallint, numeric(p,s), real, double precision"],
  ["boolean", "boolean"],
  ["date", "date"],
  ["time", "time"],
  ["timestamp", "timestamptz (prefer it to timestamp)"],
  ["json", "jsonb, json"],
  ["point", "point (x = longitude, y = latitude)"],
  ["array", "text[], integer[], ..."],
  ["relation", "a foreign key to another table"],
  ["file", "a uuid foreign key to totalbase.files"],
];

export const MODELING = `# Modeling tables

PostgreSQL is the authority: model rules as constraints (NOT NULL, UNIQUE, CHECK, FOREIGN KEY), which hold for every writer - the App, the API, a workflow, a script - never as conventions the application must remember.

## Names
- Tables plural and snake_case (customers, order_lines); columns singular (name, due_at).
- A foreign key column named after what it points to - customer, not customer_id - reads better as a field label; the column's label can be set either way (set_column_presentation).
- A schema per module only when it helps (sales, hr); public is fine. TotalBase's own tables live in schema totalbase - don't create tables there.

## Keys and housekeeping columns
- Primary key: {"name":"id","data_type":"uuid","primary_key":true,"default":"gen_random_uuid()"} (or a bigint identity).
- A number PostgreSQL gives each row (an order number people read): {"name":"numero","data_type":"bigint","identity":"ALWAYS","nullable":false,"unique":true} - no sequence to create. A value computed from the row: {"name":"importe","data_type":"numeric(14,2)","generated":"cantidad * precio"} - never written, always right. Partitioning (PARTITION BY) is execute_sql.
- A constraint's message goes with it: "check_message", "unique_message", foreign_key "message" - what a user reads when a write breaks it.
- Created: {"name":"created_at","data_type":"timestamptz","nullable":false,"default":"now()"}.
- Who created it: {"name":"owner","data_type":"uuid","nullable":true,"default":"NULLIF(current_setting('totalbase.actor_user_id', true), '')::uuid","foreign_key":{"references_schema":"totalbase","references_table":"users","on_delete":"SET NULL"}} - every Data API write sets totalbase.actor_user_id to the caller; leave owner out of the CREATE grant's fields so nobody writes someone else's, and use {"owner":{"_eq":"$USER.id"}} as a row filter for "their own rows".
- updated_at needs a trigger (execute_sql: a BEFORE UPDATE trigger setting NEW.updated_at = now()).

## Types and how DataViews show them
| Value kind | PostgreSQL types | Default widget |
|---|---|---|
${VALUE_KINDS.map(([kind, types]) => `| ${kind} | ${types} | ${DEFAULT_WIDGETS[kind]} |`).join("\n")}

## Column controls (set_column_presentation input)
A column's control is an entry of the column input catalog - what every form edits it with, until a form picks its own. Unset, Automatic: by its type and constraints (describe_table says which and why). Add Column creates the column from an entry (create_table and alter_table create plain columns - set the input afterwards when the rule's isn't the one).
| input | Control | Widget |
|---|---|---|
${COLUMN_INPUT_KEYS.map((key) => `| ${key} | ${COLUMN_INPUTS[key].label} - ${COLUMN_INPUTS[key].description} | ${COLUMN_INPUTS[key].widget}${COLUMN_INPUTS[key].props ? ` ${JSON.stringify(COLUMN_INPUTS[key].props)}` : ""} |`).join("\n")}
A foreign key always wins over the type (relation-search, relation-select; file, photo, signature to files); a choice entry needs a CHECK IN list; password is chosen only when the column is created - its values are hashed and never read.

- Money and quantities: numeric(12,2), never real/double (rounding).
- Dates: date for a day (birthday, due date), timestamptz for an instant (created, scheduled).
- Long text: text (a field's widget can be UTextarea or a rich text editor - update_dataview).
- Several values: text[] for free tags; a junction table (two foreign keys, UNIQUE together) for a many-to-many between rows.
- A location: one point column, or two numeric columns latitude and longitude (both work for MAP DataViews). Through the Data API a point is written and read as {"lng": -58.38, "lat": -34.6} - never PostgreSQL's "(x,y)" text.
- Types with no input of their own in the App - ranges (tstzrange, daterange), interval, inet, money - are edited as plain text in PostgreSQL's literal form ('[2026-01-01,2026-02-01)'); describe_table marks them (editedAs). Prefer two columns (starts_at, ends_at with a CHECK) for what people type, a range for what the database computes or constrains (EXCLUDE).

## Choices
- A small fixed set (a status, a priority): text NOT NULL with CHECK (status IN ('OPEN','WON','LOST')) and a DEFAULT - DataViews show it as a select. Uppercase values; give each a label and color with set_column_presentation options.
- A set users manage, or that carries data of its own (stages with an order and a color, categories): a lookup table and a foreign key, with set_row_presentation on the lookup table. KANBAN lanes are either: a foreign key (one lane per row of the target, its order and color from columns of it) or a CHECK list (one lane per value, in the CHECK's order, labels and colors from set_column_presentation options). GANTT swimlanes must be a foreign key.

## Settings - a parameter table
A table of the system's parameters - one row per setting - is shown by a SETTINGS DataView: id, clave text NOT NULL UNIQUE (the key code reads), titulo text NOT NULL, descripcion text NOT NULL, grupo text (a section), orden integer (one numbering across groups - sections follow their first setting, so 1-3 Facturación, 4-5 Inventario puts Facturación first), valor jsonb NOT NULL (its JSON type picks the control: number, boolean, a "YYYY-MM-DD" date, text). Validate valor in a trigger by clave, raising a clear message - it shows under the setting. Grant UPDATE on valor only (fields: ["valor"]); no CREATE or DELETE - the rows come with the installation (insert them with write_records or a migration).

## Relations
- One-to-many: the foreign key on the "many" side (order_lines.order -> orders). on_delete CASCADE for rows owned by the parent (lines of an order), SET NULL for an optional link, RESTRICT to forbid deleting what is still referenced.
- Index the foreign key columns you filter by (alter_table create_index); PostgreSQL doesn't index them by itself.
- A row's children can be created with it in one write ("$order_lines": [...] - totalbase://guide/data-api).

## Validation
- Prefer a CHECK (global: every writer) to a payload check (one role's writes through TotalBase only - totalbase://guide/permissions).
- Text length: CHECK (length(name) <= 120); a format: CHECK (email ~* '^[^@]+@[^@]+\\.[^@]+$').
- A rule over several columns: CHECK (ends_at > starts_at). A rule over other rows: a trigger (execute_sql) raising an exception - its message reaches the user as is.
- Give every CHECK, UNIQUE and FOREIGN KEY a message - what a user reads under the field when a write breaks it ('The CUIT goes with hyphens: 30-12345678-9'), instead of PostgreSQL's 'violates check constraint ...': add_check's message, or alter_table set_constraint_message {name, message} for one that exists (an inline column CHECK too - describe_table lists each with its message). A domain's CHECK (CREATE DOMAIN cuit AS text CHECK (...)) is the domain's, not a table's: execute_sql COMMENT ON CONSTRAINT <name> ON DOMAIN <schema>.<domain> IS '<message>'. A domain column reads as its base type (describe_table: type text, domain cuit) and is edited as one.
- Existing rows must satisfy a constraint added later, or alter_table fails (all or none).`;

export const PERMISSIONS = `# Permissions

Two levels: **data permissions** decide which rows and columns a role may read, create, update, delete or execute; **object access** decides which roles may open a published DataView or dashboard, or invoke a workflow. Object access never grants data. Administrators (this token) bypass both.

## Roles
- totalbase.roles rows (write_records): name, description, app_access (sign into the App; default true), api_access (obtain API tokens; default false), active (an inactive role grants nothing). admin_access and reserved are TotalBase's own (leave them out, or false).
- A user's roles: create_user role_ids, set_user_roles, or one users_roles row {user, role}. Every role's grants combine.

## Grants - grant_permission (role, table, action)
- Actions: TABLE CREATE / READ / UPDATE / DELETE; VIEW READ; FUNCTION EXECUTE.
- Precedence across a user's roles: any DENY wins, else any ALLOW, else denied (no grant = denied). A DENY grant refuses the action whatever other roles say.
- The table must be exposed for the method too (expose_resource): exposure is the ceiling, grants decide below it.

## Fields - no wildcard
- Every column a request selects, filters, sorts, searches or writes must be granted (FIELD_PERMISSION_DENIED otherwise). grant_permission grants every current column of a new grant unless fields lists some; a column added later must be granted then (fields: 'all' again, or the list). For CREATE/UPDATE every column means the ones a writer fills: generated and identity columns, a primary key with a default, the owner column defaulting to the writer and a creation time are left out (the answer's warning lists them) - name one in fields to grant it.
- A relation is a field of the root table's grant: 'customer.name' lets readers of orders see each order's customer name - without any grant on customers.
- A reference column shows its row by the target's row presentation ('customer.name', or each column of its template): READ fields 'all' grants those paths too; a list must name them, or the App shows the key - grant_permission warns, get_dataview lists rolesMissingRelatedColumns and publish_dataview warns. A row filter may follow a relation ({'invoice.seller': {'_eq': '$USER.id'}} - no field grant needed), on writes too: CREATE, UPDATE and DELETE check it through the foreign keys of the row written. A request's own where on a write names the table's own columns only.
- deny_fields refuses columns even when another role allows them (salary for everyone but HR).
- Protected columns (password and token hashes, storage keys, log SQL) are never readable or writable.

## Row filters - where
- The filter grammar of totalbase://guide/data-api, with $USER.<column> = the caller's own users row (custom columns too: {"branch":{"_eq":"$USER.branch"}}).
- ALLOW filters of several roles OR-combine (a user sees the union); a request's own where narrows within them, never widens.
- CREATE checks the new row, UPDATE the row before and after (a user can't move a row out of their own scope), DELETE the row before.
- Typical: own rows {"owner":{"_eq":"$USER.id"}}; one branch {"branch":{"_eq":"$USER.branch"}}; open items {"status":{"_neq":"CLOSED"}}.

## Payload checks
- Rules the written values must satisfy, per role, CREATE / UPDATE: {"rule":{"discount":{"_lte":"20"}},"label":"Sales may give at most 20% off"}. Every check must hold (PAYLOAD_CHECK_FAILED with the labels).
- They apply to that role's writes through TotalBase only; a rule for everyone belongs in a CHECK constraint.

## Capabilities - set_capability
- TRANSACTIONS: may submit multi-step Data API transactions. SEND_EMAIL: may run a workflow's Send email step.

## App users
- apply_default_permissions on every role people sign into the App with: their own account and sessions, files and folders (changing only their own), templates and roles to read. It never replaces a grant the role already has on those tables (listed in its answer as kept), so a broader one - READ on every user for a user manager - stays.
- A DataView's roles need READ on its source (plus CREATE / UPDATE / DELETE for what they may change) and READ on files wherever it shows a file column. get_dataview lists what each of its roles may do.
- A dashboard's viewers see its widgets' data whatever their grants: its SQL runs with the dashboard's authority. Publish it only to roles that may see all of it, or filter its SQL by $USER.*.

## Many at once
- grant_permissions: role_ids × grants [{schema, name, actions: [...], where?, fields?, deny_fields?, payload_checks?}] in one call - an application's whole access in a few calls.
- Removing: revoke_permission (one grant); deleting a role (write_records delete on roles) takes its grants and assignments with it.

## Delegated administration - several organizations in one instance
- A non-administrator manages people in the portal's Users and Roles modules (a role with app_access), through data permissions on TotalBase's own tables plus fixed guardrails - never permissions, never an administrator's account.
- Each organization's people: a column the project adds to users (organization) and, for the manager's role, grants on totalbase.users filtered {"organization":{"_eq":"$USER.organization"}} - READ and UPDATE to list, rename and deactivate, CREATE to invite (Invite user: the invitation is checked against the filter on the new row, the project's columns included). email, can_login and lock state stay administrator-only; links are emailed to the account, never returned.
- Roles: an administrator writes roles_managers rows {role, manager} (write_records) - members of the manager role may assign the managed one; CREATE / DELETE on users_roles filtered {"user.organization":{"_eq":"$USER.organization"}} keeps assignments to their own people. Reserved and admin_access roles are never assigned this way.
- Composing access: give each organization small roles (Visits - read, Visits - edit, Reports) its manager may assign; a person's grants are the union of their roles, so combining roles composes permissions without the manager ever writing one.

## Auditing reads
- Writes are audited by default. For a sensitive table or view, expose_resource audit_read=true: every Data API read then records who read, which fields, with which filter and how many rows came back - the key too for a read by key, never the rows; a read whose entry can't be written fails.

## Checking
- get_permissions role_id=... (a role alone) or user_id=... (everything a user's roles add up to): per table and action, the decision, the fields, the row filters and payload checks; schema + name alone: every role's grants on that table.
- get_openapi api='data' role_id=... - the API exactly as that role can call it.`;

export const DATA_API = `# Data API query language

Used by query_records and write_records, by permissions (row filters, payload checks), by workflows (Read / Update / Delete records, Condition) and by DataViews (base_where) - one grammar everywhere.

## Filters - a filter object

    {"status": {"_eq": "open"}, "total": {"_gte": "100"}}      siblings are AND-combined
    {"_or": [{"city": {"_eq": "Rosario"}}, {"vip": {"_eq": "true"}}]}
    {"_not": {"archived": {"_eq": "true"}}}
    {"customer.name": {"_ilike": "%acme%"}}                   a foreign key's row (relations, up to 3 hops)

| Operator | SQL |
|---|---|
| _eq _neq | = <> |
| _gt _gte _lt _lte | > >= < <= |
| _like _ilike | LIKE ILIKE (pattern with %) |
| _regex | ~ (POSIX) |
| _in _nin | = ANY / <> ALL - a list |
| _between | BETWEEN a AND b - two values |
| _null _nnull | IS NULL / IS NOT NULL (value: true) |
| _contains _contained_by _overlap | @> <@ && (arrays, jsonb) |

Values are text, a number or a boolean - "2026-10-05", 100, true; PostgreSQL casts each to its column's type. A list (_in, _nin, _between) is a JSON array, {"status": {"_in": ["OPEN","LATE"]}}, or the same values comma-joined, "OPEN,LATE" - the array when a value holds a comma.

Values a filter may use instead of a literal:
- $USER.<column> - the caller's own user row, e.g. {"owner": {"_eq": "$USER.id"}}
- $CURRENT_TIMESTAMP, $CURRENT_DATE, $CURRENT_TIME
- $INTERVAL.<n><unit> - "the last n": CURRENT_TIMESTAMP minus it; units s m h d w y, e.g. {"created_at": {"_gte": "$INTERVAL.7d"}}
- flags[<name>]=<filter> (reads) - which of these named filters each row meets, in meta.flags (one list of names per row, data's order); the rows aren't filtered by them: ?flags[low][stock][_lt]=$ROW.stock_minimo
- $ROW.<column> - another column of the same row, compared column to column: {"stock": {"_lt": "$ROW.stock_minimo"}}, {"pagado": {"_lt": "$ROW.total"}}; only a column of the same row (not a related one); in a permission's row filter or a payload check, the row the write leaves
- $PERIOD.<period>.from / .to - calendar bounds computed by PostgreSQL in the session time zone, from inclusive, to exclusive: today, yesterday, this_week, last_week, this_month, last_month, this_quarter, last_quarter, this_year, last_year - {"created_at": {"_gte": "$PERIOD.this_month.from", "_lt": "$PERIOD.this_month.to"}}

## Reading (query_records)
- fields: "id,name,customer.name" - dotted paths follow foreign keys; omitted, every column the caller may read
- search: free text, ILIKE over the readable text columns
- order_by: "name,-created_at" (- descending)
- limit (default 50, at most 500 here), offset; count: also the total
- aggregates [{fn: sum|count|avg|min|max, field, alias}] with group_by "status,customer.name" and having (a filter over group fields and aliases): the rows then hold only the groups and the aggregates - e.g. totals per status.

## Writing (write_records)
- create: one row or a list (bulk: one transaction, all or nothing). Foreign keys take the referenced row's id. Answers the created rows with their defaults.
- Nested create: a property "$<child_table>" holds the child rows, created in the same transaction with their foreign key filled in - {"customer": "...", "$order_lines": [{"product": "...", "quantity": 2}]}. The child table must be in the same schema, exposed for POST, with exactly one foreign key to the parent. Children may nest (depth 2 by default).
- on_conflict: {"target": ["code"], "action": "NOTHING"} skips rows that exist; {"target": ["code"], "action": "UPDATE", "data": {"price": "$INSERT.price"}} upserts. target is exactly a primary key or UNIQUE constraint's columns.
- update / delete: by id, or every row matching where (a where is required - an unfiltered update or delete is refused while api.require_where_for_update / _delete is on).
- Every write is authorized (row filter on the old and new row, fields, payload checks), checked by PostgreSQL, audited, and emits a data event (workflows with a DATA_EVENT trigger react to it).

## Functions (call_function)
- The function must be exposed for POST (expose_resource). Arguments by name; parameters with a DEFAULT may be left out. Needs EXECUTE (FUNCTION_EXECUTION_DENIED otherwise). Answers the value, or the rows of a set-returning function.

## The HTTP shape (for a developer or get_openapi)
- GET /api/{schema}/table/{name}?where[status][_eq]=open&fields=id,name&order_by=-created_at&limit=20&count=true
- GET /api/{schema}/table/{name}/{id}; POST / PATCH / DELETE the same paths with {"data": ...}; /view/{name} for a view; POST /api/{schema}/function/{name}.
- Responses {"data": ..., "meta": {"count": ...}}; errors {"errors": [{"code", "message", "source"}]}.
- Authentication: Authorization: Bearer <token> - a session or a personal access token (plane=API) acting as its owner.`;

export const FILES = `# Files, images and folders

TotalBase has its own file store: metadata in totalbase.files, content in storage. Never model a file as a bytea column (or a path / URL in text) - a database row is the wrong place for content, and nothing in TotalBase would show or serve it.

- **A file or image column** is a uuid foreign key to totalbase.files (id):

      {"name": "photo", "data_type": "uuid", "nullable": true,
       "foreign_key": {"references_schema": "totalbase", "references_table": "files", "on_delete": "SET NULL"}}

  DataViews show it as an image or a download and upload into it in their forms; dashboards and the Data API read it like any foreign key (photo.name, photo.mime_type).
- **Several files per row** (attachments): a table of its own with a foreign key to the row (on_delete CASCADE) and one to files - one row per file.
- **Uploading** is a multipart POST to /api/totalbase/table/files (the App's forms and the admin's Files page do it); the answer is the new row with its id. upload_file does it from here - the content as base64, or as text for an SVG or a CSV - with visibility PUBLIC for what anyone may see (an illustration a TImage shows) or PRIVATE. write_records updates or deletes a file's row by id (name, folder, description, visibility); query_records reads files. A workflow can create files (Create file, Generate PDF).
- **Reading metadata**: query_records on totalbase / files (name, mime_type, size_bytes, width, height, folder, tags, visibility PRIVATE or PUBLIC).
- **Folders** are rows of totalbase.folders: {name (32 characters at most, unique within its parent), parent (null = root)} - create them with write_records to organize a module's files (e.g. "Products", with "Photos" inside). A file's folder is its folder column. A folder that still holds files can't be deleted.
- **Access**: no special model - permissions on files and folders (grant_permission, row filters such as {"created_by": {"_eq": "$USER.id"}}) decide who reads, uploads, changes or deletes; apply_default_permissions gives an App role the usual ones. Give a role READ on files wherever it sees a DataView with a file column, and CREATE to upload. A PUBLIC file is readable by anyone with its link.`;

const featureRows = Object.entries(DATAVIEW_FEATURE_KEYS)
  .filter(([, keys]) => keys.length > 0)
  .map(([type, keys]) => `| ${type} | ${keys.join(", ")} |`)
  .join("\n");

export const DATAVIEWS = `# DataViews

A DataView is a screen of the App over one table or view (its source). Pick the type from the data:

| Type | Source | Use it for | create_dataview needs |
|---|---|---|---|
| TABLE | table or view | the default: a sortable, searchable grid; over a table, with a record form to create and edit rows | - |
| CARDS | table or view | rows with an image or a short text worth seeing (products, people) | view_config.card_layout optional |
| KANBAN | table or view | rows moving through stages (deals, tickets) | view_config.kanban_layout.groupColumn - a FOREIGN KEY column (one lane per row of its target, a stages table) or a column with a CHECK list (one lane per value, in the CHECK's order, labelled/colored/iconed by its presentation's options); never free text. readOnly: true - cards don't move |
| CALENDAR | table or view | rows on a date (appointments, due dates) | view_config.calendar_layout.dateColumn - one date or timestamptz column |
| GANTT | table or view | rows with a start and an end (projects, tasks) | view_config.gantt_layout {startDateColumn, endDateColumn} |
| TREE | table | a hierarchy - a table with a foreign key to itself (a chart of accounts, categories under categories, an org chart) | the self-referencing foreign key (found by itself; tree_layout.parentColumn when it has two). Offer a cycle guard: POST /admin/api/schema/{schema}/tables/{table}/cycle-guard through the admin UI's wizard (the DataView's Create offers it) |
| MAP | table or view | rows with a location (stores, visits) | view_config.map_layout: pointColumn (a point column) or latitudeColumn and longitudeColumn (two numeric columns) |
| FORM | table or view | one record at a time - data entry; a table's one row (a company's data: form_view_mode SINGLE) | - |
| SETTINGS | table or view | system parameters - one row per setting (key, value, title, description), edited in place like TotalBase's Settings; no New or Delete | view_config.settings_layout {keyColumn, valueColumn, titleColumn, descriptionColumn, groupColumn?, orderColumn?} |
| MASTER_DETAIL | table | a record with its lines entered together (an order and its items) | detail: {table, fk_column} - a table with a foreign key to the master |
| EXTERNALFRAME | none | an external https page inside the App | view_config.frame_url |

A view as source is read-only whatever the type.

The model comes first: KANBAN needs its stages as a foreign key to a table or a CHECK list, MASTER_DETAIL its lines as a table pointing at the master, MAP a point or two numeric columns - create them with create_table / alter_table before the DataView. CUSTOM pages (a blank page built from variables, widgets and code) are built with create_dataview view_type CUSTOM and the page tools - totalbase://guide/pages.

## Fields
- columns picks the source's columns, in order (all when omitted); a related column by path ('customer.city', read-only). Omitted, a list's json, jsonb and bytea columns come in hidden (visible false: read, in the record form, shown from the grid's Columns menu).
- Each field inherits its column's presentation (set_column_presentation: label, help, format, value labels and colors) and a foreign key shows its target's row presentation (set_row_presentation) - set both before creating the DataView.
- displayFormat (set_column_presentation): dates take a date-fns pattern ('dd/MM/yyyy', 'dd/MM/yyyy HH:mm'). Numbers: 0 a digit, # an optional one, ',' turns thousands grouping on, '.' then the decimals (0 always shown, # only when present); literal text around it, quoted or not; up to three sections positive;negative;zero. Examples: '#,##0.00' (1.234,50), '0' (an invoice number without separator: 3000), '$ #,##0.00' (money), 'CURRENCY:ARS' (the currency's own symbol and decimals), '0.0%' (a value already in percent: 25 shows 25,0% - % never multiplies), '#,##0.00;(#,##0.00);"-"' (accounting). Separators follow the instance's regional format (Settings > General, system.regional_format), else the viewer's browser regional settings - never the UI language.
- update_dataview fields: [{column, visible, widget, textWrap, maxLines, verticalAlign, width, minWidth, maxWidth}] - hide a column (visible false) rather than leaving it out when the form still needs it. get_dataview shows each column's cell.
- The grid's search covers every column of the DataView, shown or hidden: to find a row by a code without showing it, keep the column and hide it.

### A grid column's cell (update_dataview fields)
A cell is one line cut with … (the whole value on hover and in the record form), its column as wide as its content up to 320 px - a long text never pushes the grid sideways. A json/jsonb cell reads as its size ('{…} 12 keys', '[…] 3 items').
| Key | Values | Meaning |
|---|---|---|
| textWrap | truncate (default), wrap | wrap: several lines within the column's width. A viewer can switch it for themselves from the column's header menu (their preferences), over this |
| maxLines | 1-10 | with wrap: at most this many lines, then … ; unset: every line |
| verticalAlign | top, middle (default), bottom | where the content sits in a taller row |
| width, minWidth, maxWidth | 24-2000 px | width fixes the column; minWidth/maxWidth bound it; maxWidth unset is 320, or width when wider |
null unsets a key. A header's own width is its title's: a long title widens its column - give the column a shortLabel (set_column_presentation). Each header opens a menu: sort, filter by the column, hide, align left/center/right and one line or several (the viewer's own, over the column's), and Edit column… for an administrator. A viewer drags a header to reorder the columns and its edge to set its width - theirs, kept with their preferences and saved views, over width/minWidth/maxWidth.

### Secrets and documents
- A column holding a secret (a token, a password, a private key) doesn't belong in a grid: hide it or leave it out, and deny the field to the roles that must never read it (grant_permission fields) - hiding is presentation, a denied field is security. check_app flags a shown column whose name reads like one (SECRET_COLUMN_SHOWN, info).
- A view's uuid column that points at another table has no foreign key (a view carries no constraints), so it shows the id. Relations come only from real foreign keys: have the view return what to show too (JOIN the table and select its name or code - 'producto_nombre'), and hide the id column.

## view_config (create_dataview, update_dataview - shallow merge: a top-level key replaces its value)
| Key | Types | Values (default first) | Meaning |
|---|---|---|---|
| features | all | {key: false} turns one off | see below |
| base_where | list types, FORM | a filter object | rows the view shows (not a permission - the API still decides) |
| auto_refresh | list types | null, "10s", "30s", "1m", "5m", "15m" | re-reads its rows |
| default_state | list types | {columnPrefs: {col: {order}}, sort: "name,-created_at", density, pageSize, toolbarMode: full or compact} | what a viewer who hasn't chosen opens with - update_dataview sets column_order, default_sort and toolbar_mode in it; toolbarMode falls back to Settings > DataViews > Toolbar, then the type's (CARDS compact) |
| edit_presentation | list types | unset: PAGE past 10 form fields, else SIDEBAR · DRAWER, MODAL, SIDEBAR, PAGE | how a record form opens - its fields always in one column |
| edit_size | list types | lg, sm, md, xl | DRAWER / MODAL / SIDEBAR size |
| edit_side | list types | right, left, top, bottom | SIDEBAR side |
| column_sync | sourced | auto_show, auto_hide, locked | New table columns: what a column added to the table later does here, on its own within seconds - auto_show adds it shown and to the generated record form, auto_hide hidden and not to the form, locked not at all. Published with the draft |
| form_view_mode | FORM | READ, UPDATE, CREATE, SINGLE | how a FORM opens - SINGLE: the table's one row (settings-like), opened to edit, created on the first save, no New/search/browsing/copy/delete; publish_dataview warns when the table has more rows |
| open_with | MASTER_DETAIL | NEW_RECORD, WAIT | |
| new_record_label | MASTER_DETAIL | text | the New button |
| header_align | TABLE | left, center, right; null = Automatic | the column titles' alignment - Automatic (unset): each title as its column (a number's right, a text's left); left/center/right: every title so |
| list_margin | TABLE, CARDS, KANBAN, CALENDAR, GANTT, MAP | none, compact, normal; null = by type | the space around the list in the App - unset, a TABLE follows Settings > DataViews > Table margin (normal by default; none: the grid right under its header), the other lists normal |
| page_content_width / page_content_align | FORM, MASTER_DETAIL, a list type whose record opens on its page (edit_presentation PAGE), CUSTOM | narrow, wide, full / left, center, right; null = the instance's | how wide the page's content grows (a CUSTOM page: its body and pinned footer; its header widgets stay in the page header). Null or unset follows Settings > DataViews > Page width - dataviews.record_content_width (narrow) for record pages, dataviews.custom_content_width (full) for CUSTOM, dataviews.content_align (center). Convention: wide for a record of many fields, narrow for a one-step screen |
| allow | a DataView with a source | null, or some of create, update, delete | what its viewers may do besides reading - only less than their permissions (a history listing with no New: ["update"] or []) |
| layouts | list types | null, or a list of TABLE, CARDS, MAP, KANBAN, CALENDAR, GANTT, TREE in order, view_type among them | the views a viewer switches between (toolbar); each needs its own *_layout below, whatever the view_type - Sucursales: ["TABLE", "MAP", "CARDS"] with map_layout and card_layout |
| card_layout | CARDS | {titleFormula, descriptionFormula, imageFormula, imageAspect, imageFit, imagePosition} | formulas over the row: "{{name}}", "CONCATENATE({{first_name}}, \\" \\", {{last_name}})"; the image: imageAspect original/1:1/3:4/4:3/16:9 (unset a 16:9 band), imageFit cover/contain, imagePosition center/top - a portrait photo: "3:4", "cover", "top" |
| kanban_layout | KANBAN | {groupColumn, titleFormula, descriptionFormula, imageFormula, laneOrder, laneOrderColumn, laneColorColumn, readOnly} | a foreign key's lanes come from its target table, ordered by laneOrderColumn of it, colored by laneColorColumn; a CHECK list's are its values (laneOrder may reorder them); readOnly keeps cards in place |
| calendar_layout | CALENDAR | {dateColumn, titleFormula, descriptionFormula, colorFormula, defaultColor, weekStartsOn 0-6, defaultView month/week/day/agenda} | |
| tree_layout | TREE | {parentColumn (a foreign key to its own table), titleFormula, descriptionFormula, iconFormula, colorFormula, imageFormula, orderColumn (a number - siblings in its order, renumbered when one is dragged), defaultDisplay tree/org, expandLevel (levels open on load, default 1)} | a node's "+" adds a child, a drag moves it under another (an UPDATE of parentColumn - never under itself) |
| gantt_layout | GANTT | {startDateColumn, endDateColumn, groupColumn (a foreign key, optional), titleFormula, colorFormula, progressColumn (0-100), defaultZoom day/week/month} | |
| map_layout, map_view | MAP | {pointColumn} or {latitudeColumn, longitudeColumn}, plus nameFormula, descriptionFormula, colorFormula; map_view {centerLat, centerLng, zoom} | |
| frame_url | EXTERNALFRAME | an https URL, not TotalBase's own | |
| kiosk | CUSTOM | false, true | the page alone in the App, filling the screen - no menu, no page header - for a totem or a phone used as a reader; a corner "⋮" enters full screen (an administrator leaves the kiosk view there); a notice covers it while offline or the server is unreachable. Online only (totalbase://guide/pages: the kiosk recipe) |

## Features (view_config.features: every one defaults to on)
| Type | Keys |
|---|---|
${featureRows}

## Access
A DataView never grants data: the roles it is published for also need the source's permissions (grant_permission) - READ to open it at all, CREATE / UPDATE / DELETE to change rows - and READ on files for file columns. get_dataview lists, per role, what it may do on the source.`;

const KIND_TEXT: Record<DashboardValueKind, string> = { number: "number", time: "date/time", category: "category", point: "point", file: "file" };

/** One role as the guide reads it: `values (number · 1 or more · default: every number column)`. */
function roleLine(id: string, role: DashboardRole): string {
  const kinds = role.accepts.map((k) => KIND_TEXT[k]).join(" or ");
  const manual = role.manual?.length ? `${kinds ? "; " : ""}by hand also ${role.manual.map((k) => KIND_TEXT[k]).join(" or ")}` : "";
  const count = `${role.required ? (role.multiple ? "1 or more" : "1") : role.multiple ? "0 or more" : "0-1"}`;
  const fallback = role.default === "first" ? "the first matching column" : role.default === "all" ? "every matching column" : "none";
  return `- roles.${id} (${kinds}${manual} · ${count} · default: ${fallback}) - ${role.description}`;
}

/** One prop as the guide reads it, with what unset means. */
/** apply_dashboard's example: four widgets with a period, a list from a table, a tab and a click (DM2). */
const DASHBOARD_SPEC_EXAMPLE = JSON.stringify({"name": "Sales", "description": "Billing by branch", "variables": [{"name": "period", "label": "Period", "type": "DATE_RANGE", "default": {"source": "constant", "value": "last_30_days"}}, {"name": "branch", "label": "Branch", "type": "SELECT", "options": {"source": "TABLE", "resource": "<branches resource id>"}}], "tabs": [{"value": "general", "label": "General"}, {"value": "detail", "label": "Detail"}], "widgets": [{"type": "KPI", "label": "Billed", "query": "SELECT sum(total) AS billed FROM public.sales WHERE sold_at >= $VAR.period.from AND sold_at < $VAR.period.to AND ($VAR.branch IS NULL OR branch = $VAR.branch::uuid)", "config": {"roles": {"value": "billed"}, "displayFormat": "$ #,##0"}}, {"type": "LINE", "label": "By day", "query": "SELECT date_trunc('day', sold_at)::date AS day, sum(total) AS billed FROM public.sales WHERE sold_at >= $VAR.period.from AND sold_at < $VAR.period.to GROUP BY 1 ORDER BY 1", "config": {"roles": {"category": "day", "values": ["billed"]}}}, {"type": "BAR_HORIZONTAL", "label": "By branch", "query": "SELECT b.id AS _branch, b.name AS branch, sum(s.total) AS billed FROM public.sales s JOIN public.branches b ON b.id = s.branch WHERE s.sold_at >= $VAR.period.from AND s.sold_at < $VAR.period.to GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10", "config": {"roles": {"category": "branch", "values": ["billed"]}, "click": {"action": "FILTER", "variable": "branch", "value": "{{row._branch}}"}}}, {"type": "TABLE", "label": "Latest sales", "tab": "detail", "query": "SELECT sold_at, total FROM public.sales ORDER BY sold_at DESC LIMIT 20"}]});

/** The widgets that take a prop - from the catalog, so the guide never lists them by hand (DB38). */
function widgetsWith(prop: string): string {
  return DASHBOARD_WIDGET_TYPES.filter((type) => prop in (dashboardWidgetDefinition(type).props ?? {})).join(", ");
}

function propLine(key: string, prop: DashboardWidgetProp): string {
  const unset = prop.default !== undefined ? `default ${JSON.stringify(prop.default)}` : "unset by default";
  return `- ${key} (${prop.editor}${prop.options ? `: ${prop.options.join("|")}` : ""}, ${unset}) - ${prop.description}`;
}

/**
 * One widget type's whole contract - what its query must return (roles), its props and an example. Read per type
 * (describe_dashboard_widgets): every type's in the guide made it 83 KB, past what an MCP client reads at once.
 */
export function dashboardWidgetSection(type: string): string {
  const widget = dashboardWidgetDefinition(type as (typeof DASHBOARD_WIDGET_TYPES)[number]);
  const lines = [`### ${type} - ${widget.label} (${widget.size.w}x${widget.size.h}, at least ${widget.minSize.w}x${widget.minSize.h})`, widget.description];
  if (widget.page) {
    const own = Object.entries(widgetDefinition(widget.page).props);
    lines.push("A presentation widget - query optional. Props (config.props; a formula one also in config.bindings):", ...own.map(([key, prop]) => pagePropLine(key, prop)));
    if (widget.example) lines.push(`Example query: \`${widget.example}\``);
    return lines.join("\n");
  }
  const roles = Object.entries(widget.roles);
  if (roles.length > 0) lines.push("Data (config.roles):", ...roles.map(([id, role]) => roleLine(id, role)));
  const props = Object.entries(widget.props);
  if (props.length > 0) lines.push("Props (config):", ...props.map(([key, prop]) => propLine(key, prop)));
  if (widget.example) lines.push(`Example: \`${widget.example}\``);
  return lines.join("\n");
}

export function dashboardsGuide(): string {
  const groups = Object.entries(DASHBOARD_WIDGET_GROUPS).map(([group, label]) => {
    const types = DASHBOARD_WIDGET_TYPES.filter((type) => dashboardWidgetDefinition(type).group === group);
    if (types.length === 0) return "";
    return `${label}: ${types.map((type) => `${type} (${dashboardWidgetDefinition(type).label})`).join(", ")}`;
  });
  return `# Dashboard widgets

A widget's data is one read-only SQL query an administrator writes:
- one statement - a SELECT or WITH ... SELECT; it runs in a READ ONLY transaction, capped in rows (dashboards.query_max_rows) and time (dashboards.query_timeout_ms);
- schema-qualify tables outside public ("sales".orders) and alias every column (AS total);
- the result is typed: numeric and bigint come back as numbers (no ::float needed - one past 15 significant digits stays its exact text, the column marked lossy); a column taken as is from a table, even aliased (\`total AS billed\`), carries its origin and that column's presentation - its label names the series, its format the numbers; an expression (sum(total), a cast, CASE) goes by its alias. Return dates as date or timestamptz, not to_char text: a time axis orders, zooms and formats them;
- $USER.<column> is the viewer's own user row, $VAR.<name> a dashboard variable the viewer picks ($VAR.<name>.from / .to for a DATE_RANGE) - both bound as parameters, never pasted in: write \`WHERE region = $VAR.region\`, not quotes around it;
- a variable without a value is NULL - write filters that tolerate it: \`WHERE ($VAR.region IS NULL OR region = $VAR.region)\`; a multiple SELECT is text[]: \`region = ANY($VAR.regions)\`;
- a DATE_RANGE also gives its previous period, as long and just before: \`$VAR.p.prev_from\` / \`.prev_to\` (this month's is last month) - for a change against the previous period. Presets: last_hour, today, last_7_days, last_30_days, last_90_days, this_month, last_month, this_year, all. Every query runs in the viewer's time zone (their profile, else the instance's), so today and this month start where they see them;
- a variable's default is {source: "constant", value} or {source: "user", field} - a field of the viewer's own user row, so an operator opens it already filtered by their branch;
- a SELECT's options: a fixed list (each a value or {value, label} - "Yes / No", unset being All), an options query (first column the value, second the label), or a table ({source: "TABLE", resource} - its key the value, its row presentation the label, no SQL). **Chained filters**: an options query that reads another variable ($VAR.country), or a TABLE's filters [{column, variable}], reloads when that variable changes and drops a value it no longer offers - the cities of the selected country;
- columns starting with _ are never displayed but travel with the row: _color colors a row (a palette name: red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose), _<column>_color one cell;
- the query runs with the dashboard's authority, not the viewer's grants: filter by $USER.* when viewers may only see their own data.

## Data contract: roles
Each widget declares roles - what a result column does in it. config.roles assigns columns to them by name ({"category": "month", "values": ["billed", "paid"]}); a role left out takes its default by kind and position (the first number column, every number column...), never by a column's name, never a _ column. Kinds: number (smallint, integer, bigint, numeric, real, double precision), date/time (date, timestamp, timestamptz), point, file (a uuid whose origin is a foreign key to files) and category (anything else). A role checks what it is given on save and on run: a column the query doesn't return, or of a kind it doesn't take, is refused with DASHBOARD_WIDGET_ROLES_INVALID naming the role, what it takes and what the query returned. Long format (month, seller, total): Values = total and Series = seller - one series per seller. The rest of config is the widget's props; a prop left out takes its default (listed below).

Every widget's card also takes, in config beside its props (a presentation widget all but emptyText - it always draws):
${Object.entries(DASHBOARD_WIDGET_CARD_PROPS).map(([key, prop]) => propLine(key, prop)).join("\n")}
- bindings.title ({"kind": "formula", "formula": "..."}) - its title as a formula, over the context below; it wins over label when it gives a text.

## Presentation widgets and formulas
VISUALIZATION (TImage, THeading, TText, TQrCode, UBadge, UAlert, USeparator) and INSERTION (TFrame) are the page catalog's display widgets (totalbase://guide/widgets): the same props, checked the same way, in config as a page control's - {"props": {literal values}, "bindings": {"<prop>": {"kind": "formula", "formula": "..."}}} - plus style, description and mobile, inside config too (never beside type and label). Only their own props: no Visible, Name, events or Code. A query is optional: with one, their formulas read its rows; a type never switches to or from them.
Formulas are the pages' language (functions, "quoted text", + to join), over:
- {{vars.<name>}} a variable's value, {{vars.<name>.label}} what the viewer reads for it (a SELECT's option label, a DATE_RANGE preset's name - "Sales of " + {{vars.seller.label}}), and for a custom DATE_RANGE {{vars.<name>.from}} / .to;
- {{user.<field>}} the viewer (id, email, name and the rest of their profile) - none in an embed;
- {{row.<column>}} the query's first row, {{rows}} every row ({{rows.length}} how many) - with a query.
TImage is a fixed image: a file uploaded in the editor (a PUBLIC file - anyone who opens the dashboard sees it) or an https URL - or a file from the query: bindings.src {{row.<file column>}} (see Files, below). TFrame's URL takes {{vars.…}}, {{user.…}} and {{row.…}} after the site, each URL-encoded.

## Number format
One format everywhere: displayFormat - KPI, GAUGE, LEADERBOARD, the charts (and each series), a Map's tooltip, a Table's column (columnSettings.<column>.displayFormat). Unset, the value column's own presentation (set_column_presentation), else the locale's. The pattern: "#,##0.00", "$ #,##0" (text around the digits stays, its spaces too), "0.0 %", "0.0 h", "#,##0.00;(#,##0.00);\"-\"" (positive;negative;zero), "CURRENCY:ARS" (the currency's own symbol and decimals). **% never multiplies**: the value must already be a percentage - 85.5 with "0.0 %" reads 85.5 %; 0.855 would read 0.9 % (write \`cobrado * 100 AS cobrado_pct\` in the SQL). compact (1.3M, 2.4K) keeps the format's text and decimals: "$ #,##0" + compact reads $ 1.3M; unset, compact is on unless a format applies. There is no prefix, suffix or decimals - a pattern says them.

## Series and axes (BAR, BAR_HORIZONTAL, LINE, AREA)
series, by value column - or, in long format, by a value of the Series column: {"billed": {"label": "Billed", "color": "blue", "displayFormat": "$ #,##0"}, "paid_pct": {"type": "line", "axis": "right", "displayFormat": "0.0 %"}} - type bar|line|area mixes kinds in one chart, axis right puts a series of another scale on the right axis. Unset: the column's title and format; in long format, the Series column's value labels and colors (its CHECK list's presentation). The tooltip and each axis read their series' format.
axes: {"category": {"title"}, "value": {"title", "min", "max", "log", "displayFormat"}, "value2": {...}} - value2 is the right axis. Unset min: 0 for bars and areas, fitted to the data for lines.
A histogram is a BAR over buckets the SQL makes - the range filtered, the label built in the SQL, ordered by the bucket, empty buckets kept: \`SELECT b.n, (8 + b.n * 10) || '-' || (17 + b.n * 10) AS ages, count(r.age) AS people FROM generate_series(1, 7) AS b(n) LEFT JOIN readings r ON r.age BETWEEN 18 AND 87 AND width_bucket(r.age, 18, 88, 7) = b.n GROUP BY b.n ORDER BY b.n\` - bucket 1 is 18-27, 7 is 78-87; ages outside the range and NULL are left out (say so in the widget's description).

## Thresholds and reference lines
thresholds (${widgetsWith("thresholds")}): [{"color": "red"}, {"from": 60, "color": "amber"}, {"from": 80, "color": "green"}] - the first, without from, the base; each next from its value up. A KPI's number takes the color (over color); a gauge's arc is drawn in those bands. from: a number, {"column": "target"} (the widget's row - its last) or {"variable": "meta"} (a NUMBER or SELECT variable) - resolved on the server (the run's marks).
references (${widgetsWith("references")}): {"type": "line", "value": 100 | "average" | "min" | "max" | "median" | {"column"} | {"variable"}, "label", "color", "series"} and {"type": "band", "from", "to", "label", "color"}; their labels read in the axis' format.
A value toward a target is the PROGRESS widget (below), its color from thresholds - no formula.

## On click
click, one per widget (a KPI or GAUGE: the card; LEADERBOARD and TABLE: the row; a Map: the point; a chart: the mark). Values are formulas over {{row.<column>}} (the clicked row - its _ columns too) and {{vars.<name>}}; targets by id; checked on save and on publish (DASHBOARD_WIDGET_REFERENCE_INVALID, each with its path), a target that's gone listed by list_broken_references (CLICK_TARGET_MISSING).
- {"action": "FILTER", "variable": "sucursal", "value": "{{row.sucursal}}"} - sets a SELECT, TEXT or NUMBER variable of this dashboard; Back undoes it.
- {"action": "DATAVIEW", "dataview": "<id>", "filter": {"sucursal": {"_eq": "{{row.sucursal}}"}}} - opens a DataView filtered (the Data API's where grammar; an empty value drops its condition) - on top of its own filters and the viewer's permissions, even where its Filter is off.
- {"action": "DASHBOARD", "dashboard": "<id>", "variables": {"sucursal": "{{row.sucursal}}"}, "tab": "detalle"}.
- {"action": "RECORD", "dataview": "<id>", "pk": "{{row._id}}"} - the record's form.
- {"action": "URL", "url": "https://site.example/orders/{{row._id}}", "newTab": true, "inEmbeds": false} - the site written out, values encoded.
hint: the tooltip's last line ("Click to see the readings"). In an embed only a FILTER on a variable its visitor may change, and a URL with inEmbeds, run - and the _ columns only another click reads are never sent there.

## Tabs
update_dashboard tabs: [{"value": "general", "label": "General"}, {"value": "detail", "label": "Detail", "icon": "i-lucide-list"}]; save_widget tab puts a widget on one (unset: the first). The App keeps the open tab in ?tab=<value> (no variable is named tab) and runs only the open tab's widgets, each as it scrolls into view. A tab with widgets can't be removed - move them first; [] joins every widget in one grid.

## A Table's totals
columnSettings.<column>.total: sum, avg, min, max or count - a footer row computed by PostgreSQL over every row the query returns (not only those shown when it is cut), in the column's format. No total unless a column asks for one.

## The tanda 3 widgets
- PROGRESS: a value toward its target (roles value, target - or the target prop) - "$ 13.9M of $ 30M · 46 %", thresholds on the value or (thresholdsOn: PERCENT) its percent; past the target the bar is full and the percent real (115 %). A page's UProgress isn't a dashboard widget.
- COMBO: bars and lines on two axes - the first Values column as bars on the left, the rest as lines on the right, each axis in its series' format; it needs two or more Values columns (DASHBOARD_COMBO_NEEDS_TWO_VALUES - for a series per value of a column, a BAR with Series). series changes any of it, as on a BAR.
- WATERFALL: each row a change with its sign; a row whose Total column (a boolean, chosen by hand) is true draws the running total from 0; finalTotal adds the last one. Crossing zero draws right.
- FUNNEL: steps in the query's order (ORDER BY a _n column), conversion FIRST (of the first step), PREVIOUS or NONE; a negative step is DASHBOARD_WIDGET_NEGATIVE_VALUE.
- TREEMAP / SUNBURST: levels (branch, category, product - outermost first) and a value; a parent is the sum of its children - only summable values, never averages; a NULL level ends its branch; negative values are refused. A recursive table (id, parent) flattens to levels with a recursive CTE: \`WITH RECURSIVE t AS (SELECT id, name AS l1, NULL::text AS l2, 1 AS depth FROM area WHERE parent IS NULL UNION ALL SELECT a.id, t.l1, a.name, t.depth + 1 FROM area a JOIN t ON a.parent = t.id) SELECT l1, l2, sum(...) ...\`.
- HEATMAP: x and y (categories in the query's order, dates sorted) and a value; a missing cell stays empty, not 0 - for zeros, a generate_series of every cell LEFT JOINed. A number as a category (an hour, a weekday) only chosen by hand. thresholds draw bands with a legend; else a scale to color.
- CALENDAR: a date and a value - a year per row, as many of the latest three as fit (on a phone, the latest months that fit); day and month names in the UI's language, the week's first day the viewer's. Past the row cap it keeps the latest days.
- SCATTER: x, y, size (bubbles: radius by square root, 6 to 40 px), label, group (a series per value, colored by its presentation); axes x and y; references with axis "x" or "y"; zoom on both.
- DETAIL: the first row as label / value pairs (columnSettings as a Table's), with its image (the first file column). The editor says when the query returns more rows.
- PIVOT: the query returns the DETAIL rows (one per sale, not grouped) and PostgreSQL aggregates them - GROUPING SETS for the subtotals (subtotals), the total column (rowTotals) and row (columnTotals). aggregates is required for every value: {"total": "sum", "ticket": "avg"} (DASHBOARD_PIVOT_AGGREGATE_REQUIRED); an average is the real one, never an average of averages. At most 60 values across Columns (DASHBOARD_PIVOT_TOO_MANY_COLUMNS). The row cap applies to the aggregated rows, totals first.
- Files: a column that is a file's id (a foreign key to files) comes with a link TotalBase signs for 15 minutes (a run's files) - a Detail shows it, a Table and a Leaderboard a thumbnail, an Image its formula: bindings.src {{row.<file column>}}. A fixed Image is an https URL or a PUBLIC file. In an embed, a file that isn't PUBLIC shows only with the embed's display.allowFiles (off by default).
- preview_query and save_widget's run give each column's kind (number, time, category, point, file), lossy and origin (schema.table.column) - what a role takes.

## Downloads
In the App each widget's ⋮ downloads its data as CSV or Excel (the columns its roles use, titled and formatted as shown, never the _ ones), a chart as a PNG, or opens it full screen; each download is an EXPORT audit entry. An embed offers downloads only with display.allowExport (create_embed / update_embed). zoom (BAR, LINE, AREA): a bar under the chart and the wheel or a pinch.

The canvas is 12 columns wide: KPIs side by side (w 3 each), charts half width (w 6).

Workflow: preview_query to try the SQL, save_widget (it runs what it saved - read run.error), get_dashboard to review, publish_dashboard - or the whole draft at once with apply_dashboard (below). To share it outside TotalBase: update_dashboard embedding_enabled, then create_embed.

## A whole dashboard in one call (apply_dashboard)
get_dashboard returns the draft as a spec; apply_dashboard takes that same shape back - to create a dashboard (no id), rebuild one, or change several things at once; save_widget stays the tool for one adjustment. A widget with an id is that widget (its id kept - clicks, links and alerts point at it), one without is created, one left out is deleted. grid is optional: widgets without it are placed in order at their type's size. All or nothing: every problem in one answer, each {path, code, message} (\`widgets[3].config.roles.value\`), the same codes save_widget and update_dashboard give one by one, plus what crosses them (a click's variable, a widget's tab - against the same spec). Pass get_dashboard's draftVersion: a draft changed since (in the editor) is refused, DASHBOARD_DRAFT_CHANGED. dry_run answers the difference (widgets created, changed - which keys -, deleted; variables and tabs) and applies nothing. Who sees it (roles, embeds) isn't in the spec - access shows it; it applies at once, not on publishing. Then publish_dashboard.
A spec of four widgets with a period, a list from a table, a tab and a click:
\`${DASHBOARD_SPEC_EXAMPLE}\`

## Reasons
Every automatic decision says why as {code, message, detail}: code fixed (below), message in the App's language, detail what was read (a type, a constraint, a column). save_widget's and apply_dashboard's run give each role's {columns, source: config | default, rule: first-of-kind | all-of-kind, reason}; get_dashboard's access gives each embed's notices.
${Object.entries(DASHBOARD_DECISION_CODES).map(([code, entry]) => `- ${code}: ${entry.description}`).join("\n")}

## Large tables
A published widget's result is reused for the dashboard's refresh interval (else dashboards.cache_seconds, 5 minutes) per variable values, time zone and - when the query reads $USER - viewer; at most dashboards.max_concurrent_queries of one dashboard run at once. A query that is still slow over a large table should read precomputed totals, not get a larger timeout: a materialized view, refreshed by a scheduled workflow.
1. execute_sql: \`CREATE MATERIALIZED VIEW public.readings_daily AS SELECT date_trunc('day', taken_at)::date AS day, meter, sum(value) AS total, count(*) AS readings FROM public.readings GROUP BY 1, 2\`, then \`CREATE UNIQUE INDEX ON public.readings_daily (day, meter)\` (so it can refresh CONCURRENTLY, without blocking readers).
2. A function that refreshes it: \`CREATE FUNCTION public.refresh_readings_daily() RETURNS void LANGUAGE sql AS $$ REFRESH MATERIALIZED VIEW CONCURRENTLY public.readings_daily $$\` - expose it (expose_resource) for the workflow's role.
3. A CRON workflow (e.g. every 15 minutes) with one Execute function step calling it, published.
4. The widget reads the view: \`SELECT day, sum(total) AS total FROM public.readings_daily WHERE day >= $VAR.p.from::date AND day < $VAR.p.to::date GROUP BY day ORDER BY day\`.

## Widget types
Each type's query contract (its roles), props and an example: describe_dashboard_widgets with the types you use.
${groups.filter(Boolean).map((line) => `- ${line}`).join("\n")}`;
}

export const ERRORS = `# Errors

Every failure is TotalBase's own CODE: message - PostgreSQL's when PostgreSQL decided (source POSTGRESQL). Read the message: it names the column, constraint, operation or limit. Fix the cause; don't retry the same call.

## The data broke a rule - explain it or fix the data
| Code | Meaning |
|---|---|
| UNIQUE_VIOLATION | a value already exists (a UNIQUE or primary key) - look up the existing row, or use on_conflict |
| FOREIGN_KEY_VIOLATION | a referenced row doesn't exist, or a row is still referenced (delete its children, or the FK's on_delete) |
| CHECK_VIOLATION | a CHECK constraint failed - describe_table shows its expression |
| NOT_NULL_VIOLATION | a required column was left empty |
| INVALID_TEXT_REPRESENTATION, DATATYPE_MISMATCH, INVALID_DATETIME_FORMAT, NUMERIC_VALUE_OUT_OF_RANGE, STRING_DATA_RIGHT_TRUNCATION | a value of the wrong type or size |
| RAISE_EXCEPTION | a trigger or function refused it - its message is the rule |
| PAYLOAD_CHECK_FAILED | a role's payload check failed (permissions) - the labels say which |

## Access - a grant, an exposure or a gate is missing
| Code | Meaning |
|---|---|
| ACTION_DENIED | the role has no ALLOW for the action (or a DENY), or the row is outside its row filter |
| FIELD_PERMISSION_DENIED | a column isn't in the grant's fields - grant it (grant_permission fields) |
| FUNCTION_EXECUTION_DENIED | no EXECUTE grant on the function |
| PERMISSION_DENIED | a guardrail: TotalBase's own tables and settings some writes never pass (only an administrator, never through the Data API, never by a token) |
| RESOURCE_NOT_FOUND | unknown, unexposed (the method isn't in exposed_methods) or not openable - check list_resources / expose_resource |
| SQL_CONSOLE_DISABLED | execute_sql / explain_sql are off for tokens - an administrator allows them in Settings > SQL Console |

## The request is wrong - change the call
| Code | Meaning |
|---|---|
| INVALID_QUERY, INVALID_FIELD, INVALID_OPERATOR, INVALID_RELATION, INVALID_ALIAS, INVALID_GROUP_BY | the query names an unknown column, operator or relation |
| INVALID_ON_CONFLICT | on_conflict.target isn't exactly a primary key or UNIQUE constraint |
| INVALID_NESTED_RELATION, AMBIGUOUS_NESTED_RELATION, NESTED_FOREIGN_KEY_NOT_ALLOWED | a nested "$child" isn't a table with exactly one foreign key to the parent, or sets that key itself |
| QUERY_COMPLEXITY_LIMIT_EXCEEDED, QUERY_DEPTH_LIMIT_EXCEEDED | the filter is too large or too deep |
| INVALID_SCHEMA_OPERATION, UNDEFINED_COLUMN, UNDEFINED_TABLE, DUPLICATE_COLUMN, DUPLICATE_TABLE, DEPENDENT_OBJECTS_STILL_EXIST | a DDL change that doesn't fit the table as it is - describe_table first |
| INVALID_NAME, INVALID_SLUG, *_NAME_DUPLICATE, *_SLUG_DUPLICATE | a name or slug that's invalid or taken |

## Screens, dashboards, workflows
| Code | Meaning |
|---|---|
| DATAVIEW_VIEW_CONFIG_INVALID | a view_config key or value the type doesn't take (totalbase://guide/dataviews) |
| DATAVIEW_DETAIL_REQUIRED, DATAVIEW_DETAIL_INVALID | MASTER_DETAIL needs a lines table with a foreign key to the master |
| INVALID_COLUMN_PRESENTATION, INVALID_ROW_PRESENTATION | a presentation key, value or column that doesn't exist |
| DASHBOARD_QUERY_INVALID, DASHBOARD_WIDGET_INVALID | the widget's SQL or config - preview_query shows PostgreSQL's error |
| READ_ONLY_SQL_TRANSACTION | widget SQL tried to write |
| WORKFLOW_INVALID_DESIGN | the graph or a step's configuration - the message names the step |
| WORKFLOW_NOT_PUBLISHABLE | every readiness issue at once, one per line |
| WORKFLOW_REVISION_CONFLICT | someone saved since you read it - get_workflow again, never overwrite |
| WORKFLOW_DISABLED, WORKFLOW_NOT_RUNNABLE | a production run needs it published, enabled and MANUAL or CRON |

## Transient - retry once, later
SERIALIZATION_FAILURE, DEADLOCK_DETECTED, QUERY_CANCELED (a timeout - simplify or index the query).

RATE_LIMIT_EXCEEDED: with rate limiting on (security.rate_limit_enabled, off by default), the instance allows security.rate_limit_per_minute requests per client IP in a one-minute window (3000 by default) - and every call of this server is one IP. The tools wait for the window and retry by themselves, three times; still refused, slow down: batch (grant_permissions, write_records with a list), or ask an administrator to raise the setting while building. Over HTTP (POST /mcp) each token has its own limit, mcp.rate_limit_per_minute (600 by default - a build's pace), and /mcp never counts toward the per-IP API limit; its 429 carries Retry-After, the seconds until the window resets.`;

export const WORKFLOWS = `# Workflows

A workflow is a tree of steps starting at one Start step (its trigger), saved as a draft, tried with a test run, published as an immutable version, enabled, and granted to the roles that may run it. Steps act through the same services as the Data API - permissions, constraints, audit and data events apply - as the run's executor.

## The definition (save_workflow)
- operations: [{id?, type, key, label?, configuration, parent?}] - key is the step's name ({{key.data}} reads its result; Start's is "start"); new operations get ids, kept ones keep theirs.
- connections: [{source, output, target}] by key - a tree: one target per output, one incoming connection per step, no cycles.
- Outputs: Start next; Condition true / false / error; Select case each case name, default, error; For each item (body) / done / error; Process in batches batch / done / error; Finish steps none; every other step next / error. An unconnected output ends the run (or the loop item) there.
- A step inside a loop body carries parent = the loop's key; a loop can't sit inside another loop.

## Values - {{templates}}
- {{start.data}} the trigger input; {{read_orders.data}} a step's result; {{read_orders.data[0].total}}; {{item}} the current loop element; {{error.message}} in the step an error output leads to.
- A string that is exactly one template keeps its type (an array stays an array); inside longer text it's interpolated.
- A path a step's result doesn't have fails that step, naming what the result has ({{file.data.id}}: file.data has no id - it has asset, name, mimeType, size) - each step's "Result:" below is its {{key.data}}. A null on the way resolves to null; under {{start...}} and {{item...}} (data from outside) a missing field is just empty.
- Resources (tables, functions) are referenced by their id - list_resources.

## Triggers - the Start step's configuration
- MANUAL: {"trigger":"MANUAL"}, optional input_fields [{name, label, type text|number|boolean|date, required}] (a run's input is checked against it), execute_as (a user id to run as; default the caller), confirm_message. Run from the App, run_workflow, POST /api/workflows/{slug}/run, or another workflow.
- CRON: {"trigger":"CRON","cron_expression":"0 9 * * MON-FRI","timezone":"America/Argentina/Buenos_Aires","execute_as":"<user id>"} - minute, hour, day, month, weekday; names allowed.
- WEBHOOK: {"trigger":"WEBHOOK","method":"POST","access":"PUBLIC"|"AUTHENTICATED","execute_as":"<user id>" (required for PUBLIC),"response_mode":"SYNC"|"ASYNC"} - POST /api/workflows/{slug}/webhook. {{start.data}} is {query, body, meta: {ip, headers}}: the sender's JSON is {{start.data.body}} (its field {{start.data.body.codigo}}), the query string {{start.data.query}}, the caller's IP {{start.data.meta.ip}} and every request header {{start.data.meta.headers}} (lowercase names - a key passed in a header: {{start.data.meta.headers.x-api-key}}; authorization and cookie are redacted from the history). ASYNC answers 202 {data: {run}}. SYNC answers 200 {data: {id, status, result, error}} - result what totalbase.finish-result set; a failed run is still 200 with status FAILED and error {code, message}: the caller checks status, not the HTTP code (504 WORKFLOW_SYNC_TIMEOUT when the wait runs out).
- DATA_EVENT: {"trigger":"DATA_EVENT","resource":"<table resource id>","events":["CREATE","UPDATE","DELETE"],"execute_as":"<user id>", optional for_each ROW|STATEMENT, filter (rows matching it), changed_fields and old_filter (UPDATE)} - reacts to writes through TotalBase (not raw SQL); the row is {{start.data}}. On a function resource, events ["EXECUTE"] and nothing else: each call through the Data API starts one run after it commits, {{start.data.arguments.<name>}} and {{start.data.result}}; execute_as needs EXECUTE on it; a workflow's own Execute function step starts none; filter the calls with a Condition after Start.
- execute_as: the user whose permissions a run has - the Workflows system account (an administrator, query_records users) or a user with exactly the grants it needs.

## Steps (type: configuration)
- totalbase.read-records: resource (TABLE/VIEW id), query {fields, where, search, order_by, limit, offset} - filter values as text ({"_gt":"0"}; these tools convert numbers), limit and offset a number or text. Result: the rows.
- totalbase.create-records: resource, records (an array of objects), emitEvents. Result: the created rows.
- totalbase.update-records: resource, where, set (an object), emitEvents. A where is required to publish.
- totalbase.delete-records: resource, where, emitEvents.
- totalbase.execute-function: function (FUNCTION id), arguments (named).
- totalbase.execute-sql: statement, executeAs (optional: the run's executor - its Start's execute_as, or who invoked it - attribution only) - raw SQL as TotalBase's PostgreSQL role, no permission checks.
- totalbase.execute-javascript: code - a function body receiving trigger (the trigger input) and results: every earlier step's envelope by its key (results.read_people.data[0].name) and by its operation id; returns JSON; 5 s, no network or database.
- totalbase.condition: input, filter (the filter grammar over input's fields) -> true / false.
- totalbase.validate-data: input, rules [{filter, message}] -> next, or fails with every failed message.
- totalbase.select-case: input, cases [{output, filter}], hasDefault.
- totalbase.for-each: items (an array) -> item body, then done. totalbase.process-batches: source, batchSize -> batch body.
- totalbase.finish-result: result. totalbase.finish-error: code, message.
- totalbase.http-request: method, url, headers, secretHeaders [{name, secret}] (a Settings > Secrets key - set_secret stores one, list_secrets names them; never put credentials in headers), body. Public addresses only. Result: {status, headers, body, durationMs}.
- totalbase.soap-request: url (the endpoint, not the WSDL), version 1.1|1.2, operation and namespace (from the WSDL), soapAction (may be empty), body (a JSON object the server turns into the operation's XML - an array repeats an element, null leaves it out), soapHeaders, httpHeaders, secretHeaders, arrays (response elements always read as a list). Same outbound policy and limits as http-request. Result: {status, headers, body (the response's Body as JSON, namespace prefixes dropped), durationMs}; a SOAP Fault fails the step with WORKFLOW_SOAP_FAULT.
- totalbase.sign: format CMS, data (the text to sign), certificate, privateKey, passphrase (optional) - each of the three a Settings > Secrets key holding the PEM, never the PEM itself. Result: {format, signature (base64 DER CMS SignedData, content attached - what a WSAA login's in0 takes), certificate: {subject, issuer, serialNumber, validFrom, validTo}}. A key that isn't the certificate's, an expired certificate or a wrong passphrase fails with WORKFLOW_SIGN_FAILED.
- totalbase.send-email: to, cc, bcc (each an address, several comma-separated, or a list - "{{emails.data}}"), replyTo, subject + bodyType text|html|both + textBody/htmlBody, or template (a MAILING template id - save_template, list_templates shows its placeholders) + data; attachments (file ids). Needs SEND_EMAIL (set_capability) unless the executor is an administrator.
- totalbase.read-file: asset. Result: {name, filename, mimeType, size, content (base64)}.
- totalbase.create-file: name, contentType, content, encoding text|base64, folder. Result: {asset (the new file's id - what attachments and file columns take), name, mimeType, size}.
- totalbase.parse-file: asset, format json|csv. totalbase.generate-file: format, data. Result: {format, content}.
- totalbase.generate-pdf: design (pdfme), data. totalbase.generate-pdf-template: template (a PDF template id), data. Result: {mimeType, content (base64)} - create-file it (encoding base64) to keep or attach it.
- totalbase.execute-workflow: workflow (id), input - a published, enabled MANUAL or CRON workflow.
- totalbase.wait-resume: waitSeconds.

## Lifecycle
create_workflow (trigger) -> save_workflow (steps, with the revision) -> run_workflow mode=test (the draft, for real: its writes happen) -> publish_workflow (readiness checked; enabled=true; role_ids) -> run_workflow mode=production / its trigger -> get_workflow_runs. Each failed step's error names its code; an error output connected to a step handles it instead of failing the run.`;
