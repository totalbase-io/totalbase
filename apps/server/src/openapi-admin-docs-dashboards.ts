import { DASHBOARD_REFRESH_INTERVALS, DASHBOARD_VARIABLE_TYPES, DASHBOARD_WIDGET_TYPES, DATE_RANGE_PRESETS } from "@totalbase/dashboards";
import type { JsonSchema } from "@totalbase/openapi";
import { ROLE_COLOR_OPTIONS } from "@totalbase/permissions";
import { arrayOf, DATE_TIME, object, ref, UUID } from "./openapi-admin-docs.js";

/**
 * Admin API docs for /admin/api/dashboards (admin-dashboards.ts). Schemas
 * mirror @totalbase/dashboards' AdminDashboard / AdminDashboardWidget /
 * AdminDashboardVersion / DashboardQueryResult.
 */

const SPEC = "specs/Dashboards.md";
const TEXT_OR_NULL: JsonSchema = { type: ["string", "null"] };
const INT: JsonSchema = { type: "integer" };

export const DASHBOARD_SCOPE: JsonSchema = {
  type: "string",
  enum: ["LISTED", "EMBEDDED_ONLY"],
  description: "LISTED shows in the App's menu and list; EMBEDDED_ONLY is only mounted inside a DataView page (a TDashboard widget).",
};
export const DASHBOARD_REFRESH_INTERVAL: JsonSchema = {
  type: ["integer", "null"],
  enum: [...DASHBOARD_REFRESH_INTERVALS.map((interval) => interval.seconds), null],
  description:
    `The App viewer re-runs every widget this often, in seconds, while its tab is visible; null = off (${SPEC} §9.4). ` +
    "Applies at once (not versioned); the editor's canvas doesn't auto-refresh.",
};
export const DASHBOARD_COLOR: JsonSchema = { type: ["string", "null"], enum: [...ROLE_COLOR_OPTIONS, null] };
export const DASHBOARD_WIDGET_TYPE: JsonSchema = {
  type: "string",
  enum: [...DASHBOARD_WIDGET_TYPES],
  description: `The dashboard widget catalog (@totalbase/tb-catalog, ${SPEC} §5). A presentation widget (TImage, THeading, TText, UBadge, UAlert, USeparator, UProgress, TQrCode, TFrame - §5.11) is the page catalog's: its config holds \`props\` and \`bindings\`, its query is optional.`,
};

/** `{ variables: { <name>: value } }` - the viewer-chosen `$VAR.*` values of a widget execution. */
export const DASHBOARD_VARIABLE_VALUES: JsonSchema = {
  type: "object",
  additionalProperties: true,
  description:
    "Values by variable name, validated per the variable's type and bound as cast parameters (never interpolated). " +
    "A missing name uses the definition's default; an empty value binds NULL. DATE_RANGE: a preset or `{from, to}` " +
    "(YYYY-MM-DD); SELECT: a string, or an array when `multiple`; TEXT: a string; NUMBER: a number.",
};

const VARIABLE_OPTIONS: JsonSchema = {
  oneOf: [
    object({ source: { type: "string", enum: ["STATIC"] }, values: arrayOf({ type: "string" }) }, ["source", "values"]),
    object(
      { source: { type: "string", enum: ["QUERY"] }, query: { type: "string", description: "Read-only SQL: first column = value, optional second = label. May use `$USER.*`, not `$VAR.*`." } },
      ["source", "query"],
    ),
  ],
};

/** A dashboard's tabs (D7, §7.2) - UTabs' items. */
export const DASHBOARD_TABS: JsonSchema = {
  ...arrayOf(object({ value: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" }, label: { type: "string", maxLength: 32 }, icon: { type: "string" } }, ["value", "label"])),
  description: `Its tabs, in order (${SPEC} §7.2) - none: one grid. The App keeps the open one in \`?tab=<value>\`. A tab with widgets can't be removed (DASHBOARD_TAB_NOT_EMPTY); [] joins every widget in one grid.`,
};

export const DASHBOARD_SCHEMAS: Record<string, JsonSchema> = {
  DashboardVariable: {
    ...object(
      {
        name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$", description: "Referenced in widget SQL as `$VAR.<name>` (`$VAR.<name>.from`/`.to` for a DATE_RANGE)." },
        label: { type: "string" },
        type: { type: "string", enum: [...DASHBOARD_VARIABLE_TYPES] },
        multiple: { type: "boolean", description: "SELECT only: binds `text[]` instead of `text`." },
        options: { ...VARIABLE_OPTIONS, description: "SELECT only: a static list or an options query." },
        default: { description: `Same shape as a value; absent = NULL. DATE_RANGE presets: ${DATE_RANGE_PRESETS.join(", ")}.` },
        dependsOn: { type: "array", items: { type: "string" }, readOnly: true, description: "SELECT with an options query: the variables the query reads as `$VAR.*`, derived from it - reload the options when one changes. Chains are acyclic." },
      },
      ["name", "label", "type"],
    ),
    description: `A \`$VAR.*\` definition - a viewer-chosen filter, never a security boundary (${SPEC} §3).`,
  },
  Dashboard: object({
    id: UUID,
    name: { type: "string", maxLength: 32 },
    slug: { type: "string", maxLength: 32 },
    description: { ...TEXT_OR_NULL, maxLength: 128 },
    menuLabel: { ...TEXT_OR_NULL, maxLength: 32, description: "What the App menu shows - null: its name." },
    icon: TEXT_OR_NULL,
    color: DASHBOARD_COLOR,
    scope: DASHBOARD_SCOPE,
    refreshIntervalSeconds: DASHBOARD_REFRESH_INTERVAL,
    embeddingEnabled: { type: "boolean", description: "A signed embed token may show its published version outside TotalBase. Off by default." },
    delegable: { type: "boolean", description: "A manager may open it to the roles below theirs (Security.md §9.7). Off by default." },
    variables: { ...arrayOf(ref("DashboardVariable")), description: "The draft's variable definitions." },
    tabs: DASHBOARD_TABS,
    createdAt: DATE_TIME,
    updatedAt: DATE_TIME,
  }),
  DashboardWithStatus: {
    allOf: [
      ref("Dashboard"),
      object({ hasUnpublishedChanges: { type: "boolean", description: "The draft differs from the latest version, or there is none." } }),
    ],
  },
  DashboardListItem: {
    allOf: [
      ref("DashboardWithStatus"),
      object({ liveVersion: { type: ["integer", "null"], description: "The live (highest) version; null until first published." } }),
    ],
  },
  DashboardWidgetContent: object({
    id: UUID,
    dashboard: UUID,
    type: DASHBOARD_WIDGET_TYPE,
    label: TEXT_OR_NULL,
    gridX: { ...INT, description: "Column on the 12-column canvas." },
    gridY: INT,
    gridW: INT,
    gridH: INT,
    query: { type: ["string", "null"], description: "Admin-authored read-only SQL; null = not configured yet (a presentation widget draws without one)." },
    config: {
      type: "object",
      additionalProperties: true,
      description: `Column mapping and appearance - only the properties the widget type's catalog entry defines (${SPEC} §5.3); a presentation widget's page props and formulas (§5.11). Any widget's \`bindings.title\` is its title as a formula.`,
    },
    tab: { type: ["string", "null"], description: "The tab it is on (a value of the dashboard's tabs) - null: the first." },
    referencedVariables: { ...arrayOf({ type: "string" }), description: "`$VAR.*` names the query uses - re-run only widgets a changed value affects." },
  }),
  DashboardWidget: { allOf: [ref("DashboardWidgetContent"), object({ createdAt: DATE_TIME, updatedAt: DATE_TIME })] },
  DashboardVersion: object({
    id: UUID,
    dashboard: UUID,
    version: INT,
    restoredFromVersion: { type: ["integer", "null"], description: "Set when the published draft equalled an older version (a Restore)." },
    user: { type: ["string", "null"], format: "uuid", description: "Who published it." },
    publishedAt: DATE_TIME,
    note: { type: ["string", "null"], description: "The publisher's note on what this version changes." },
  }),
  DashboardVersionSnapshot: {
    allOf: [
      ref("DashboardVersion"),
      object({
        widgets: { ...arrayOf(ref("DashboardWidgetContent")), description: "The widgets as published - a snapshot carries no timestamps." },
        variables: arrayOf(ref("DashboardVariable")),
        tabs: DASHBOARD_TABS,
      }),
    ],
  },
  DashboardQueryResult: object({
    columns: arrayOf(object({
      name: { type: "string" },
      dataType: { type: "string", description: "PostgreSQL type name (format_type)." },
      origin: {
        ...object({ schema: { type: "string" }, table: { type: "string" }, column: { type: "string" }, resourceId: { type: ["string", "null"] } }),
        description: "The table's (or view's) column it is, when referenced as is - none for an expression.",
      },
      presentation: { type: "object", additionalProperties: true, description: "That column's presentation (label, format, a CHECK list's values)." },
      lossy: { type: "boolean", description: "A numeric/bigint value too long for a number arrives as its exact decimal text." },
    })),
    rows: arrayOf({ type: "object", additionalProperties: true }),
    truncated: { type: "boolean", description: "The row cap (`dashboards.query_max_rows`) cut the result short." },
    durationMs: { type: "integer", description: "How long the query took, in milliseconds." },
    totals: { type: ["object", "null"], additionalProperties: true, description: "A TABLE's totals by column (`columnSettings.<column>.total`) - computed by PostgreSQL over every row the query returns, not only those sent (D28)." },
    marks: {
      type: ["object", "null"],
      additionalProperties: true,
      description: "Thresholds' and reference lines' values resolved on the server (D5): `thresholds` (each `from`), `references` (each `value`, or `from`/`to` of a band) - a column of the widget's row or a variable's value; null when it has no number.",
    },
    files: {
      type: ["object", "null"],
      additionalProperties: object({ url: { type: ["string", "null"] }, name: { type: "string" }, mimeType: { type: "string" }, image: { type: "boolean" }, blocked: { type: "boolean" } }),
      description: "Each file a file column returned (D14): a link TotalBase signs for this widget and file, 15 minutes - its route checks the signature alone. In an embed, a file that isn't PUBLIC has no url (blocked) unless the embed allows files.",
    },
    cached: { type: "boolean", description: "True for a published widget's result reused from the server's cache (`dashboards.cache_seconds`, or the dashboard's refresh interval); `durationMs` is then the run that filled it. A viewer's Refresh sends `\"fresh\": true` beside `data` to skip it." },
  }),
  DashboardDraftRun: {
    allOf: [
      ref("DashboardQueryResult"),
      object({ roles: { type: "object", additionalProperties: true, description: "Each role's columns, source (config | default), rule (first-of-kind | all-of-kind) and reason {code, message, detail} - DM3. A viewer's run has none." } }),
    ],
  },
  DashboardVariableOption: object({ value: { type: "string" }, label: { type: "string" } }),
  DashboardDecision: {
    ...object({
      code: { type: "string", description: "Fixed, kebab-case - one of the guide's Reasons (`totalbase://guide/dashboards`)." },
      message: { type: "string", description: "The sentence, in the App's language (`system.language`)." },
      detail: { type: "string", description: "What was read - a type, a constraint, a column. Never translated." },
    }, ["code", "message"]),
    description: `An automatic decision and why (${SPEC} §5.19, DM3).`,
  },
  DashboardSpec: {
    ...object({
      name: { type: "string", maxLength: 32 },
      slug: { type: "string", maxLength: 32, description: "Unset on a new one: from its name." },
      description: { ...TEXT_OR_NULL, maxLength: 128 },
      icon: TEXT_OR_NULL,
      menuLabel: { ...TEXT_OR_NULL, maxLength: 32 },
      color: DASHBOARD_COLOR,
      scope: DASHBOARD_SCOPE,
      refreshIntervalSeconds: DASHBOARD_REFRESH_INTERVAL,
      variables: arrayOf(ref("DashboardVariable")),
      tabs: DASHBOARD_TABS,
      widgets: arrayOf(object({
        id: { ...UUID, description: "This dashboard's widget, kept - unset: a new one." },
        type: DASHBOARD_WIDGET_TYPE,
        label: TEXT_OR_NULL,
        tab: { type: ["string", "null"] },
        grid: { ...object({ x: INT, y: INT, w: INT, h: INT }, ["x", "y", "w", "h"]), description: "Unset: placed in order at its type's default size." },
        query: { type: ["string", "null"] },
        config: { type: "object", additionalProperties: true },
      }, ["type"])),
    }, ["name", "widgets"]),
    description: `A dashboard's whole draft as one document (${SPEC} §10.6, DM2) - who sees it isn't part of it.`,
  },
  DashboardSpecDocument: object({
    id: UUID,
    draftVersion: { type: "string", description: "The draft as it is now - apply's draftVersion compares it (409 DASHBOARD_DRAFT_CHANGED when it moved)." },
    liveVersion: { type: ["integer", "null"] },
    hasUnpublishedChanges: { type: "boolean" },
    access: object({
      roleIds: arrayOf(UUID),
      embeddingEnabled: { type: "boolean" },
      embeds: arrayOf(object({ id: UUID, name: { type: "string" }, type: { type: "string" }, revoked: { type: "boolean" }, expiresAt: { type: ["string", "null"] }, notices: arrayOf(ref("DashboardDecision")) })),
    }),
    spec: ref("DashboardSpec"),
  }),
  DashboardApplySpec: object({
    spec: ref("DashboardSpec"),
    draftVersion: { type: "string", description: "From get - the draft must not have changed since. Unset: applied anyway." },
    dryRun: { type: "boolean", description: "Check and answer the difference only." },
    rows: { type: "integer", minimum: 0, maximum: 50, description: "Each widget's first rows in the answer - 0 (the default) runs none." },
  }, ["spec"]),
  DashboardApplyResult: object({
    id: { type: ["string", "null"], format: "uuid" },
    created: { type: "boolean" },
    applied: { type: "boolean", description: "False on a dry run, or when nothing changes." },
    draftVersion: { type: ["string", "null"] },
    diff: { type: "object", additionalProperties: true, description: "dashboard (keys), variables {added, removed, changed}, tabs, widgets {created, changed (keys), deleted}." },
    widgets: arrayOf(object({
      path: { type: "string" },
      id: { type: ["string", "null"], format: "uuid" },
      columns: { type: ["array", "null"], items: { type: "object", additionalProperties: true }, description: "Each column's type, kind, lossy and origin (DM8)." },
      roles: { type: ["object", "null"], additionalProperties: true, description: "Each role's columns, source (config | default), rule and reason (DM3)." },
      rows: arrayOf({ type: "object", additionalProperties: true }),
    })),
  }),
};

/** One line every widget-SQL route repeats - how the query runs. */
export const WIDGET_SQL_SEMANTICS =
  "Runs in its own READ ONLY transaction (always rolled back) with `dashboards.query_timeout_ms` as statement_timeout, " +
  "wrapped as a subquery capped at `dashboards.query_max_rows` (`truncated` reports the cut), one statement only. " +
  "`$USER.<column>` reads the calling admin's real user row and `$VAR.<name>` the given values - both bound as cast " +
  "parameters, never interpolated. The transaction's TimeZone is the caller's effective time zone.";
