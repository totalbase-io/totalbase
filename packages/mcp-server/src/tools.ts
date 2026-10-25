import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AdminApiError, whereParams, type AdminClient } from "./admin-client.js";
import {
  ADDITIVE,
  columnSchema,
  defined,
  confirmFlag,
  DESTRUCTIVE,
  EXPOSE_METHODS,
  findResource,
  IDEMPOTENT,
  READ_ONLY,
  RESOURCES,
  resourceSummary,
  result,
  schemaName,
  tableName,
  toColumnDefinition,
  type ResourceRow,
} from "./tool-helpers.js";
import { registerSchemaTools } from "./tools-schema.js";
import { registerDashboardTools } from "./tools-dashboards.js";
import { registerDashboardSuggestTools } from "./tools-dashboards-suggest.js";
import { registerDataViewTools } from "./tools-dataviews.js";
import { registerPageTools } from "./tools-pages.js";
import { registerPermissionTools } from "./tools-permissions.js";
import { registerUserTools } from "./tools-users.js";
import { registerWorkflowTools } from "./tools-workflows.js";
import { registerOpenApiTools } from "./tools-openapi.js";
import { destructiveStatements } from "./sql-guard.js";
import { FULL_POLICY, refuseDestructive, type McpPolicy } from "./policy.js";
import { registerTemplateTools } from "./tools-templates.js";
import { registerAppTools } from "./tools-app.js";

/**
 * MCP tools over TotalBase's Data API and Admin API. Each tool is a thin,
 * validated pass-through to one or two calls - no business logic lives
 * here (same rule apps/server follows: this package is "thin", TotalBase
 * itself owns every decision about what's allowed).
 *
 * Records - the application's tables and TotalBase's own (users, roles,
 * resources, templates, logs, ...) - are read and written with the two
 * generic tools, query_records and write_records, through the Data API
 * and its one filter grammar (Security.md §10). The
 * rest are the operations that aren't row writes: DDL, exposure,
 * permissions, users' credentials, DataViews, dashboards, workflows.
 *
 * Requires a plane="ADMIN" personal access token belonging to a user
 * holding the reserved Administrators role (Security.md §1)
 * - every call below is gated by the same requireAdmin the Admin UI
 * uses, nothing here bypasses TotalBase's own authorization.
 */

interface Me {
  id: string;
  email: string;
  name: string | null;
  environment?: string;
  publicUrl?: string;
  display?: { timezone?: string; language?: string };
}

interface RoleRow { id: string; name: string; description: string | null; active: boolean; app_access: boolean; api_access: boolean; admin_access: boolean; reserved: boolean; parent: string | null }

const AGGREGATES = ["sum", "count", "avg", "min", "max"] as const;

export function registerTools(server: McpServer, client: AdminClient, policy: McpPolicy = FULL_POLICY): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "The administrator this MCP server acts as, and the instance: its public URL, environment, time zone and language. Call it first in a session.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const me = await client.get<Me>("/auth/me");
      return result({
        id: me.id,
        email: me.email,
        name: me.name,
        ...(me.environment && { environment: me.environment }),
        ...(me.publicUrl && { publicUrl: me.publicUrl, appUrl: `${me.publicUrl.replace(/\/$/, "")}/` }),
        ...(me.display?.timezone && { timezone: me.display.timezone }),
        ...(me.display?.language && { language: me.display.language }),
      });
    },
  );

  server.registerTool(
    "list_resources",
    {
      title: "List resources",
      description:
        "TotalBase's resources - the tables, views and functions it knows from PostgreSQL's catalog: id, schema, name, type, status (ACTIVE, or MISSING once dropped) and exposedMethods (the Data API methods mounted; empty = not reachable). A new table starts unexposed. TotalBase's own tables are in schema 'totalbase'.",
      inputSchema: {
        schema: z.string().optional().describe("Only this PostgreSQL schema, e.g. 'public'"),
        type: z.enum(["TABLE", "VIEW", "FUNCTION"]).optional(),
        include_missing: z.boolean().optional().describe("Also list resources whose object was dropped (MISSING)"),
      },
      annotations: READ_ONLY,
    },
    async ({ schema, type, include_missing }) => {
      const resources = await client.data<ResourceRow[]>("GET", RESOURCES, {
        query: {
          order_by: "schema,name",
          limit: "500",
          ...whereParams({ ...(schema && { schema: { _eq: schema } }), ...(type && { type: { _eq: type } }), ...(!include_missing && { status: { _eq: "ACTIVE" } }) }),
        },
      });
      return result(resources.map(resourceSummary));
    },
  );

  server.registerTool(
    "get_settings",
    {
      title: "Get settings",
      description:
        "The instance's settings - their current values (overrides, else defaults), every group at once or one group (e.g. 'api' limits, 'auth', 'sql_console', 'dashboards', 'workflows', 'maps'); with describe=true, one group's fields with their label, description, default and bounds. Read-only here: settings are changed by an administrator in the admin's Settings. Secrets are never values - only the names of Settings > Secrets entries.",
      inputSchema: {
        group: z.string().optional().describe("A settings group, e.g. 'api'; every group when omitted"),
        describe: z.boolean().optional().describe("With group: its fields' descriptions, defaults and bounds instead of values"),
      },
      annotations: READ_ONLY,
    },
    async ({ group, describe }) => {
      if (describe && !group) throw new Error("describe needs a group.");
      if (!group) return result(await client.get("/settings"));
      return result(await client.get(`/settings/${encodeURIComponent(group)}${describe ? "/schema" : ""}`));
    },
  );

  server.registerTool(
    "sync_catalog",
    {
      title: "Sync catalog",
      description:
        "Bring TotalBase's resources in line with PostgreSQL after DDL made outside TotalBase (psql, a migration tool, a script): new tables, views and functions become resources (hidden - expose them with expose_resource), dropped ones turn MISSING, renames keep their resource, column changes are pulled. TotalBase notices such DDL by itself within seconds; call this to have it now. create_table, alter_table and execute_sql need no sync. auto_presentation also fills, on every application table and view, what each column's type and constraints suggest and it lacks (suggest_presentation's rules - never a value of its own) - ask the user whether they want it when they haven't said. When a column was renamed or removed, or a table or view went MISSING, brokenReferences lists what still names what's gone: dashboard widgets whose query PostgreSQL now refuses, DataViews whose layouts or Filter name a lost column - tell the user, and fix them (update_dashboard_widget, update_dataview).",
      inputSchema: {
        auto_presentation: z.boolean().optional().describe("Fill what each column's type and constraints suggest (suggest_presentation); never replaces a value already set"),
      },
      annotations: IDEMPOTENT,
    },
    async ({ auto_presentation }) => result(await client.post("/catalog/refresh", auto_presentation ? { data: { autoPresentation: true } } : undefined)),
  );

  server.registerTool(
    "list_broken_references",
    {
      title: "List broken references",
      description:
        "What still names a column, a table or a view PostgreSQL no longer has: dashboard widgets whose query PostgreSQL refuses (planned with LIMIT 0, read only - nothing is read) and DataViews whose layouts (a formula's {{column}}, a picked column) or Filter name a column their source lost - drafts and live versions. Call it after dropping or renaming a column or a view; resource narrows it to one table's or view's.",
      inputSchema: {
        resource: z.string().uuid().optional().describe("A resource id - only that table's or view's DataViews and the widgets whose query names it"),
      },
      annotations: READ_ONLY,
    },
    async ({ resource }) => result(await client.get(`/catalog/broken-references${resource ? `?resource=${encodeURIComponent(resource)}` : ""}`)),
  );

  server.registerTool(
    "execute_sql",
    {
      title: "Execute SQL",
      description:
        "Run raw SQL through TotalBase's SQL Console, as TotalBase's PostgreSQL role: views, functions, triggers, types, indexes, extensions - what the table tools don't cover. Prefer create_table / alter_table for tables, and write_records for rows (those go through permissions, audit and outbox; SQL here does not). Several statements are allowed; transactional=true rolls the whole script back on error. Answers each statement's command and rows in `statements`, in order (each capped by sql_console.max_rows). Audited and kept in the SQL Console history under this token; the catalog is synced afterwards, so a new view or function is a resource at once - hidden until expose_resource / grant_permission. After dropping or renaming a column or a view, call list_broken_references (or sync_catalog) - dashboards and DataViews may still name it. Off unless an administrator turned on Settings > SQL Console > Allow API tokens (SQL_CONSOLE_DISABLED otherwise - tell the user; a token can't turn it on). A statement that DROPs, TRUNCATEs, DELETEs FROM, REVOKEs or ALTERs ... DROP requires confirm=true - ask the user first; the same words inside a function body, a trigger's events, a comment or a literal don't.",
      inputSchema: {
        sql: z.string().min(1),
        transactional: z.boolean().optional().describe("Wrap the script in one transaction - all or nothing"),
        confirm: confirmFlag().describe("Must be true when the SQL drops, truncates, deletes or revokes - ask the user first"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ sql, transactional, confirm }) => {
      // A second signal before anything that destroys data - the statements themselves, never a function's body, a
      // trigger's events or a comment (sql-guard.ts); the server's own gates (sql_console.*) are the security.
      const destructive = destructiveStatements(sql);
      if (destructive.length > 0) refuseDestructive(policy, `SQL that destroys data or access (${[...new Set(destructive)].join(", ")})`);
      if (destructive.length > 0 && confirm !== true) {
        throw new Error(`This SQL destroys data or access (${[...new Set(destructive)].join(", ")}) - ask the user, then pass confirm=true.`);
      }
      // The console's top-level rows repeat the last statement's: `statements` alone says it once.
      const answer = await client.post<Record<string, unknown>>("/sql/execute", { data: { sql, ...(transactional !== undefined && { transactional }) } });
      if (Array.isArray(answer["statements"])) for (const key of ["rows", "rowCount", "truncated", "columns"]) delete answer[key];
      return result(answer);
    },
  );

  server.registerTool(
    "explain_sql",
    {
      title: "Explain SQL",
      description:
        "PostgreSQL's plan for one statement (EXPLAIN, FORMAT JSON) - planned, never executed, not kept in the history. Use it to check a dashboard query or a view is indexed before saving it. Same gate as execute_sql (SQL_CONSOLE_DISABLED until API tokens are allowed).",
      inputSchema: { sql: z.string().min(1).describe("One statement") },
      annotations: READ_ONLY,
    },
    async ({ sql }) => result(await client.post("/sql/explain", { data: { sql } })),
  );

  server.registerTool(
    "create_table",
    {
      title: "Create table",
      description:
        "Create a PostgreSQL table in one statement - columns, primary key, foreign keys, UNIQUE and CHECK together; it exists complete or not at all (totalbase://guide/modeling: types, keys, files, choices). It becomes a resource, hidden from the Data API until exposed: pass expose_methods to expose it at once, then grant_permission for the roles that use it. Create referenced tables first. auto_presentation fills what its columns' types and constraints suggest (suggest_presentation) and a row presentation by its first unique, required text - ask the user whether they want it when they haven't said. Answers the table's resource id, exposure and the columns it presented.",
      inputSchema: {
        schema: schemaName(),
        name: z.string().describe("Table name - plural, snake_case, e.g. 'customers', 'order_lines'"),
        columns: z.array(columnSchema).min(1).describe("Every column, in order; give one primary_key (prefer uuid with default gen_random_uuid())"),
        expose_methods: z
          .array(z.enum(EXPOSE_METHODS))
          .optional()
          .describe("Data API methods to expose immediately - usually ['GET','POST','PATCH','DELETE']; GET only for read-only data"),
        auto_presentation: z.boolean().optional().describe("Fill what its columns' types and constraints suggest (suggest_presentation)"),
      },
      annotations: ADDITIVE,
    },
    async ({ schema, name, columns, expose_methods, auto_presentation }) => {
      const created = await client.post<{ id: string | null }>(`/schema/${encodeURIComponent(schema)}/tables`, { data: { name, columns: columns.map(toColumnDefinition) } });
      // Catalog reconciliation runs synchronously as part of createTable
      // (apps/server/src/routes/admin-schema.ts: refreshCatalog), so the
      // resource row already exists by the time we look it up here.
      const resourceId = async () => created.id ?? (await findResource(client, schema, name, "TABLE")).id;
      let exposedMethods: string[] = [];
      if (expose_methods?.length) {
        exposedMethods = (await client.patch<{ exposedMethods: string[] }>(`/resources/${await resourceId()}`, { data: { exposedMethods: expose_methods } })).exposedMethods;
      }
      const presented = auto_presentation
        ? await (async () => {
            const id = await resourceId()
            await client.post("/resources/suggested-presentation", { data: { resourceIds: [id] } })
            return (await client.get<{ columnName: string; presentation: Record<string, unknown> }[]>(`/resources/${id}/columns`)).filter(column => Object.keys(column.presentation).length > 0).map(column => column.columnName)
          })()
        : [];
      return result({ id: created.id, schema, name, exposedMethods, ...(auto_presentation && { presentedColumns: presented }), next: "grant_permission for the roles that use it; create_dataview to give it a screen" });
    },
  );

  server.registerTool(
    "expose_resource",
    {
      title: "Expose and configure resource",
      description:
        "A table's, view's or function's Data API settings. expose_methods: which methods are mounted (GET read, POST create - a function needs POST to be called -, PATCH update, DELETE delete) - the ceiling above every role's permissions: a method not listed answers 404 for everyone, an empty list hides it; a view is read-only (GET). Exposure grants nothing by itself - roles still need grant_permission. Also: description (in the OpenAPI document), require_idempotency_key (a table's CREATE or a function's call needs an Idempotency-Key header - for payments, registrations, anything a retried request must not do twice), audit_read (log every read too), function_class (QUERY: only reads, safe to retry; ACTION: changes data). Only what is given changes. TotalBase's own tables have a fixed exposure.",
      inputSchema: {
        schema: schemaName(),
        name: z.string().describe("Table, view or function name"),
        expose_methods: z.array(z.enum(EXPOSE_METHODS)).optional(),
        description: z.string().nullable().optional().describe("What it holds or does - shown in the OpenAPI document"),
        require_idempotency_key: z.boolean().optional().describe("TABLE and FUNCTION: a CREATE / call without an Idempotency-Key header is refused (IDEMPOTENCY_KEY_REQUIRED)"),
        audit_read: z.boolean().optional().describe("Also audit every read of it (Logs)"),
        function_class: z.enum(["UNCLASSIFIED", "QUERY", "ACTION"]).optional().describe("FUNCTION only: QUERY reads only, ACTION changes data"),
      },
      annotations: IDEMPOTENT,
    },
    async ({ schema, name, expose_methods, description, require_idempotency_key, audit_read, function_class }) => {
      const resource = await findResource(client, schema, name);
      const patch = defined({ exposedMethods: expose_methods, description, requireIdempotencyKey: require_idempotency_key, auditRead: audit_read, functionClass: function_class });
      if (Object.keys(patch).length === 0) throw new Error("Nothing to change - pass expose_methods or a setting.");
      const updated = await client.patch<{ exposedMethods: string[]; description: string | null; requireIdempotencyKey: boolean; auditRead: boolean; functionClass: string | null }>(`/resources/${resource.id}`, { data: patch });
      return result({
        id: resource.id,
        schema,
        name,
        type: resource.type,
        exposedMethods: updated.exposedMethods,
        description: updated.description,
        requireIdempotencyKey: updated.requireIdempotencyKey,
        auditRead: updated.auditRead,
        ...(resource.type === "FUNCTION" && { functionClass: updated.functionClass }),
      });
    },
  );

  server.registerTool(
    "list_roles",
    {
      title: "List roles",
      description:
        "Every role: id, name, description, active (an inactive role grants nothing), parent (the role above it: its ceiling - it can do at most what its parent can, resolved live - and its managers' scope; null = top level) and its access flags - app_access (people who sign into the App), api_access (personal access tokens), admin_access (administrators: every permission bypassed), reserved (built in, never deleted). Create, change or delete a role with write_records on totalbase / roles (delete takes its grants and assignments with it; reserved roles can't be deleted; a role with roles under it can't be deleted until they go or move); its grants with grant_permission / grant_permissions; a copy with duplicate_role.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const roles = await client.data<RoleRow[]>("GET", "/totalbase/table/roles", { query: { order_by: "name", limit: "500" } });
      return result(roles.map((r) => ({ id: r.id, name: r.name, description: r.description, active: r.active, parent: r.parent, app_access: r.app_access, api_access: r.api_access, admin_access: r.admin_access, reserved: r.reserved })));
    },
  );

  server.registerTool(
    "query_records",
    {
      title: "Query records",
      description:
        "Read rows of any exposed table or view through the Data API (totalbase://guide/data-api) - the application's own and TotalBase's (schema 'totalbase': users, roles, users_roles, resources, permissions, templates, files, folders, logs - totalbase://guide/totalbase-tables). Filters, relations (fields 'customer.name'), search, sort, paging, a total (count) and aggregates with group_by / having. Same permissions as any other caller; protected columns (password and token hashes, log SQL) never come out.",
      inputSchema: {
        schema: schemaName(),
        name: z.string().describe("Table or view name, e.g. 'orders' or 'users'"),
        kind: z.enum(["table", "view"]).default("table").describe("'view' for a PostgreSQL view"),
        where: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Filter object, e.g. {"status":{"_eq":"open"},"total":{"_gte":100}}; combine with _and/_or/_not; a foreign key\'s columns by path {"customer.city":{"_eq":"Rosario"}}. Operators: _eq _neq _gt _gte _lt _lte _in _nin _between _like _ilike _regex _null _nnull _contains _contained_by _overlap. Values: "$USER.id", "$INTERVAL.7d" (the last 7 days), "$PERIOD.this_month.from" / ".to" (to is exclusive), "$ROW.<column>" (another column of the same row: {"stock":{"_lt":"$ROW.stock_minimo"}}).'),
        fields: z.string().optional().describe("Comma-separated columns; dotted to follow a foreign key, e.g. 'id,name,brand.name'. All readable columns when omitted"),
        search: z.string().optional().describe("Free-text search over the readable text columns"),
        order_by: z.string().optional().describe("e.g. 'name,-created_at' (- for descending); a relation path works too"),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
        count: z.boolean().optional().describe("Also return the total number of matching rows (groups, when grouped)"),
        aggregates: z
          .array(z.object({ fn: z.enum(AGGREGATES), field: z.string().describe("A column or path; '*' for count"), alias: z.string().describe("The output key") }))
          .optional()
          .describe("e.g. [{fn:'sum', field:'amount', alias:'total'}]; with aggregates or group_by the rows hold only the group fields and the aggregates"),
        group_by: z.string().optional().describe("Comma-separated group fields, e.g. 'status,customer.name'"),
        having: z.record(z.string(), z.unknown()).optional().describe("A filter over group fields and aggregate aliases, e.g. {\"total\":{\"_gt\":1000}}"),
      },
      annotations: READ_ONLY,
    },
    async ({ schema, name, kind, where, fields, search, order_by, limit, offset, count, aggregates, group_by, having }) => {
      const query: Record<string, string> = {
        limit: String(limit),
        offset: String(offset),
        ...(fields && { fields }),
        ...(search && { search }),
        ...(order_by && { order_by }),
        ...(count && { count: "true" }),
        ...(group_by && { group_by }),
        ...(where && whereParams(where)),
        ...(having && whereParams(having, "having")),
        ...Object.fromEntries((aggregates ?? []).map((a) => [`_${a.fn}[${a.field}]`, a.alias])),
      };
      const path = `/${encodeURIComponent(schema)}/${kind}/${encodeURIComponent(name)}`;
      // The total travels in `meta`, beside the rows - kept when asked for.
      if (count) {
        const { data, meta } = await client.dataWithMeta(path, query);
        return result({ rows: data, count: meta?.["count"] });
      }
      return result(await client.data("GET", path, { query }));
    },
  );

  server.registerTool(
    "upload_file",
    {
      title: "Upload file",
      description:
        "Store a file in TotalBase's file store (totalbase.files - totalbase://guide/files) from its content: base64 for any file, or text for a text one (an SVG, a CSV). Answers the file's id - what a file column, a TImage's src or a UFileUpload keeps. visibility PUBLIC: anyone with its URL (/api/totalbase/table/files/<id>) gets it, no credentials - an illustration or a logo, never private data; PRIVATE (the default): read under READ on files. Change its name, folder, description or visibility later with write_records (update on files).",
      inputSchema: {
        name: z.string().min(1).describe("The file's name, with its extension - e.g. 'dni-frente.svg'"),
        mime_type: z.string().min(1).describe("e.g. image/svg+xml, image/png, application/pdf"),
        content_base64: z.string().optional().describe("The content, base64 - any file"),
        text: z.string().optional().describe("Or the content as text - an SVG, a CSV"),
        folder: z.string().uuid().optional().describe("A folder's id (folders)"),
        visibility: z.enum(["PRIVATE", "PUBLIC"]).optional().describe("PRIVATE by default"),
        description: z.string().optional(),
      },
      annotations: ADDITIVE,
    },
    async ({ name, mime_type, content_base64, text, folder, visibility, description }) => {
      if ((content_base64 === undefined) === (text === undefined)) throw new Error("Give the content once: content_base64 or text.");
      const bytes = content_base64 !== undefined ? Buffer.from(content_base64, "base64") : Buffer.from(text!, "utf8");
      const form = new FormData();
      if (folder) form.append("folder", folder);
      if (visibility) form.append("visibility", visibility);
      if (description) form.append("description", description);
      form.append("file", new Blob([bytes], { type: mime_type }), name);
      return result(await client.upload("/totalbase/table/files", form));
    },
  );

  server.registerTool(
    "write_records",
    {
      title: "Write records",
      description:
        "Create, update or delete rows of an exposed table through the Data API - the application's own or TotalBase's (create a role in roles, an assignment {user, role} in users_roles, a folder in folders). Every write is authorized, audited, emits its data event and is checked by PostgreSQL exactly as any other caller's - constraints decide, errors are PostgreSQL's (UNIQUE_VIOLATION, CHECK_VIOLATION...). create: one row, or a list (bulk: all or nothing); a row may carry its child rows as \"$<child_table>\": [...] (nested create: an order with its lines - the child's foreign key is filled in); on_conflict turns it into an upsert. update / delete: by id, or every row matching where (a file: by id only). create and update answer the written rows; delete answers how many went and their ids. Deleting requires confirm=true. Users are created with create_user (an account needs a password or an invitation).",
      inputSchema: {
        schema: schemaName(),
        name: tableName(),
        operation: z.enum(["create", "update", "delete"]),
        data: z
          .union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))])
          .optional()
          .describe("create: one row or a list; update: the columns to set (one object). Foreign keys take the referenced row's id"),
        id: z.string().optional().describe("update / delete: the row's primary key"),
        where: z.record(z.string(), z.unknown()).optional().describe("update / delete without id: a filter object selecting the rows"),
        on_conflict: z
          .object({
            target: z.array(z.string()).min(1).describe("Exactly the columns of the primary key or of a UNIQUE constraint"),
            action: z.enum(["NOTHING", "UPDATE"]),
            data: z.record(z.string(), z.unknown()).optional().describe("UPDATE: the columns to set on conflict; \"$INSERT.<column>\" is the value that was being inserted"),
          })
          .optional()
          .describe("create only: PostgreSQL's ON CONFLICT - NOTHING skips existing rows, UPDATE upserts (needs CREATE and UPDATE grants)"),
        confirm: confirmFlag().describe("delete: must be true"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ schema, name, operation, data, id, where, on_conflict, confirm }) => {
      // TotalBase's files are written at /totalbase/table/files - their content by upload_file.
      const isFiles = schema === "totalbase" && (name === "files" || name === "files");
      if (isFiles && operation === "create") throw new Error("A file is created with its content - use upload_file.");
      // Each file's stored content goes with its row, so the files routes take one id at a time.
      if (isFiles && id === undefined) throw new Error(`Files are ${operation}d one at a time, by id - query_records totalbase.files for the ids, then one write_records per id.`);
      const path = `/${encodeURIComponent(schema)}/table/${encodeURIComponent(isFiles ? "files" : name)}`;
      const target = id !== undefined ? `${path}/${encodeURIComponent(id)}` : path;
      const query = id === undefined && where ? whereParams(where) : undefined;
      try {
        if (operation === "create") {
          if (data === undefined) throw new Error("create needs data.");
          return result(await client.data("POST", path, { body: { data, ...(on_conflict && { on_conflict }) }, ...(Array.isArray(data) && { query: { bulk: "true" } }) }));
        }
        if (operation === "update") {
          if (data === undefined || Array.isArray(data)) throw new Error("update needs data as one object.");
          if (id === undefined && !where) throw new Error("update needs an id or a where filter.");
          return result(await client.data("PATCH", target, { body: { data }, ...(query && { query }) }));
        }
        refuseDestructive(policy, "Deleting rows");
        if (confirm !== true) throw new Error("delete is irreversible - ask the user, then pass confirm=true.");
        if (id === undefined && !where) throw new Error("delete needs an id or a where filter.");
        // What went, not every column of every row - an agent only confirms it.
        const deleted = await client.data<Record<string, unknown>[] | Record<string, unknown> | undefined>("DELETE", target, { ...(query && { query }) });
        if (deleted === undefined) return result({ deleted: 1, ids: [id] });
        const rows = Array.isArray(deleted) ? deleted : [deleted];
        return result({ deleted: rows.length, ...(rows.every((row) => row["id"] !== undefined) && { ids: rows.map((row) => row["id"]) }) });
      } catch (error) {
        throw await explainNotExposed(client, error, schema, name, METHOD_BY_OPERATION[operation]);
      }
    },
  );

  server.registerTool(
    "call_function",
    {
      title: "Call function",
      description:
        "Execute a PostgreSQL function exposed as a resource, through the Data API: arguments by name, one transaction, audited, with the EXECUTE grant required for non-administrators. Answers its value (scalar) or its rows (set-returning). Write functions with execute_sql (CREATE FUNCTION ...); they appear in list_resources with type FUNCTION, hidden until expose_resource with ['POST'] - and EXECUTE granted to the roles that call them.",
      inputSchema: {
        schema: schemaName(),
        name: z.string().describe("The function's name"),
        arguments: z.record(z.string(), z.unknown()).optional().describe("Named arguments, e.g. {\"invoice\": 42}; parameters with a DEFAULT may be left out"),
      },
      annotations: ADDITIVE,
    },
    async ({ schema, name, arguments: args }) =>
      result(await client.data("POST", `/${encodeURIComponent(schema)}/function/${encodeURIComponent(name)}`, { body: { data: args ?? {} } })),
  );

  // --- Destructive tools ---
  // Each requires confirm=true, an explicit second signal from the
  // caller beyond just supplying the right arguments - the same
  // "irreversible operations should not be a side effect of wrapping
  // the whole Admin API" principle Administration.md §11 states. The
  // server still enforces every real authorization check; this is only
  // a guard against an agent (or the model driving it) invoking a
  // destructive tool on a hunch.

  server.registerTool(
    "delete_table",
    {
      title: "Delete table",
      description:
        "Permanently drop a table and its data. Irreversible - requires confirm=true; ask the user first. Its resource turns MISSING with its grants; a table later created with the same name is a new, hidden resource. Fails while foreign keys or views depend on it, unless cascade=true drops those too.",
      inputSchema: {
        schema: schemaName(),
        name: tableName(),
        cascade: z.boolean().optional().describe("Also drop dependent objects (foreign keys, views) instead of failing"),
        confirm: z.literal(true).describe("Must be explicitly set to true to run this irreversible operation."),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ schema, name, cascade }) => {
      await client.delete(`/schema/${encodeURIComponent(schema)}/tables/${encodeURIComponent(name)}${cascade ? "?cascade=true" : ""}`);
      return result({ dropped: `${schema}.${name}` });
    },
  );

  registerSchemaTools(server, client, policy);
  registerPermissionTools(server, client);
  registerUserTools(server, client);
  registerDataViewTools(server, client);
  registerPageTools(server, client);
  registerDashboardTools(server, client, policy);
  registerDashboardSuggestTools(server, client);
  registerWorkflowTools(server, client);
  registerTemplateTools(server, client);
  registerAppTools(server, client);
  registerOpenApiTools(server, client);
}

const METHOD_BY_OPERATION = { create: "POST", update: "PATCH", delete: "DELETE" } as const;

/**
 * The Data API answers a method a table isn't exposed for as RESOURCE_NOT_FOUND - deliberately, so a caller
 * can't tell a hidden table from a missing one. An agent administering the instance can: when the table is
 * there, say which methods it has and how to expose the one it needs, instead of sending it after a typo.
 */
async function explainNotExposed(client: AdminClient, error: unknown, schema: string, name: string, method: string): Promise<unknown> {
  if (!(error instanceof AdminApiError) || !error.errors.some((e) => e.code === "RESOURCE_NOT_FOUND")) return error;
  const resource = (await client.data<ResourceRow[]>("GET", RESOURCES, {
    query: whereParams({ schema: { _eq: schema }, name: { _eq: name }, status: { _eq: "ACTIVE" }, type: { _eq: "TABLE" } }),
  }).catch(() => []))[0];
  if (!resource || resource.exposed_methods.includes(method)) return error;
  const exposed = resource.exposed_methods.length > 0 ? `for ${resource.exposed_methods.join(", ")} only` : "for no method (hidden)";
  return new Error(`METHOD_NOT_EXPOSED: ${schema}.${name} exists but is exposed ${exposed} - expose ${method} with expose_resource to write it this way.`);
}
