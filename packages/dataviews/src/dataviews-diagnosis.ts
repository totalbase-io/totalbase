import type { EffectivePermissionService } from "@totalbase/permissions";
import { resourceQueryColumns, type VariableDefinition } from "@totalbase/tb-catalog";
import { brokenDataViewReferences } from "./broken-references.js";
import { reachableByRoles } from "./dataviews-access.js";
import { listFields } from "./dataviews-fields.js";
import { getDataView } from "./dataviews-read.js";
import type { AdminDataViewField, DataViewsContext } from "./dataviews-types.js";

/**
 * What stops a DataView from working, and for whom (DataViews.md §18): one check the admin's
 * warnings, the publish dialog and the MCP's `check_app` all read. Every answer about a role comes from the
 * Permission Resolver, as the Data API decides it; nothing here grants or changes anything.
 *
 * - `warning`: something a viewer runs into - an empty screen, a refused query, an id where a name should be.
 * - `info`: worth knowing, often intended - a role that may read but not create sees no New.
 */
export type DiagnosisCode =
  | "NOT_PUBLISHED"
  | "NO_ROLES"
  | "BROKEN_REFERENCE"
  | "CONSTRAINT_WITHOUT_MESSAGE"
  | "SECRET_COLUMN_SHOWN"
  | "ROLE_CANNOT_READ"
  | "ROLE_FIELDS_HIDDEN"
  | "ROLE_SEES_KEY"
  | "ROLE_VARIABLE_REFUSED"
  | "ROLE_CANNOT_WRITE"
  | "WIDGET_IGNORES_ROW_FILTER";

export interface DiagnosisIssue {
  code: DiagnosisCode;
  severity: "warning" | "info";
  /** The issue in English, for an agent or a log - the admin shows its own words from `code` and the fields below. */
  message: string;
  role: { id: string; name: string } | null;
  /** The resource it is about - the source, or a Resource variable's. */
  resource: { id: string; name: string } | null;
  /** ROLE_CANNOT_WRITE: the actions the role lacks among those the DataView allows. */
  actions: ("CREATE" | "UPDATE" | "DELETE")[] | null;
  /** ROLE_FIELDS_HIDDEN, ROLE_SEES_KEY, ROLE_VARIABLE_REFUSED, BROKEN_REFERENCE: the columns or paths. */
  columns: string[] | null;
  /** ROLE_VARIABLE_REFUSED: the variable's name. */
  variable: string | null;
  /** WIDGET_IGNORES_ROW_FILTER: the dashboard's widget. */
  widget: { id: string; name: string } | null;
}

/** One issue, every key present (one response shape): what it doesn't name is null. */
type IssueInput = Pick<DiagnosisIssue, "code" | "severity" | "message"> & Partial<Omit<DiagnosisIssue, "code" | "severity" | "message">>;
function issue(input: IssueInput): DiagnosisIssue {
  return { role: null, resource: null, actions: null, columns: null, variable: null, widget: null, ...input };
}

/**
 * Who reaches an object - shared by a DataView's and a Dashboard's checks. Never the menu: a published LISTED object
 * is in it by itself (Security.md §8.2), an EMBEDDED_ONLY one is meant to be reached through another.
 */
export async function objectReachIssues(
  ctx: Pick<DataViewsContext, "database">,
  kind: "dataview" | "dashboard",
  object: { id: string; liveVersion: number | null },
  roleIds: string[],
): Promise<{ issues: DiagnosisIssue[]; roles: { id: string; name: string }[] }> {
  const issues: DiagnosisIssue[] = [];
  const noun = kind === "dataview" ? "DataView" : "dashboard";
  if (object.liveVersion === null) issues.push(issue({ code: "NOT_PUBLISHED", severity: "warning", message: `The ${noun} isn't published: no one sees it in the App yet.` }));
  // Administrators open everything; the roles that need a grant are the others, while active.
  const { rows: roles } = await ctx.database.query<{ id: string; name: string }>(
    `SELECT id, name FROM totalbase.roles WHERE id = ANY($1::uuid[]) AND active AND NOT admin_access ORDER BY name`,
    [roleIds],
  );
  if (roles.length === 0) issues.push(issue({ code: "NO_ROLES", severity: "warning", message: `No role opens the ${noun}: only administrators see it. Choose its roles in Security.` }));
  return { issues, roles };
}

/** The paths a shown foreign key displays its row by (`customer.name`) and the related columns the view shows. */
function displayedPaths(fields: AdminDataViewField[]): string[] {
  const paths = new Set(fields.filter((f) => f.kind === "RELATED" && f.columnName).map((f) => f.columnName!));
  for (const field of fields) {
    if (field.kind !== "COLUMN" || !field.columnName || !field.visible) continue;
    const config = field.config as { display_field?: unknown; display_template?: unknown };
    const template = typeof config.display_template === "string" ? config.display_template.trim() : "";
    const shown = template ? [...template.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]!) : typeof config.display_field === "string" && config.display_field ? [config.display_field] : [];
    for (const column of shown) paths.add(`${field.columnName}.${column}`);
  }
  return [...paths];
}

/**
 * A column whose name reads like a secret - a word of it (between underscores) is one of these. A name, not a
 * proof: it only points the author at the column (DataViews.md §18).
 */
const SECRET_NAME = /(^|_)(secrets?|secretos?|tokens?|passwords?|passwd|pwd|contrase(n|ñ)as?|sign|signature|firma|private_key|clave_privada|api_key|apikey|auth)(_|$)/i;
export function looksLikeSecretColumn(name: string): boolean {
  return SECRET_NAME.test(name);
}

const WRITES = [["create", "CREATE"], ["update", "UPDATE"], ["delete", "DELETE"]] as const;

export async function diagnoseDataView(ctx: DataViewsContext, permissions: EffectivePermissionService, dataviewId: string): Promise<DiagnosisIssue[]> {
  const view = await getDataView(ctx, dataviewId);
  // The roles that reach it as the App decides: granted, or through a DataView that embeds it (a Detail's master).
  const { rows: candidates } = await ctx.database.query<{ id: string }>(`SELECT id FROM totalbase.roles WHERE active AND NOT admin_access`);
  const reaching: string[] = [];
  for (const role of candidates) if (await reachableByRoles(ctx, view.id, [role.id])) reaching.push(role.id);
  const { issues, roles } = await objectReachIssues(ctx, "dataview", { id: view.id, liveVersion: view.liveVersion }, reaching);

  for (const broken of await brokenDataViewReferences(ctx.database, view.id)) {
    issues.push(issue(broken.column === null
      ? { code: "BROKEN_REFERENCE", severity: "warning", message: "Its source table or view no longer exists." }
      : { code: "BROKEN_REFERENCE", severity: "warning", columns: [broken.column], message: `${broken.part} names the column ${broken.column}, which its source no longer has.` }));
  }

  const source = view.sourceResource && view.sourceResourceName ? { id: view.sourceResource, name: `${view.sourceResourceSchema}.${view.sourceResourceName}` } : null;
  // A write the source refuses reads its constraint's message (its COMMENT) beside the field; without one, a viewer
  // reads a generic text.
  if (source && view.sourceResourceType === "TABLE" && view.sourceResourceOid !== null) {
    const { rows } = await ctx.database.query<{ name: string }>(
      `SELECT conname AS name FROM pg_constraint
       WHERE conrelid = $1::oid AND obj_description(oid, 'pg_constraint') IS NULL
         -- What a person filling the form can break: a UNIQUE, or a CHECK with a rule. Not a list of values (a select
         -- offers only those), nor a foreign key (picked from its rows; a delete it blocks reads a plain message).
         AND (contype = 'u' OR (contype = 'c' AND pg_get_constraintdef(oid) !~ '^CHECK \\(+\\w+ (= ANY|<@) \\(?ARRAY\\['))
       ORDER BY conname`,
      [view.sourceResourceOid],
    );
    if (rows.length) {
      issues.push(issue({
        code: "CONSTRAINT_WITHOUT_MESSAGE", severity: "info", resource: source, columns: rows.map((r) => r.name),
        message: `${rows.map((r) => r.name).join(", ")} on ${source.name} have no message: a write they refuse reads a generic text. Give each one its message (alter_table set_constraint_message).`,
      }));
    }
  }
  const fields = await listFields(ctx, view.id);
  const shownColumns = fields.filter((f) => f.kind === "COLUMN" && f.columnName && f.visible).map((f) => f.columnName!);
  const paths = displayedPaths(fields);
  const secrets = shownColumns.filter(looksLikeSecretColumn);
  if (secrets.length) {
    issues.push(issue({
      code: "SECRET_COLUMN_SHOWN", severity: "info", resource: source, columns: secrets,
      message: `${secrets.join(", ")} look like secrets and are shown in its grid. Hide them (update_dataview fields visible false) or take them out; to keep a role from reading them at all, deny the field (grant_permission fields).`,
    }));
  }
  // What the DataView lets its viewers write - never more than their grants (its Allow; every write when unset).
  const allow = Array.isArray(view.viewConfig["allow"]) ? (view.viewConfig["allow"] as string[]) : WRITES.map(([key]) => key);
  const writes = view.sourceResourceType === "TABLE" ? WRITES.filter(([key]) => allow.includes(key)) : [];
  const variables = ((Array.isArray(view.viewConfig["variables"]) ? view.viewConfig["variables"] : []) as VariableDefinition[])
    .filter((variable) => variable.kind === "RESOURCE");
  const variableNames = variables.length > 0
    ? new Map((await ctx.database.query<{ id: string; name: string }>(`SELECT id, "schema" || '.' || name AS name FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [variables.map((v) => v.resource)])).rows.map((r) => [r.id, r.name]))
    : new Map<string, string>();

  for (const role of roles) {
    if (source) {
      const read = await permissions.resolve([role.id], source.id, "READ");
      if (read.action !== "ALLOW") {
        issues.push(issue({ code: "ROLE_CANNOT_READ", severity: "warning", role, resource: source, message: `${role.name} opens it but has no READ on ${source.name}: they see an error instead of rows.` }));
      } else {
        const hidden = shownColumns.filter((column) => read.fieldDecision(column) !== "ALLOW");
        if (hidden.length) issues.push(issue({ code: "ROLE_FIELDS_HIDDEN", severity: "info", role, resource: source, columns: hidden, message: `${role.name} may not read ${hidden.join(", ")} on ${source.name}: those columns stay empty for them.` }));
        const keys = paths.filter((path) => read.fieldDecision(path) !== "ALLOW");
        if (keys.length) issues.push(issue({ code: "ROLE_SEES_KEY", severity: "warning", role, resource: source, columns: keys, message: `${role.name} may not read ${keys.join(", ")}: they see the key instead of the row it points at.` }));
        const lacking: ("CREATE" | "UPDATE" | "DELETE")[] = [];
        for (const [, action] of writes) {
          if ((await permissions.resolve([role.id], source.id, action)).action !== "ALLOW") lacking.push(action);
        }
        if (lacking.length) issues.push(issue({ code: "ROLE_CANNOT_WRITE", severity: "info", role, resource: source, actions: lacking, message: `${role.name} has no ${lacking.join(", ")} on ${source.name}: the DataView offers it, but not to them.` }));
      }
    }
    for (const variable of variables) {
      const resource = { id: variable.resource, name: variableNames.get(variable.resource) ?? variable.resource };
      const read = await permissions.resolve([role.id], variable.resource, "READ");
      const denied = read.action !== "ALLOW" ? null : resourceQueryColumns(variable.query).filter((column) => read.fieldDecision(column) !== "ALLOW");
      if (denied === null || denied.length > 0) {
        issues.push(issue({
          code: "ROLE_VARIABLE_REFUSED", severity: "warning", role, resource, variable: variable.name, ...(denied && { columns: denied }),
          message: `${role.name} may not read ${denied ? denied.join(", ") + " on " : ""}${resource.name}: the page's variable ${variable.name} is refused for them.`,
        }));
      }
    }
  }
  return issues;
}

/**
 * A dashboard's widget runs with its author's authority (Dashboards.md §2), so a role whose READ on a table is
 * limited to some rows sees all of them through a widget that never names `$USER.*`. `widgets` are the live
 * version's such widgets with the tables PostgreSQL plans them to read (`unscopedWidgetTables`); the row filters are
 * the Permission Resolver's. A warning, never a refusal - a dashboard of everyone's figures can be intended.
 */
export async function dashboardRowFilterIssues(
  ctx: Pick<DataViewsContext, "database">,
  permissions: EffectivePermissionService,
  roles: { id: string; name: string }[],
  widgets: { widget: { id: string; name: string }; tables: { schema: string; name: string }[] }[],
): Promise<DiagnosisIssue[]> {
  if (roles.length === 0 || widgets.length === 0) return [];
  const names = [...new Set(widgets.flatMap((w) => w.tables.map((t) => `${t.schema}.${t.name}`)))];
  const { rows: resources } = await ctx.database.query<{ id: string; name: string }>(
    `SELECT id, "schema" || '.' || name AS name FROM totalbase.resources
     WHERE "schema" || '.' || name = ANY($1::text[]) AND status = 'ACTIVE' ORDER BY name`,
    [names],
  );
  const issues: DiagnosisIssue[] = [];
  for (const role of roles) {
    const limited = new Set<string>();
    for (const resource of resources) {
      const read = await permissions.resolve([role.id], resource.id, "READ");
      const allows = (read.rowFilterSources ?? []).filter((source) => source.effect === "ALLOW");
      // Every ALLOW grant filtered: some rows only. One without a filter makes the OR every row.
      if (read.action === "ALLOW" && allows.length > 0 && allows.every((source) => source.whereClause !== null && source.whereClause !== undefined)) limited.add(resource.name);
    }
    for (const { widget, tables } of widgets) {
      for (const resource of resources.filter((r) => limited.has(r.name) && tables.some((t) => `${t.schema}.${t.name}` === r.name))) {
        issues.push(issue({
          code: "WIDGET_IGNORES_ROW_FILTER", severity: "warning", role, resource, widget,
          message: `The widget ${widget.name} reads ${resource.name}, which ${role.name} may read only some rows of, and its SQL never filters by $USER: ${role.name} sees every row through it.`,
        }));
      }
    }
  }
  return issues;
}
