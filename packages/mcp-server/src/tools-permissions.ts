import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { templateColumns } from "@totalbase/tb-catalog";
import { whereParams, type AdminClient } from "./admin-client.js";
import { FULL_POLICY, refuseDestructive, type McpPolicy } from "./policy.js";
import { ADDITIVE, DESTRUCTIVE, filterForStorage, findResource, IDEMPOTENT, jsonObject, passthrough, READ_ONLY, RESOURCES, result, roleId, schemaName, type ResourceRow } from "./tool-helpers.js";

/**
 * Permissions (Security.md §5-§7, Administration.md
 * §11.3): one grant per (role, resource, action) - its effect, row filter,
 * field grants and payload checks, written through the Admin API, which
 * parses the filters with the Data API's own parser. Every field must be
 * granted explicitly (§6.4: no "all fields" wildcard), so a new grant gets
 * the resource's columns unless the agent names them. Reading back is the
 * effective-permissions view - the resolver's own answer, not a re-derivation.
 */

type Effect = "ALLOW" | "DENY";

interface PermissionRow { id: string; effect: Effect; where_clause: unknown; field_overrides: { field: string; effect: Effect }[]; payload_checks: unknown[] }
interface Permission { effect: Effect; whereClause: unknown; fields: { field: string; effect: Effect }[]; payloadChecks: { rule: unknown; label: string | null }[] }
interface ActionDecision { decision: Effect | "UNDEFINED"; roles: string[]; ceiling?: string[]; fields: string[] | null; rowFilters: { role: string; where: unknown }[] | null; payloadChecks: { role: string; label: string | null; rule: unknown }[] | null }
interface EffectivePermissions { resource: string; actions: Partial<Record<Action, ActionDecision>> }


interface CatalogDetail {
  columns: { name: string; dataType: string; isIdentity?: boolean; isGenerated?: boolean; defaultExpression?: string | null }[];
  primaryKey?: string[];
  relations?: { sourceColumn: string; targetSchema: string; targetTable: string; targetColumn: string }[];
}
const catalogOf = (client: AdminClient, resource: Pick<ResourceRow, "id" | "type">) =>
  client.get<CatalogDetail>(`/catalog/${resource.type === "VIEW" ? "view" : "table"}/${resource.id}`);

/** The resource's columns, in order - what "every field" means for a READ grant. */
async function columnsOf(client: AdminClient, resource: ResourceRow): Promise<string[]> {
  if (resource.type === "FUNCTION") return [];
  return (await catalogOf(client, resource)).columns.map((c) => c.name);
}

const FILLED_DEFAULT = /totalbase\.actor_user_id|^(now\(\)|CURRENT_TIMESTAMP|clock_timestamp\(\)|statement_timestamp\(\)|transaction_timestamp\(\))$/i;

/**
 * What "every field" means for a CREATE/UPDATE grant: the columns a writer
 * fills, split from those the database fills - generated and identity
 * columns, a primary key with a default, the actor column a row filter
 * relies on ("whose row it is") and a creation timestamp. A role granted
 * "CRUD" otherwise writes its own order number or reassigns its rows.
 */
async function writableColumnsOf(client: AdminClient, resource: ResourceRow): Promise<{ writable: string[]; filled: string[] }> {
  if (resource.type === "FUNCTION") return { writable: [], filled: [] };
  const detail = await catalogOf(client, resource);
  const primaryKey = new Set(detail.primaryKey ?? []);
  const writable: string[] = [];
  const filled: string[] = [];
  for (const column of detail.columns) {
    const byDatabase =
      column.isGenerated || column.isIdentity ||
      (primaryKey.has(column.name) && !!column.defaultExpression) ||
      (!!column.defaultExpression && FILLED_DEFAULT.test(column.defaultExpression.trim()));
    (byDatabase ? filled : writable).push(column.name);
  }
  return { writable, filled };
}

/**
 * The relation paths a reference column shows a row by - `cliente.razon_social`, from the target table's row
 * presentation (its Label field or every column of its template), else its name/label/title column, else its first
 * text column (DataViews.md §4.4, §15.5). A role reading the table reads them through its own grant
 * (Security.md §6.10), so READ "every field" includes them - without them the App shows keys (B44).
 */
async function referencePaths(client: AdminClient, resource: ResourceRow): Promise<string[]> {
  if (resource.type === "FUNCTION") return [];
  const paths: string[] = [];
  for (const relation of (await catalogOf(client, resource)).relations ?? []) {
    const target = (await client.data<(ResourceRow & { row_presentation?: { displayField?: string; displayTemplate?: string } | null })[]>("GET", RESOURCES, {
      query: { fields: "id,type,row_presentation", ...whereParams({ schema: { _eq: relation.targetSchema }, name: { _eq: relation.targetTable }, status: { _eq: "ACTIVE" } }) },
    }))[0];
    if (!target) continue;
    const row = target.row_presentation ?? {};
    let shown = row.displayTemplate?.trim() ? templateColumns(row.displayTemplate) : row.displayField ? [row.displayField] : [];
    if (shown.length === 0) {
      const columns = (await catalogOf(client, target)).columns;
      const named = columns.find((c) => ["name", "label", "title", "display_name"].includes(c.name.toLowerCase()));
      const text = columns.find((c) => c.name !== relation.targetColumn && /^(text|character varying|character|citext)/.test(c.dataType));
      shown = (named ?? text) ? [(named ?? text)!.name] : [];
    }
    for (const column of shown) if (column !== relation.targetColumn) paths.push(`${relation.sourceColumn}.${column}`);
  }
  return paths;
}

type Action = "CREATE" | "READ" | "UPDATE" | "DELETE" | "EXECUTE";
interface GrantOptions {
  effect: Effect;
  where?: Record<string, unknown> | null | undefined;
  fields?: "all" | string[] | undefined;
  deny_fields?: string[] | undefined;
  payload_checks?: { rule: Record<string, unknown>; label?: string | undefined }[] | undefined;
}

/**
 * One grant, written as the Admin API takes it. Fields have no wildcard
 * (Security.md §6.4): omitted, a new grant gets every current
 * column and an existing one keeps its own - also when only deny_fields
 * changes, since fields are replaced as a set. An omitted `where` keeps the
 * existing grant's row filter too - re-granting to widen fields never widens
 * rows; only an explicit null clears it.
 */
/**
 * What a batch reads once instead of per grant - the instance limits
 * requests per minute: each resource's columns, and the roles' existing
 * grants on the batch's resources (null: not read - read per grant).
 */
interface GrantCache {
  columns: Map<string, Promise<string[]>>;
  existing: Map<string, Pick<PermissionRow, "field_overrides" | "where_clause">> | null;
}
const isEmptyFilter = (filter: unknown) => filter === null || filter === undefined || (typeof filter === "object" && Object.keys(filter).length === 0);
const grantKey = (role: string, resource: string, action: string) => `${role}|${resource}|${action}`;

/** The single PUT's body - and one entry of the bulk PUT's `permissions`, with its resource and action. */
interface GrantBody {
  effect: Effect;
  where: unknown;
  fields?: { field: string; effect: Effect }[];
  payloadChecks?: { rule: unknown; label: string | null }[];
}

/** How a written grant reads back to the agent. */
interface GrantResult {
  role: string;
  resource: string;
  action: Action;
  effect: Effect;
  where: unknown;
  fields: string[];
  deniedFields?: string[];
  payloadChecks?: Permission["payloadChecks"];
  warnings?: string[];
}

/** A grant prepared: its body as the Admin API takes it, and `finish` - the answer and its warnings once the API wrote it. */
interface PreparedGrant {
  body: GrantBody;
  finish(permission: Permission, advice?: string[]): Promise<GrantResult>;
}

/**
 * Prepares one grant: what the PUT carries, and how its answer reads. Split
 * from the PUT itself so grant_permissions sends a role's grants in one
 * request (PUT /roles/:role/permissions) instead of one per grant.
 */
async function prepareGrant(client: AdminClient, roleId: string, resource: ResourceRow, action: Action, options: GrantOptions, cache?: GrantCache): Promise<PreparedGrant> {
  const { effect, where, fields, deny_fields, payload_checks } = options;
  // READ's "every field" also names the paths its reference columns show rows by (B44) - read once per batch.
  const references = () => {
    if (!cache) return (ownReferences ??= referencePaths(client, resource));
    const key = `${resource.id}|REFERENCES`;
    if (!cache.columns.has(key)) cache.columns.set(key, referencePaths(client, resource));
    return cache.columns.get(key)!;
  };
  let ownReferences: Promise<string[]> | undefined;
  // A write's "every field" and the columns it leaves to the database, from one catalog read per batch.
  let ownWrite: { writable: Promise<string[]>; filled: Promise<string[]> } | undefined;
  const writeColumns = () => {
    const split = () => {
      const read = writableColumnsOf(client, resource);
      return { writable: read.then((r) => r.writable), filled: read.then((r) => r.filled) };
    };
    if (!cache) return (ownWrite ??= split());
    const key = `${resource.id}|WRITE`;
    if (!cache.columns.has(key)) {
      const { writable, filled } = split();
      cache.columns.set(key, writable);
      cache.columns.set(`${key}|FILLED`, filled);
    }
    return { writable: cache.columns.get(key)!, filled: cache.columns.get(`${key}|FILLED`)! };
  };
  const everyField = async () => [...await columnsOf(client, resource), ...await references()];
  const columns = () => {
    if (action !== "READ") return writeColumns().writable;
    if (!cache) return everyField();
    const key = `${resource.id}|READ`;
    if (!cache.columns.has(key)) cache.columns.set(key, everyField());
    return cache.columns.get(key)!;
  };
  // The grant as it stands, read once - for what an omitted option keeps, and for what an explicit null clears.
  let existingRead: Promise<Pick<PermissionRow, "field_overrides" | "where_clause"> | undefined> | undefined;
  const existingGrant = () =>
    (existingRead ??= cache?.existing
      ? Promise.resolve(cache.existing.get(grantKey(roleId, resource.id, action)))
      : client
          .data<PermissionRow[]>("GET", "/totalbase/table/permissions", {
            query: { fields: "id,field_overrides,where_clause", ...whereParams({ role: { _eq: roleId }, resource: { _eq: resource.id }, action: { _eq: action } }) },
          })
          .then((rows) => rows[0]));
  let tookEveryField = false;
  let allowed: string[] | undefined;
  if (fields === "all") { allowed = await columns(); tookEveryField = true; }
  else if (fields) allowed = fields;
  else if (resource.type !== "FUNCTION") {
    const existing = await existingGrant();
    if (!existing) { allowed = await columns(); tookEveryField = true; }
    else if (deny_fields) allowed = existing.field_overrides.filter((f) => f.effect === "ALLOW").map((f) => f.field);
  }
  const fieldGrants =
    allowed === undefined && deny_fields === undefined
      ? undefined
      : [
          ...(allowed ?? []).filter((f) => !deny_fields?.includes(f)).map((field) => ({ field, effect: "ALLOW" as const })),
          ...(deny_fields ?? []).map((field) => ({ field, effect: "DENY" as const })),
        ];
  const previousWhere = where === undefined || where === null ? ((await existingGrant())?.where_clause ?? null) : null;
  const clearedWhere = where === null && !isEmptyFilter(previousWhere);
  const body: GrantBody = {
    effect,
    where: where ? filterForStorage(where) : where === undefined ? previousWhere : null,
    ...(fieldGrants && { fields: fieldGrants }),
    ...(payload_checks && { payloadChecks: payload_checks.map((c) => ({ rule: filterForStorage(c.rule), label: c.label ?? null })) }),
  };
  return {
    body,
    async finish(permission, advice: string[] = []): Promise<GrantResult> {
      cache?.existing?.set(grantKey(roleId, resource.id, action), { field_overrides: permission.fields, where_clause: permission.whereClause });
      const granted = permission.fields.filter((f) => f.effect === "ALLOW").map((f) => f.field);
      // The server's advice first (grantAdvisories): related rows read without the role's row filter, a foreign key
      // the role may point at rows it can't read.
      const warnings: string[] = [...advice];
      if (clearedWhere) warnings.push(`The row filter this grant had was removed (where: null) - it now covers every row: ${JSON.stringify(previousWhere)}. Omit where to keep a grant's filter.`);
      if (action === "READ" && effect === "ALLOW" && resource.type !== "FUNCTION") {
        const missing = (await references()).filter((path) => !granted.includes(path) && !deny_fields?.includes(path));
        if (missing.length > 0) warnings.push(`Reference columns show their key, not the row's name, to this role until these paths are granted: ${missing.join(", ")} (add them to fields).`);
      }
      if (tookEveryField && (action === "CREATE" || action === "UPDATE")) {
        const filled = (await writeColumns().filled).filter((column) => !granted.includes(column));
        if (filled.length > 0) warnings.push(`Every field left out what the database fills: ${filled.join(", ")} (a default, identity, generated, the writer or the time). Name one in fields to let the role write it.`);
      }
      return {
        role: roleId,
        resource: `${resource.schema}.${resource.name}`,
        action,
        effect: permission.effect,
        where: permission.whereClause,
        fields: granted,
        ...(permission.fields.some((f) => f.effect === "DENY") && { deniedFields: permission.fields.filter((f) => f.effect === "DENY").map((f) => f.field) }),
        ...(permission.payloadChecks.length > 0 && { payloadChecks: permission.payloadChecks }),
        ...(warnings.length > 0 && { warnings }),
      };
    },
  };
}

/** A grant route's `meta.warnings` (grantAdvisories on the server). */
function metaWarnings(meta: Record<string, unknown> | undefined): string[] {
  return Array.isArray(meta?.warnings) ? (meta.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [];
}

/** One grant, written as the Admin API takes it (grant_permission). */
async function applyGrant(client: AdminClient, roleId: string, resource: ResourceRow, action: Action, options: GrantOptions) {
  const prepared = await prepareGrant(client, roleId, resource, action, options);
  const written = await client.putWithMeta<Permission>(`/roles/${roleId}/resources/${resource.id}/permissions/${action}`, { data: prepared.body });
  return prepared.finish(written.data, metaWarnings(written.meta));
}

const ACTIONS = ["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"] as const;
const grantShape = {
  effect: z.enum(["ALLOW", "DENY"]).default("ALLOW").describe("DENY refuses the action whatever other roles allow"),
  where: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe("Row filter in the Data API's filter grammar (totalbase://guide/data-api); null = every row; omitted = every row for a new grant, unchanged for an existing one. Values: $USER.<column> (the caller's own user row - $USER.id, or a column the developer added), $INTERVAL.*, $PERIOD.*, $CURRENT_DATE, $ROW.<column> (another column of the row the write leaves, e.g. {\"pagado\": {\"_lte\": \"$ROW.total\"}})"),
  fields: z
    .union([z.literal("all"), z.array(z.string())])
    .optional()
    .describe("Columns allowed: 'all' (every current column - a column added later must be granted then; for READ also the paths its reference columns show rows by, e.g. 'cliente.razon_social'), or a list (relation paths like 'customer.name' included). For CREATE/UPDATE 'all' leaves out what the database fills: generated and identity columns, a primary key with a default, a column defaulting to the writer (totalbase.actor_user_id) or the time - name one to grant it. Omitted: 'all' for a new grant, unchanged for an existing one. Not for EXECUTE"),
  deny_fields: z.array(z.string()).optional().describe("Columns explicitly refused (DENY beats another role's ALLOW)"),
  payload_checks: z
    .array(z.strictObject({ rule: z.record(z.string(), z.unknown()).describe("A filter the written row must match, e.g. {\"discount\":{\"_lte\":20}}"), label: z.string().optional().describe("The message shown when it fails") }))
    .optional()
    .describe("CREATE / UPDATE only: every check must hold for the role's writes, or PAYLOAD_CHECK_FAILED. [] clears them"),
};

/** A grant as written (GrantResult). */
const grantOutput = {
  role: z.string(),
  resource: z.string().describe("schema.name"),
  action: z.enum(ACTIONS),
  effect: z.enum(["ALLOW", "DENY"]),
  where: z.unknown().optional().describe("The row filter, null for every row"),
  fields: z.array(z.string()).describe("The fields allowed"),
  deniedFields: z.array(z.string()).optional(),
  payloadChecks: z.array(jsonObject()).optional(),
  warnings: z.array(z.string()).optional(),
};

export function registerPermissionTools(server: McpServer, client: AdminClient, policy: McpPolicy = FULL_POLICY): void {
  server.registerTool(
    "grant_permission",
    {
      title: "Grant permission",
      description:
        "Set one role's grant for an action on a table (CREATE, READ, UPDATE, DELETE), a view (READ) or a function (EXECUTE) - totalbase://guide/permissions. No grant means denied; DENY on any of a user's roles beats every ALLOW. A grant carries: `where`, a row filter (which rows - e.g. {\"owner\":{\"_eq\":\"$USER.id\"}} for each user's own; ALLOW filters of several roles OR-combine; UPDATE checks it on the row before and after); `fields`, the columns it allows - every field must be granted, there is no wildcard; a dotted path ('customer.name') grants reading through a foreign key; `deny_fields`, columns refused even if another role allows them; `payload_checks`, rules the written values must satisfy (CREATE/UPDATE). Each call replaces the grant's effect; its row filter, fields and payload checks are replaced when given, kept when omitted (where: null clears the filter). The table must also be exposed (expose_resource). Administrators need no grants. Several roles, tables or actions at once: grant_permissions.",
      inputSchema: {
        role_id: roleId(),
        schema: schemaName(),
        name: z.string().describe("Table, view or function name"),
        action: z.enum(ACTIONS),
        ...grantShape,
      },
      outputSchema: grantOutput,
      annotations: IDEMPOTENT,
    },
    async ({ role_id, schema, name, action, ...options }) => {
      if (options.effect === "DENY" || (options.deny_fields?.length ?? 0) > 0) refuseDestructive(policy, "A DENY (it revokes)");
      return result(await applyGrant(client, role_id, await findResource(client, schema, name), action, options));
    },
  );

  server.registerTool(
    "grant_permissions",
    {
      title: "Grant permissions",
      description:
        "Many grants in one call: for every role in role_ids, every entry's actions on its table, view or function - the same grant as grant_permission (row filter, fields - every column for a new grant - deny_fields, payload checks) per (role, resource, action). A role's grants are written in one transaction: an error names the role whose grants failed and none of its is applied (the roles before it keep theirs - each is an upsert, run the call again after fixing it). Answers a compact summary per grant.",
      inputSchema: {
        role_ids: z.array(roleId()).min(1).describe("Roles that get every grant below (list_roles)"),
        grants: z
          .array(
            z.strictObject({
              schema: schemaName(),
              name: z.string().describe("Table, view or function name"),
              actions: z.array(z.enum(ACTIONS)).min(1).describe("e.g. ['READ'] or ['CREATE','READ','UPDATE','DELETE']"),
              ...grantShape,
            }),
          )
          .min(1),
      },
      outputSchema: { applied: z.number(), warnings: z.array(z.string()).optional().describe("The server's advice on the grants written: related rows read without the role's row filter, a foreign key it may point at rows it can't read"), grants: z.array(z.object({ role: z.string(), resource: z.string(), action: z.enum(ACTIONS), effect: z.enum(["ALLOW", "DENY"]), fields: z.number().describe("How many fields the grant allows"), where: z.unknown().optional(), warnings: z.array(z.string()).optional() })) },
      annotations: IDEMPOTENT,
    },
    async ({ role_ids, grants }) => {
      if (grants.some((grant) => grant.effect === "DENY" || (grant.deny_fields?.length ?? 0) > 0)) refuseDestructive(policy, "A DENY (it revokes)");
      const applied: { role: string; resource: string; action: string; effect: string; fields: number; where?: unknown; warnings?: string[] }[] = [];
      const advice: string[] = [];
      // Each resource looked up once, and the roles' grants on them read in one request.
      const resources = new Map<string, ResourceRow>();
      for (const { schema, name } of grants) {
        const key = `${schema}.${name}`;
        if (!resources.has(key)) resources.set(key, await findResource(client, schema, name));
      }
      const existingRows = await client.data<(PermissionRow & { role: string; resource: string; action: string })[]>("GET", "/totalbase/table/permissions", {
        query: {
          fields: "role,resource,action,field_overrides,where_clause",
          limit: "500",
          ...whereParams({ role: { _in: role_ids }, resource: { _in: [...new Set([...resources.values()].map((r) => r.id))] } }),
        },
      });
      // A page that may have been cut is no answer for "not granted yet": read per grant then.
      const cache: GrantCache = {
        columns: new Map(),
        existing: existingRows.length < 500 ? new Map(existingRows.map((row) => [grantKey(row.role, row.resource, row.action), row])) : null,
      };
      // Every grant of a role in one request, written in one transaction - all of them, or none.
      for (const roleId of role_ids) {
        const prepared: { grant: (typeof grants)[number]; action: Action; resource: ResourceRow; prepared: PreparedGrant }[] = [];
        for (const grant of grants) {
          const { schema, name, actions, ...options } = grant;
          const resource = resources.get(`${schema}.${name}`)!;
          for (const action of actions) prepared.push({ grant, action, resource, prepared: await prepareGrant(client, roleId, resource, action, options, cache) });
        }
        let permissions: Permission[];
        try {
          const written = await client.putWithMeta<Permission[]>(`/roles/${roleId}/permissions`, {
            data: { permissions: prepared.map((p) => ({ resource: p.resource.id, action: p.action, ...p.prepared.body })) },
          });
          permissions = written.data;
          advice.push(...metaWarnings(written.meta).filter((warning) => !advice.includes(warning)));
        } catch (error) {
          throw new Error(`The grants for role ${roleId} failed - none of them was applied (${applied.length} applied for the roles before it): ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const [index, p] of prepared.entries()) {
          const done = await p.prepared.finish(permissions[index]!);
          applied.push({ role: roleId, resource: done.resource, action: p.action, effect: done.effect, fields: done.fields.length, ...(done.where !== null && { where: done.where }), ...(done.warnings && { warnings: done.warnings }) });
        }
      }
      return result({ applied: applied.length, grants: applied, ...(advice.length > 0 && { warnings: advice }) });
    },
  );

  server.registerTool(
    "revoke_permission",
    {
      title: "Revoke permission",
      description: "Remove a role's grant for one action on a table, view or function - the action becomes undefined for that role (denied, unless another of a user's roles allows it). To refuse it outright whatever other roles allow, grant DENY instead. Requires confirm=true.",
      inputSchema: { role_id: roleId(), schema: schemaName(), name: z.string(), action: z.enum(["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"]), confirm: z.literal(true).describe("Must be true") },
      outputSchema: { revoked: z.object({ role: z.string(), resource: z.string(), action: z.enum(ACTIONS) }) },
      annotations: DESTRUCTIVE,
    },
    async ({ role_id, schema, name, action }) => {
      const resource = await findResource(client, schema, name);
      await client.delete(`/roles/${role_id}/resources/${resource.id}/permissions/${action}`);
      return result({ revoked: { role: role_id, resource: `${schema}.${name}`, action } });
    },
  );

  server.registerTool(
    "get_permissions",
    {
      title: "Get permissions",
      description:
        "What a role - or a user, across all their roles - may do, as TotalBase's resolver decides it: per resource and action, the decision (ALLOW / DENY), the allowed fields, the row filters and payload checks, and which roles contribute. Only resources with a decision are listed. Use it to check grants after setting them. An administrator user is allowed everything without grants. With neither role_id nor user_id, schema and name list every role's grants on that one table, view or function.",
      inputSchema: {
        role_id: roleId().optional(),
        user_id: z.string().optional().describe("A user's id (query_records on users) - instead of role_id"),
        schema: z.string().optional().describe("Only resources of this schema"),
        name: z.string().optional().describe("Only this table, view or function (with schema)"),
      },
      outputSchema: {
        resource: z.string().optional().describe("With schema and name alone: that resource, and every role's grants on it"),
        type: z.enum(["TABLE", "VIEW", "FUNCTION"]).optional(),
        exposedMethods: z.array(z.string()).optional(),
        grants: z
          .array(z.object({ role: z.string(), roleName: z.string().nullable(), action: z.enum(ACTIONS), effect: z.enum(["ALLOW", "DENY"]), where: z.unknown().optional(), fields: z.array(z.string()), deniedFields: z.array(z.string()).optional(), payloadChecks: z.array(z.unknown()).optional() }))
          .optional(),
        items: z
          .array(z.object({ resource: z.string(), type: z.enum(["TABLE", "VIEW", "FUNCTION"]), exposedMethods: z.array(z.string()), actions: z.record(z.string(), jsonObject()).describe("By action: decision, fields, rowFilters, payloadChecks, roles, limitedBy") }))
          .optional()
          .describe("With role_id or user_id: what it may do, by resource"),
      },
      annotations: READ_ONLY,
    },
    async ({ role_id, user_id, schema, name }) => {
      if (role_id && user_id) throw new Error("Pass role_id or user_id, not both.");
      if (!role_id && !user_id) {
        if (!schema || !name) throw new Error("Pass role_id, user_id, or schema and name (every role's grants on that resource).");
        const resource = await findResource(client, schema, name);
        const [grants, roles] = await Promise.all([
          client.data<(PermissionRow & { role: string; action: Action })[]>("GET", "/totalbase/table/permissions", {
            query: { limit: "500", order_by: "role,action", fields: "role,action,effect,where_clause,field_overrides,payload_checks", ...whereParams({ resource: { _eq: resource.id } }) },
          }),
          client.data<{ id: string; name: string }[]>("GET", "/totalbase/table/roles", { query: { fields: "id,name", limit: "500" } }),
        ]);
        const roleName = new Map(roles.map((r) => [r.id, r.name]));
        return result({
          resource: `${schema}.${name}`,
          type: resource.type,
          exposedMethods: resource.exposed_methods,
          grants: grants.map((g) => ({
            role: g.role,
            roleName: roleName.get(g.role) ?? null,
            action: g.action,
            effect: g.effect,
            ...(g.where_clause !== null && { where: g.where_clause }),
            fields: g.field_overrides.filter((f) => f.effect === "ALLOW").map((f) => f.field),
            ...(g.field_overrides.some((f) => f.effect === "DENY") && { deniedFields: g.field_overrides.filter((f) => f.effect === "DENY").map((f) => f.field) }),
            ...(g.payload_checks.length > 0 && { payloadChecks: g.payload_checks }),
          })),
        });
      }
      const [decisions, resources] = await Promise.all([
        client.get<EffectivePermissions[]>(role_id ? `/roles/${role_id}/effective-permissions` : `/users/${user_id}/effective-permissions`),
        client.data<ResourceRow[]>("GET", RESOURCES, {
          query: { limit: "500", ...whereParams({ status: { _eq: "ACTIVE" }, ...(schema && { schema: { _eq: schema } }), ...(name && { name: { _eq: name } }) }) },
        }),
      ]);
      const byId = new Map(resources.map((r) => [r.id, r]));
      const answer = decisions.flatMap((entry) => {
        const resource = byId.get(entry.resource);
        if (!resource) return [];
        const actions = Object.fromEntries(
          Object.entries(entry.actions)
            .filter(([, d]) => d && d.decision !== "UNDEFINED")
            .map(([action, d]) => [
              action,
              {
                decision: d!.decision,
                ...(d!.fields && { fields: d!.fields }),
                ...(d!.rowFilters?.length && { rowFilters: d!.rowFilters }),
                ...(d!.payloadChecks?.length && { payloadChecks: d!.payloadChecks }),
                ...(user_id && { roles: d!.roles }),
                // The ancestors whose grants bound it (a role's parent, and up) - a grant past them has no effect.
                ...(d!.ceiling?.length && { limitedBy: d!.ceiling }),
              },
            ]),
        );
        return Object.keys(actions).length > 0 ? [{ resource: `${resource.schema}.${resource.name}`, type: resource.type, exposedMethods: resource.exposed_methods, actions }] : [];
      });
      return result(answer);
    },
  );

  server.registerTool(
    "apply_default_permissions",
    {
      title: "Apply default permissions",
      description:
        "Give a role what an ordinary App user needs on TotalBase's own tables: read and upload files and folders (changing or deleting only their own), read templates and roles, read and update their own account (name, avatar_url, preferences), read their assignments and sessions, sign out their sessions, read their own activity in the audit log (without payloads). Apply it to every role people sign into the App with. A default is written only where the role has no grant for that table and action yet: one it already has - broader, narrower or DENY - is kept and listed in `kept`. Applying twice changes nothing; grants on other tables are never touched.",
      inputSchema: { role_id: roleId() },
      outputSchema: passthrough("The grants added and the ones the role already had"),
      annotations: IDEMPOTENT,
    },
    async ({ role_id }) => result(await client.post(`/roles/${role_id}/totalbase-defaults`)),
  );

  server.registerTool(
    "set_capability",
    {
      title: "Set capability",
      description:
        "Turn a role's capability on or off: TRANSACTIONS (may submit multi-step Data API transactions, POST /api/transactions - each step still checked per resource), SEND_EMAIL (may run a workflow's Send email step) or MANAGE_ROLES (its members create roles under it - a role's parent column - grant them permissions within what this role has, share what they open and assign them: delegated administration of a branch). Like grants: ALLOW, DENY (wins over other roles' ALLOW) or off (no row: undefined). Administrators hold all of them.",
      inputSchema: {
        role_id: roleId(),
        capability: z.enum(["TRANSACTIONS", "SEND_EMAIL", "MANAGE_ROLES", "ACT_ON_BEHALF"]),
        effect: z.enum(["ALLOW", "DENY", "OFF"]),
      },
      outputSchema: { role: z.string(), capability: z.string(), effect: z.enum(["ALLOW", "DENY", "OFF"]) },
      annotations: IDEMPOTENT,
    },
    async ({ role_id, capability, effect }) => {
      const path = "/totalbase/table/roles_capabilities";
      const existing = await client.data<{ id: string }[]>("GET", path, { query: { fields: "id", ...whereParams({ role: { _eq: role_id }, capability: { _eq: capability } }) } });
      const row = existing[0];
      if (effect === "DENY") refuseDestructive(policy, "Denying a capability");
      if (effect === "OFF") {
        if (row) refuseDestructive(policy, "Turning a capability off");
        if (row) await client.data("DELETE", `${path}/${row.id}`);
      } else if (row) {
        await client.data("PATCH", `${path}/${row.id}`, { body: { data: { effect } } });
      } else {
        await client.data("POST", path, { body: { data: { role: role_id, capability, effect } } });
      }
      return result({ role: role_id, capability, effect });
    },
  );

  server.registerTool(
    "duplicate_role",
    {
      title: "Duplicate role",
      description:
        "A copy of a role under a new name - the same role for another site or team: its description, look, access flags, App home, parent (its ceiling), grants, object access, capabilities and managers. Never its members. A reserved role isn't copied.",
      inputSchema: {
        role_id: roleId(),
        name: z.string().describe("The copy's name, unique, at most 64 characters"),
      },
      outputSchema: { id: z.string(), name: z.string(), parent: z.string().nullable() },
      annotations: ADDITIVE,
    },
    async ({ role_id, name }) => {
      const copy = await client.post<{ id: string; name: string; parent: string | null }>(`/roles/${role_id}/duplicate`, { data: { name } });
      return result({ id: copy.id, name: copy.name, parent: copy.parent });
    },
  );
}
