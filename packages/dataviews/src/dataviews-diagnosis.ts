import type { EffectivePermissionService } from "@totalbase/permissions";
import { resourceQueryColumns, type VariableDefinition } from "@totalbase/tb-catalog";
import { isProtectedField } from "@totalbase/shared";
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
  | "STYLE_IN_CSS_CLASS"
  | "WIDGET_IGNORES_ROW_FILTER"
  | "WIDGET_READS_UNREADABLE_TABLE"
  | "WIDGET_SHOWS_HIDDEN_FIELD";

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
  /** ROLE_FIELDS_HIDDEN, ROLE_SEES_KEY, ROLE_VARIABLE_REFUSED, BROKEN_REFERENCE, WIDGET_SHOWS_HIDDEN_FIELD: the columns or paths; CONSTRAINT_WITHOUT_MESSAGE: the constraints; STYLE_IN_CSS_CLASS: the classes. */
  columns: string[] | null;
  /** ROLE_VARIABLE_REFUSED: the variable's name. */
  variable: string | null;
  /** WIDGET_*: the dashboard's widget; STYLE_IN_CSS_CLASS: the page's widget (its Name, else its kind). */
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

/**
 * A Tailwind class a widget's CSS classes carry that the Style tab already offers (COMMON_STYLE_PROPS, DataViews.md
 * §12.2): a margin or padding on any side or all - every step of the scale is a Style value -, an alignment of its
 * content or in its row, a border, a radius, a background of the theme's, a shadow, or its text's size, weight,
 * italics, underline or a color of the theme's. A class with a variant (`md:mt-4`, `hover:shadow-md`) is left
 * alone: Style has no breakpoints.
 */
const STYLE_CLASS = /^(?:[mp][trblxy]?-\d+(?:\.5)?|text-(?:left|center|right|xs|sm|base|lg|xl|2xl|3xl|muted|dimmed|toned|highlighted|primary|secondary|success|info|warning|error)|font-(?:normal|medium|semibold|bold)|italic|underline|line-through|self-(?:start|center|end|stretch)|border|rounded(?:-(?:sm|md|lg|full))?|bg-(?:muted|elevated|accented)|shadow(?:-(?:sm|md|lg))?)$/;
/** The classes of a widget's `cssClass` that a Style value replaces - an agent's `mt-6`, `text-center`. */
export function styleClassesInCssClass(cssClass: unknown): string[] {
  if (typeof cssClass !== "string") return [];
  return [...new Set(cssClass.split(/\s+/).filter((c) => STYLE_CLASS.test(c)))];
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
  // A page's widget styled through its CSS classes where the Style tab has the value: it works, and Style is the
  // intended way - reads in the inspector, the theme's scales, no Tailwind to know.
  for (const field of fields) {
    if (field.kind !== "WIDGET" || !field.widget) continue;
    const props = (field.config as { props?: Record<string, unknown> }).props;
    const classes = styleClassesInCssClass(props?.cssClass);
    if (classes.length === 0) continue;
    const name = field.label || field.widget;
    issues.push(issue({
      code: "STYLE_IN_CSS_CLASS", severity: "info", widget: { id: field.id, name }, columns: classes,
      message: `The widget ${name} sets ${classes.join(", ")} in its CSS classes: Style has them (margin*, padding*, align, verticalAlign, border, radius, background, shadow, fontSize, fontWeight, fontStyle, textDecoration, textColor - update_page_widget props). Keep CSS classes for what Style doesn't offer.`,
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
 * A dashboard's widget runs with its author's authority (Dashboards.md §2), not its viewer's grants. Per role that
 * opens the live version, and per widget (`liveWidgetReads` - the tables PostgreSQL plans it to read, the table
 * columns its result shows):
 *
 * - WIDGET_IGNORES_ROW_FILTER (warning): a widget that never names `$USER.*` reads a table the role may READ only
 *   some rows of - it sees every row through it;
 * - WIDGET_READS_UNREADABLE_TABLE (info): such a widget reads a table the role may not read through the Data API at
 *   all - fine for figures of everyone, which a dashboard often is;
 * - WIDGET_SHOWS_HIDDEN_FIELD (warning): any widget, `$USER` or not (it scopes rows, not columns), shows as it is a
 *   column of a table the role may read but not that field of - or a protected column, never anyone's to read.
 *
 * The decisions are the Permission Resolver's. Warnings, never a refusal.
 */
export async function dashboardWidgetIssues(
  ctx: Pick<DataViewsContext, "database">,
  permissions: EffectivePermissionService,
  roles: { id: string; name: string }[],
  widgets: { widget: { id: string; name: string }; tables: { schema: string; name: string }[]; shown: { schema: string; table: string; column: string }[] }[],
): Promise<DiagnosisIssue[]> {
  if (roles.length === 0 || widgets.length === 0) return [];
  const names = [...new Set(widgets.flatMap((w) => [...w.tables.map((t) => `${t.schema}.${t.name}`), ...w.shown.map((c) => `${c.schema}.${c.table}`)]))];
  const { rows: resources } = await ctx.database.query<{ id: string; name: string; exposed: boolean }>(
    `SELECT id, "schema" || '.' || name AS name, 'GET' = ANY(exposed_methods) AS exposed FROM totalbase.resources
     WHERE "schema" || '.' || name = ANY($1::text[]) AND status = 'ACTIVE' ORDER BY name`,
    [names],
  );
  const issues: DiagnosisIssue[] = [];
  for (const role of roles) {
    const limited = new Set<string>();
    const unreadable = new Set<string>();
    const fieldDecisions = new Map<string, (field: string) => string>();
    for (const resource of resources) {
      const read = await permissions.resolve([role.id], resource.id, "READ");
      if (read.action !== "ALLOW" || !resource.exposed) {
        unreadable.add(resource.name);
        continue;
      }
      fieldDecisions.set(resource.name, read.fieldDecision);
      const allows = (read.rowFilterSources ?? []).filter((source) => source.effect === "ALLOW");
      // Every ALLOW grant filtered: some rows only. One without a filter makes the OR every row.
      if (allows.length > 0 && allows.every((source) => source.whereClause !== null && source.whereClause !== undefined)) limited.add(resource.name);
    }
    for (const { widget, tables, shown } of widgets) {
      const reads = (name: string) => tables.some((t) => `${t.schema}.${t.name}` === name);
      for (const resource of resources.filter((r) => limited.has(r.name) && reads(r.name))) {
        issues.push(issue({
          code: "WIDGET_IGNORES_ROW_FILTER", severity: "warning", role, resource, widget,
          message: `The widget ${widget.name} reads ${resource.name}, which ${role.name} may read only some rows of, and its SQL never filters by $USER: ${role.name} sees every row through it.`,
        }));
      }
      for (const resource of resources.filter((r) => unreadable.has(r.name) && reads(r.name))) {
        issues.push(issue({
          code: "WIDGET_READS_UNREADABLE_TABLE", severity: "info", role, resource, widget,
          message: `The widget ${widget.name} reads ${resource.name}, which ${role.name} may not read through the Data API, and its SQL never filters by $USER: ${role.name} sees what it shows of every row - fine for figures of everyone.`,
        }));
      }
      for (const resource of resources) {
        const decide = fieldDecisions.get(resource.name);
        const [schema, table] = [resource.name.slice(0, resource.name.indexOf(".")), resource.name.slice(resource.name.indexOf(".") + 1)];
        const hidden = [...new Set(shown.filter((c) => c.schema === schema && c.table === table).map((c) => c.column))]
          .filter((column) => isProtectedField(schema, table, column) || (decide !== undefined && decide(column) !== "ALLOW"));
        if (hidden.length === 0) continue;
        issues.push(issue({
          code: "WIDGET_SHOWS_HIDDEN_FIELD", severity: "warning", role, resource, widget, columns: hidden,
          message: `The widget ${widget.name} shows ${hidden.join(", ")} of ${resource.name}, which ${role.name} may not read: its SQL runs with the dashboard's authority, so ${role.name} sees ${hidden.length === 1 ? "it" : "them"} through it.`,
        }));
      }
    }
  }
  return issues;
}
