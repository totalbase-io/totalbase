import type { JsonSchema } from "@totalbase/openapi";
import { ROLE_COLOR_OPTIONS } from "@totalbase/permissions";
import { WIDGET_CATALOG } from "@totalbase/tb-catalog";
import { arrayOf, DATE_TIME, object, ref, UUID } from "./openapi-admin-docs.js";

/**
 * Admin API docs for /admin/api/dataviews (admin-dataviews.ts,
 * admin-dataviews-states.ts) and /admin/api/app/menu (app-menu.ts).
 * Schemas mirror @totalbase/dataviews' AdminDataView / AdminDataViewField /
 * AdminDataViewPublish / SyncFieldsResult / DetailCandidate /
 * StateShareRecipient and @totalbase/app-menu's MenuNode / MenuInput.
 * A DataView's `viewConfig` and a field's `config` are large, evolving JSON
 * documents: only their top-level shape is described here.
 */

const CUSTOM_SPEC = "specs/DataViews.md";
const TEXT_OR_NULL: JsonSchema = { type: ["string", "null"] };
const INT: JsonSchema = { type: "integer" };
const INT_OR_NULL: JsonSchema = { type: ["integer", "null"] };
const UUID_OR_NULL: JsonSchema = { type: ["string", "null"], format: "uuid" };

export const DATAVIEW_TYPE: JsonSchema = {
  type: "string",
  enum: ["TABLE", "FORM", "CARDS", "MAP", "KANBAN", "CALENDAR", "GANTT", "TREE", "EXTERNALFRAME", "MASTER_DETAIL", "CUSTOM", "SETTINGS"],
  description: "The layout. Every type but EXTERNALFRAME has a designed page (widgets, variables, Code); EXTERNALFRAME has no source.",
};
export const DATAVIEW_SCOPE: JsonSchema = {
  type: "string",
  enum: ["LISTED", "EMBEDDED_ONLY"],
  description: "LISTED shows in the App's menu and list; EMBEDDED_ONLY is only mounted inside another page (the \"Show in the App menu\" switch).",
};
export const DATAVIEW_COLOR: JsonSchema = { type: ["string", "null"], enum: [...ROLE_COLOR_OPTIONS, null] };
export const DATAVIEW_WIDGET_NAME: JsonSchema = {
  type: "string",
  enum: Object.keys(WIDGET_CATALOG),
  description: "A widget of the widget catalog (WIDGET_CATALOG, @totalbase/tb-catalog): U* are Nuxt UI components, T* TotalBase's own.",
};

/** `viewConfig` - opaque per-layout settings, stored as JSON (its keys are the stored document's). */
export const DATAVIEW_VIEW_CONFIG: JsonSchema = {
  type: "object",
  additionalProperties: true,
  description:
    "Per-layout settings, stored as-is. Common keys: `features` (toolbar switches), `edit_presentation` (how a grid's " +
    "record opens), `column_sync` (auto_show | auto_hide | locked), `last_attnum` (the source columns seen so far - " +
    "server-maintained), `kanban_layout`/`gantt_layout`/`tree_layout`, `frame_url` (EXTERNALFRAME), and on a page `variables` " +
    `(VALUE / RESOURCE / CALL / RECORD definitions, ${CUSTOM_SPEC} §8) and \`record\` (§8.5).`,
};

const FIELD_CONFIG: JsonSchema = {
  type: "object",
  additionalProperties: true,
  description:
    "A COLUMN/RELATED field: how the list shows it (`truncate`, `copyable`, `total`, a FORM's `searchable`) - never its " +
    "title or presentation, which are its table's column's (refused, `DATAVIEW_COLUMN_INVALID`) - plus, on a read, the keys " +
    "its column's type derives (`displayFormatKind`, `displayFormatTzAware`, `isJsonColumn`) and a foreign key's display its " +
    "table's row presentation gives (`display_field`, `display_template`, `display_inherited`) - never stored. " +
    `A WIDGET field: \`{ props, bindings, emits, slot }\` (${CUSTOM_SPEC} §9).`,
};

const COLUMN_PRESENTATION: JsonSchema = {
  type: "object",
  additionalProperties: true,
  description:
    "A resource column's presentation, set once on the resource (" + CUSTOM_SPEC + " §15): label, description, " +
    "help, placeholder, icon, iconPosition, displayFormat, emptyText, booleanLabels, linkType, options, and cell style.",
};

const DATAVIEW_BASE_PROPERTIES: Record<string, JsonSchema> = {
  id: UUID,
  name: { type: "string" },
  slug: { type: "string" },
  description: TEXT_OR_NULL,
  menuLabel: { ...TEXT_OR_NULL, description: "What the App menu shows - null: its name." },
  icon: TEXT_OR_NULL,
  color: DATAVIEW_COLOR,
  sourceResource: { ...UUID_OR_NULL, description: "The source TABLE/VIEW resource; null for an EXTERNALFRAME, or a CUSTOM page without a record table." },
  sourceResourceSchema: TEXT_OR_NULL,
  sourceResourceName: { type: ["string", "null"], description: "With the schema, how the Data API addresses the source: `/api/{schema}/table/{name}`." },
  sourceResourceType: { type: ["string", "null"], enum: ["TABLE", "VIEW", null], description: "A VIEW source stays read-only whatever the layout." },
  sourceResourceOid: INT_OR_NULL,
  viewType: DATAVIEW_TYPE,
  scope: DATAVIEW_SCOPE,
  viewConfig: DATAVIEW_VIEW_CONFIG,
  code: { type: "string", description: "The page's client-side controller code (draft)." },
  liveVersion: { type: ["integer", "null"], description: "The live (highest) published version; null until first published." },
  createdAt: DATE_TIME,
  updatedAt: DATE_TIME,
};
const DATAVIEW_BASE_REQUIRED = Object.keys(DATAVIEW_BASE_PROPERTIES);

export const DATAVIEW_SCHEMAS: Record<string, JsonSchema> = {
  get WidgetPlacement(): JsonSchema {
    return object(WIDGET_PLACEMENT_PROPERTIES, ["widget"]);
  },
  DataViewBase: {
    ...object(DATAVIEW_BASE_PROPERTIES, DATAVIEW_BASE_REQUIRED),
    description: "A DataView's own row (`dataviews` plus its source resource's identity and the live version).",
  },
  DataViewVariableResource: object(
    {
      schema: { type: "string" },
      name: { type: "string" },
      type: { type: "string", enum: ["TABLE", "VIEW", "FUNCTION"] },
      columns: { type: "object", additionalProperties: { type: "string" }, description: "A table's or a view's columns: name -> PostgreSQL type (`format_type()`)." },
      relations: { type: "object", additionalProperties: { type: "string", format: "uuid" }, description: "Its single-column foreign keys: column -> the resource id it points at (its presentation is in `columnPresentation`) - a related column's title." },
      displays: {
        type: "object",
        description: "How each foreign key shows (DataViews.md §15.5): its table's row presentation, else its default column - a Table reads the target's rows by it. Absent when every key shows itself.",
        additionalProperties: object(
          { schema: { type: "string" }, table: { type: "string" }, column: { type: "string", description: "The target's key column." }, displayField: { type: "string" }, displayTemplate: { type: "string" } },
          ["schema", "table", "column", "displayField"],
        ),
      },
    },
    ["schema", "name", "type"],
  ),
  DataView: {
    allOf: [
      ref("DataViewBase"),
      object(
        {
          columnPresentation: {
            type: "object",
            additionalProperties: { type: "object", additionalProperties: COLUMN_PRESENTATION },
            description: "What it inherits from its resources' columns: `{ <resource id>: { <column>: presentation } }` - live on a draft read, the version's frozen copy on a published one.",
          },
          variableResources: {
            type: "object",
            additionalProperties: ref("DataViewVariableResource"),
            description: "Page types only (absent on an EXTERNALFRAME): the resources its variables name, by resource id.",
          },
          variableWorkflows: {
            type: "object",
            additionalProperties: object({ slug: { type: "string" }, name: { type: "string" } }, ["slug", "name"]),
            description: "Page types only: the workflows its Calls run, by workflow id - the slug the App runs each by. A deleted workflow is absent.",
          },
          sourceResourcePrimaryKey: {
            ...arrayOf({ type: "string" }),
            description: "The source's primary key column(s) - absent when there is no source.",
          },
        },
        ["columnPresentation"],
      ),
    ],
  },
  DataViewWithStatus: {
    allOf: [ref("DataView"), object({ hasUnpublishedChanges: { type: "boolean", description: `The draft differs from the live version, or it was never published (specs/Foundations.md §13.5).` } }, ["hasUnpublishedChanges"])],
  },
  DataViewListItem: {
    allOf: [ref("DataViewBase"), object({ hasUnpublishedChanges: { type: "boolean" } }, ["hasUnpublishedChanges"])],
  },
  DataViewField: object(
    {
      id: UUID,
      kind: {
        type: "string",
        enum: ["COLUMN", "RELATED", "WIDGET"],
        description: "COLUMN: a source column. RELATED: a column of the table a foreign key points at (`brand.country`), read-only. WIDGET: a widget of the page.",
      },
      parent: { ...UUID_OR_NULL, description: "WIDGET only: the widget whose slot (`config.slot`) holds it; null on the canvas." },
      gridX: INT,
      gridY: INT,
      gridW: INT,
      gridH: INT,
      label: { type: ["string", "null"], description: "A WIDGET's name. Always null on a COLUMN/RELATED field: its title is its column's presentation." },
      icon: TEXT_OR_NULL,
      columnAttnum: { type: ["integer", "null"], description: "COLUMN only - the column's attnum, kept across renames." },
      columnName: { type: ["string", "null"], description: "COLUMN: the column; RELATED: its dotted path (`brand.country`)." },
      relationAttnum: { type: ["integer", "null"], description: "RELATED only: the foreign key's column on the source." },
      targetAttnum: { type: ["integer", "null"], description: "RELATED only: the column on the table it points at." },
      widget: { type: ["string", "null"], description: "A column's input/display widget, or a WIDGET's widget catalog name." },
      visible: { type: "boolean" },
      config: FIELD_CONFIG,
      relatedDataview: { ...UUID_OR_NULL, description: "WIDGET only: the DataView it shows (a TDataView's)." },
      relatedDashboard: { ...UUID_OR_NULL, description: "WIDGET only: the Dashboard it shows (an embedded Dashboard's)." },
      inherited: { ...COLUMN_PRESENTATION, description: "COLUMN/RELATED, on a read, when its resource column has a presentation: its title, format, look and conditions." },
      dataType: { type: "string", description: "COLUMN/RELATED, on a read: its column's PostgreSQL type now; absent when the column no longer exists." },
    },
    [
      "id", "kind", "parent", "gridX", "gridY", "gridW", "gridH", "label", "icon", "columnAttnum", "columnName",
      "relationAttnum", "targetAttnum", "widget", "visible", "config", "relatedDataview", "relatedDashboard",
    ],
  ),
  DataViewVersion: object(
    {
      id: UUID,
      dataview: UUID,
      version: INT,
      restoredFromVersion: { type: ["integer", "null"], description: "Set when the snapshot equals an older version (published after a Restore)." },
      user: { ...UUID_OR_NULL, description: "Who published it." },
      publishedAt: DATE_TIME,
      note: { type: ["string", "null"], description: "The publisher's note on what this version changes." },
    },
    ["id", "dataview", "version", "restoredFromVersion", "user", "publishedAt", "note"],
  ),
  DataViewVersionContent: object(
    {
      id: UUID,
      version: INT,
      restoredFromVersion: INT_OR_NULL,
      user: UUID_OR_NULL,
      publishedAt: DATE_TIME,
      note: { type: ["string", "null"], description: "The publisher's note on what this version changes." },
      dataview: { ...ref("DataView"), description: "The DataView with that version's `viewConfig`, `code` and `columnPresentation`." },
      fields: { ...arrayOf(ref("DataViewField")), description: "That version's fields." },
    },
    ["id", "version", "restoredFromVersion", "user", "publishedAt", "note", "dataview", "fields"],
  ),
  DataViewSyncFieldsResult: object(
    {
      added: { ...arrayOf(ref("DataViewField")), description: "Columns created after the DataView last looked (per `viewConfig.column_sync`)." },
      renamed: { ...arrayOf(object({ fieldId: UUID, from: { type: "string" }, to: { type: "string" } }, ["fieldId", "from", "to"])), description: "Fields whose column was renamed - corrected in place." },
      orphaned: { ...arrayOf(ref("DataViewField")), description: "Fields whose column was dropped - never deleted automatically; delete them explicitly." },
    },
    ["added", "renamed", "orphaned"],
  ),
  DataViewDetailCandidate: object(
    {
      resourceId: UUID,
      schema: { type: "string" },
      table: { type: "string" },
      fkColumn: { type: "string", description: "The detail table's column referencing the master." },
    },
    ["resourceId", "schema", "table", "fkColumn"],
  ),
  DataViewJunction: object(
    {
      resourceId: UUID,
      schema: { type: "string" },
      table: { type: "string" },
      primaryKey: { type: "string", description: "The junction's single-column primary key - a removed link is deleted by it." },
      column: { type: "string", description: "Its column referencing the record's table." },
      otherColumn: { type: "string", description: "Its column referencing the other table - what the field picks." },
      target: object(
        {
          resourceId: { type: ["string", "null"], format: "uuid", description: "The other table's resource - null when it isn't an ACTIVE one." },
          schema: { type: "string" },
          table: { type: "string" },
          column: { type: "string", description: "The column the junction's key references." },
        },
        ["resourceId", "schema", "table", "column"],
      ),
    },
    ["resourceId", "schema", "table", "primaryKey", "column", "otherColumn", "target"],
  ),
};

/** POST /admin/api/dataviews - the creation wizard's whole payload. */
const FIELD_OVERRIDES: JsonSchema = {
  type: "object",
  description: "Per-column overrides, keyed by column name.",
  additionalProperties: object({
    widget: { type: "string", description: "A column widget name." },
    help: { type: "string" },
    searchable: { type: "boolean", description: "FORM only: the column is searchable from the record stepper." },
  }),
};

export const CREATE_DATAVIEW_BODY: JsonSchema = object(
  {
    name: { type: "string", maxLength: 32 },
    slug: { type: "string", maxLength: 32, description: "Proposed from `name` when omitted." },
    description: { type: ["string", "null"], maxLength: 128 },
    icon: TEXT_OR_NULL,
    color: DATAVIEW_COLOR,
    sourceResourceId: { ...UUID, description: "An ACTIVE TABLE or VIEW resource. Required for every type but EXTERNALFRAME and CUSTOM (a page may get one later)." },
    viewType: DATAVIEW_TYPE,
    selectedColumns: { ...arrayOf({ type: "string" }), description: "Columns shown; omitted = every column. The primary key is always kept (hidden when not selected)." },
    viewConfig: DATAVIEW_VIEW_CONFIG,
    fieldOverrides: FIELD_OVERRIDES,
    detail: {
      ...object(
        {
          resourceId: { ...UUID, description: "One of GET /admin/api/dataviews/detail-candidates." },
          fkColumn: { type: "string" },
          selectedColumns: arrayOf({ type: "string" }),
          fieldOverrides: FIELD_OVERRIDES,
        },
        ["resourceId", "fkColumn"],
      ),
      description: "MASTER_DETAIL only: the detail table and its FK column pointing at the master.",
    },
  },
  ["name", "viewType"],
);

export const UPDATE_DATAVIEW_BODY: JsonSchema = object({
  name: { type: "string", maxLength: 32 },
  slug: { type: "string", maxLength: 32 },
  description: { type: ["string", "null"], maxLength: 128 },
  menuLabel: { type: ["string", "null"], maxLength: 32, description: "What the App menu shows - empty or null: its name. Applies at once, never versioned." },
  icon: TEXT_OR_NULL,
  color: DATAVIEW_COLOR,
  viewConfig: { ...DATAVIEW_VIEW_CONFIG, description: "Shallow-merged into the stored viewConfig (top-level keys replace, others stay). `variables` and `record` are validated on a page." },
  scope: DATAVIEW_SCOPE,
  sourceResourceId: { ...UUID, description: "A CUSTOM page's record table, only while it has none; must be a TABLE." },
  viewType: { ...DATAVIEW_TYPE, description: "A list DataView's main view - the one it opens with: another list type among its `layouts`. Any other change of type is refused." },
});

export const UPDATE_FIELD_BODY: JsonSchema = object({
  label: { ...TEXT_OR_NULL, description: "A WIDGET's name. A COLUMN/RELATED field takes none (its column's title) - only null." },
  widget: { type: "string", description: "A column widget, or (WIDGET field) a widget catalog name." },
  visible: { type: "boolean" },
  config: { ...FIELD_CONFIG, description: "Replaces the field's config. A WIDGET's is validated against the widget catalog and the page's variables." },
  gridX: INT,
  gridY: INT,
  gridW: INT,
  gridH: INT,
  parent: { ...UUID_OR_NULL, description: "WIDGET fields only: the parent widget (null = the canvas); `config.slot` names its slot." },
});

export const ADD_WIDGET_BODY: JsonSchema = object(
  {
    widget: DATAVIEW_WIDGET_NAME,
    label: TEXT_OR_NULL,
    config: {
      ...object({
        props: { type: "object", additionalProperties: true, description: "Merged over the catalog's defaults." },
        bindings: { type: "object", additionalProperties: true },
        emits: { type: "object", additionalProperties: true },
        slot: { type: "string", description: "The parent widget's slot it goes in." },
      }),
      description: `${CUSTOM_SPEC} §9.`,
    },
    parent: { ...UUID_OR_NULL, description: "The parent widget's field id; omitted/null = the canvas." },
  },
  ["widget"],
);

/** One widget of a tree to place (`POST .../widgets/tree`): `ADD_WIDGET_BODY` plus its size and what it holds. */
const WIDGET_PLACEMENT_PROPERTIES: Record<string, JsonSchema> = {
  ...(ADD_WIDGET_BODY.properties as Record<string, JsonSchema>),
  gridW: { ...INT, description: "Its width in columns of 12 (default 12)." },
  gridH: { ...INT, description: "Its height in rows (default 1) - sizable widgets only." },
  children: { type: "array", items: ref("WidgetPlacement"), description: "Widgets it holds, each with its slot in `config.slot` - placed after it, inside it." },
};

export const ADD_WIDGETS_TREE_BODY: JsonSchema = object(
  { widgets: arrayOf(ref("WidgetPlacement")) },
  ["widgets"],
);

export const MOVE_WIDGET_BODY: JsonSchema = object({
  parent: { ...UUID_OR_NULL, description: "The widget it goes in (null = the page itself); omitted: where it is." },
  slot: { type: "string", description: "The parent's slot; omitted: the one it is in when it stays in its parent." },
  position: { ...INT, description: "Its place in that area, 0 = first; omitted = last." },
});

// --- App menu (Security.md §8) ---

export const APP_MENU_SCHEMAS: Record<string, JsonSchema> = {
  AppMenuObject: object(
    {
      kind: { type: "string", enum: ["DATAVIEW", "DASHBOARD"] },
      id: UUID,
      name: { type: "string" },
      slug: { type: "string" },
      menuLabel: { ...TEXT_OR_NULL, description: "What the menu shows - null: its name." },
      description: { ...TEXT_OR_NULL, description: "Its description - the menu's tooltip." },
      icon: TEXT_OR_NULL,
      color: TEXT_OR_NULL,
      viewType: { type: ["string", "null"], description: "DataViews only - its layout; null for a Dashboard." },
    },
    ["kind", "id", "name", "slug", "menuLabel", "description", "icon", "color", "viewType"],
  ),
  AppMenuGroup: object(
    {
      kind: { type: "string", enum: ["GROUP"] },
      id: UUID,
      name: { type: "string" },
      icon: TEXT_OR_NULL,
      iconOpen: { ...TEXT_OR_NULL, description: "Shown instead of `icon` while the group is open in the tree menu; null: `icon` in both states." },
      openState: { type: "string", enum: ["DEFAULT", "OPEN", "CLOSED"], description: "How it starts in the tree menu - DEFAULT: the menu's `groupsOpen`." },
      children: arrayOf(ref("AppMenuNode")),
    },
    ["kind", "id", "name", "icon", "iconOpen", "openState", "children"],
  ),
  AppMenuNode: { oneOf: [ref("AppMenuGroup"), ref("AppMenuObject")] },
  AdminAppMenu: object(
    {
      mode: { type: "string", enum: ["TREE", "SIDEBAR"], description: "The `app.menu_mode` setting." },
      groupsOpen: { type: "string", enum: ["CURRENT", "OPEN", "CLOSED"], description: "The `app.menu_groups_open` setting: how the tree menu's groups start - CURRENT, only the one holding the page." },
      search: { type: "string", enum: ["AUTO", "ALWAYS", "NEVER"], description: "The `app.menu_search` setting: whether the menu offers its search box - AUTO, once a viewer sees more than 15 entries." },
      nodes: {
        ...arrayOf(ref("AppMenuNode")),
        description:
          "The stored arrangement over every published LISTED DataView and Dashboard: items whose object is no longer published " +
          "are left out; published objects with no place yet are appended to the root.",
      },
      hidden: {
        ...arrayOf(ref("AppMenuObject")),
        description:
          "Published EMBEDDED_ONLY DataViews and Dashboards, by name - kept out of the menu, and shown in it again by setting " +
          "their `scope` to LISTED. A DataView another one owns (a Master-detail's items) is never listed.",
      },
    },
    ["mode", "groupsOpen", "search", "nodes", "hidden"],
  ),
  AppMenuInput: {
    oneOf: [
      object(
        {
          kind: { type: "string", enum: ["GROUP"] },
          id: { ...UUID, description: "Keep an existing group's id; omit for a new group." },
          name: { type: "string" },
          icon: TEXT_OR_NULL,
          iconOpen: TEXT_OR_NULL,
          openState: { type: "string", enum: ["DEFAULT", "OPEN", "CLOSED"], description: "Omitted: DEFAULT." },
          children: arrayOf(ref("AppMenuInput")),
        },
        ["kind", "name", "children"],
      ),
      object({ kind: { type: "string", enum: ["DATAVIEW", "DASHBOARD"] }, id: { ...UUID, description: "The DataView's or Dashboard's id." } }, ["kind", "id"]),
    ],
  },
};
