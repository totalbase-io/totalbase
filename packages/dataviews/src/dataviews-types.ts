import type { Database } from "@totalbase/database";
import type { RelationDetail } from "@totalbase/pg-catalog";
import type { RoleColor } from "@totalbase/permissions";
import type { ColumnPresentation, RowPresentation } from "@totalbase/tb-catalog";
import type { WidgetFieldConfig } from "./widget-fields.js";

/** What every DataViews module works over - the façade's private state, passed explicitly. */
export interface DataViewsContext {
  database: Database;
  /** Resolves the instance's public URL (`system.public_url`) - an EXTERNALFRAME's URL may never point back at it (frame-url.ts). */
  ownOrigin: () => Promise<string | undefined>;
}

export type DataViewType = "TABLE" | "FORM" | "CARDS" | "MAP" | "KANBAN" | "CALENDAR" | "GANTT" | "TREE" | "EXTERNALFRAME" | "MASTER_DETAIL" | "CUSTOM" | "SETTINGS";
export type DataViewScope = "LISTED" | "EMBEDDED_ONLY";

/**
 * The types with a designed page - widgets, variables and Code
 * (Specification_DataViews.md §6.1): CUSTOM is one; FORM and
 * MASTER_DETAIL are their record form; every grid type's record form is one
 * too. Only an EXTERNALFRAME has none.
 */
export const PAGE_VIEW_TYPES: readonly DataViewType[] = ["CUSTOM", "FORM", "MASTER_DETAIL", "TABLE", "CARDS", "KANBAN", "CALENDAR", "MAP", "GANTT", "TREE"];
export function isPageViewType(viewType: DataViewType): boolean {
  return PAGE_VIEW_TYPES.includes(viewType);
}

/** A published DataView a column presentation change reaches - `affectedByColumnPresentation`. */
export interface AffectedDataView {
  id: string;
  name: string;
  slug: string;
  liveVersion: number;
  /** Its draft has other unpublished changes - publishing it would publish them too. */
  otherChanges: boolean;
}

/** `AdminDataView.columnPresentation` - each resource's columns' presentation, by resource id and column name. */
export type ColumnPresentationMap = Record<string, Record<string, ColumnPresentation>>;

/** How a row of a table shows where a foreign key points at it (Specification_DataViews.md §15.5), by resource id. */
export type RowPresentationMap = Record<string, RowPresentation>;

/** Everything a DataView inherits - `dataview_presentation()`, frozen whole in a version's `presentation_snapshot`. */
export interface InheritedPresentation {
  columns: ColumnPresentationMap;
  rows: RowPresentationMap;
}

/** A resource a page's variable names - see `AdminDataView.variableResources`. */
export interface VariableResource {
  schema: string;
  name: string;
  type: string;
  /** A table's or a view's columns: name → PostgreSQL type. */
  columns?: Record<string, string>;
  /** Its single-column foreign keys: column → the resource id it points at - a related column's title. */
  relations?: Record<string, string>;
  /** How each foreign key shows (Specification_DataViews.md §15.5) - a Table reads its target's rows by it. */
  displays?: Record<string, ForeignKeyDisplay>;
}

/** A foreign key's target table and what of its row shows: one column, or a template over several. */
export interface ForeignKeyDisplay {
  schema: string;
  table: string;
  /** The target's key column. */
  column: string;
  displayField: string;
  displayTemplate?: string;
}

export interface AdminDataView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** What the App menu shows - null: its name. Live, like the name: never part of a published version. */
  menuLabel: string | null;
  icon: string | null;
  color: RoleColor | null;
  sourceResource: string | null;
  /**
   * The source resource's real Postgres identifiers - needed by the
   * admin SPA's grid page to call the public REST Data API directly
   * (`GET /api/:schema/table/:name`, Specification_Data_API.md §2.1), which addresses
   * resources by schema+name, never by totalbase.resources' internal id.
   */
  sourceResourceSchema: string | null;
  sourceResourceName: string | null;
  /** TABLE vs. VIEW - the write-actions gate for a TABLE-layout DataView (Specification_DataViews.md §1.2: a VIEW source stays read-only regardless of layout). Not FUNCTION - excluded at create time. */
  sourceResourceType: "TABLE" | "VIEW" | null;
  /** Needed by the Design form (and the Edit form's FK picker) to call `GET /catalog/table|view/:oid` directly - already selected alongside schema/name, just not exposed until now. */
  sourceResourceOid: number | null;
  viewType: DataViewType;
  scope: DataViewScope;
  viewConfig: Record<string, unknown>;
  /**
   * CUSTOM only: the resources its variables name (a Resource's table or
   * view, a Call's function) by id, with the schema and name the Data API
   * addresses them by - variables store the id, which a rename keeps
   * (AGENTS.md section 9), and a viewer has no Admin API to look it up.
   * A table's or a view's `columns` carry each column's PostgreSQL type
   * (`format_type()`), so a Table widget formats its rows by type.
   */
  variableResources?: Record<string, VariableResource>;
  /**
   * What it inherits from its resources' columns (Specification_DataViews.md §15):
   * `{ <resource id>: { <column>: ColumnPresentation } }` for
   * every resource it reads. Live on a draft read, the version's frozen copy
   * on a published one (`dataview_column_presentation()`, migration
   * 000129). Absent from `list()`.
   */
  columnPresentation?: ColumnPresentationMap;
  /** Draft client-side controller code. `getPublishedBySlug` overrides this with the latest publish's `code_snapshot` instead - see its own doc comment. */
  code: string;
  /** The live (highest) version number - null until first published (Specification.md §13.1). */
  liveVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * The source's primary key column(s), only populated by `get()`/
   * `getBySlug()` (an extra catalog round trip - `list()` skips it to
   * avoid N+1 introspection when listing many DataViews). The Edit
   * form addresses a row via `/api/:schema/table/:resource/:pk`, which
   * only supports a single-column key - same limitation
   * `data-table-mutations.ts`'s own `singlePrimaryKeyField` already
   * enforces for bulk ops, not a new one introduced here.
   */
  sourceResourcePrimaryKey?: string[];
}

export interface DataViewRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  menu_label: string | null;
  icon: string | null;
  color: RoleColor | null;
  source_resource: string | null;
  source_resource_schema: string | null;
  source_resource_name: string | null;
  source_resource_type: "TABLE" | "VIEW" | null;
  source_resource_oid: number | null;
  view_type: DataViewType;
  scope: DataViewScope;
  view_config: Record<string, unknown>;
  code: string;
  live_version: number | null;
  created_at: Date;
  updated_at: Date;
}

export function toAdminDataView(row: DataViewRow): AdminDataView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    menuLabel: row.menu_label,
    icon: row.icon,
    color: row.color,
    sourceResource: row.source_resource,
    sourceResourceSchema: row.source_resource_schema,
    sourceResourceName: row.source_resource_name,
    sourceResourceType: row.source_resource_type,
    sourceResourceOid: row.source_resource_oid,
    viewType: row.view_type,
    scope: row.scope,
    viewConfig: row.view_config,
    code: row.code,
    liveVersion: row.live_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A version's content, as `hydrate` takes it in place of the draft's. */
export type PublishedSnapshot = { view_config_snapshot: Record<string, unknown>; code_snapshot: string; presentation_snapshot: InheritedPresentation };

/** A DataView's source as its fields read it - see `fieldSource`. */
export type FieldSource = { resource: string; detail: RelationDetail };

/**
 * `COLUMN` - a grid column over one of the source's columns; `WIDGET` - a
 * widget of the page (its record form, or a CUSTOM page), from the widget
 * catalog.
 */
/** COLUMN: a source column. RELATED: a column of the table a foreign key points at (`brand.country`). WIDGET: a page's widget. */
export type DataViewFieldKind = "COLUMN" | "RELATED" | "WIDGET";

export interface AdminDataViewField {
  id: string;
  kind: DataViewFieldKind;
  /** WIDGET fields only: the widget whose slot (`config.slot`) holds it - null on the canvas itself. */
  parent: string | null;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  label: string | null;
  icon: string | null;
  // kind = 'COLUMN' only
  columnAttnum: number | null;
  /** A COLUMN's column; a RELATED's dotted path (`brand.country`) - the Data API's field and row key. */
  columnName: string | null;
  /** kind = 'RELATED' only: the foreign key's column on the source, and the column on the table it points at - attnums, kept across renames. */
  relationAttnum: number | null;
  targetAttnum: number | null;
  widget: string | null;
  visible: boolean;
  config: Record<string, unknown>;
  /** WIDGET fields only: the DataView a widget shows (a Detail's) - a foreign key, see `widgetRelatedDataview`. */
  relatedDataview: string | null;
  /** WIDGET fields only: the Dashboard a widget shows (an embedded Dashboard's) - a foreign key, see `widgetRelatedDashboard`. */
  relatedDashboard: string | null;
  /**
   * COLUMN/RELATED, on a read: what it inherits from its resource's column
   * (Specification_DataViews.md §15) - live on a draft, the
   * version's copy on a published read. Its own `label`/`config` override it.
   */
  inherited?: ColumnPresentation;
  /** COLUMN/RELATED, on a read: its column's PostgreSQL type, as the table is now. */
  dataType?: string;
}

export interface DataViewFieldRow {
  id: string;
  kind: DataViewFieldKind;
  parent: string | null;
  grid_x: number;
  grid_y: number;
  grid_w: number;
  grid_h: number;
  label: string | null;
  icon: string | null;
  column_attnum: number | null;
  column_name: string | null;
  relation_attnum?: number | null;
  target_attnum?: number | null;
  widget: string | null;
  visible: boolean;
  config: Record<string, unknown>;
  related_dataview: string | null;
  related_dashboard?: string | null;
}

/** One field row as stored in a version's `fields_snapshot` - the base table's content columns (`FIELD_SNAPSHOT_COLUMNS`). */
export interface DataViewFieldSnapshotRow {
  id: string;
  dataview: string;
  kind: DataViewFieldKind;
  parent: string | null;
  grid_x: number;
  grid_y: number;
  grid_w: number;
  grid_h: number;
  label: string | null;
  icon: string | null;
  column_attnum: number | null;
  column_name: string | null;
  relation_attnum?: number | null;
  target_attnum?: number | null;
  widget: string | null;
  visible: boolean;
  config: Record<string, unknown>;
  related_dataview: string | null;
  related_dashboard?: string | null;
}

/**
 * Field rows in display order: position, then - for grid columns, which
 * all sit at 0,0 - the table's own column order, related columns after
 * their source's, so a column with no stored place lands in a stable spot.
 */
export const FIELDS_ORDER = `f.grid_y, f.grid_x, f.column_attnum NULLS LAST, f.relation_attnum NULLS LAST, f.target_attnum NULLS LAST, f.id`;

/** Every read of a DataView's field rows. */
export const DATAVIEW_FIELDS_SELECT = `SELECT f.* FROM totalbase.dataviews_fields f`;

/** A field row as snapshotted into a version - the base table's content columns, no timestamps (so a Restore's re-insert doesn't read as a change). */
export const FIELD_SNAPSHOT_COLUMNS = `id, dataview, kind, parent, grid_x, grid_y, grid_w, grid_h, label, icon,
  column_attnum, column_name, relation_attnum, target_attnum, widget, visible, config, related_dataview, related_dashboard`;

export interface AdminDataViewPublish {
  id: string;
  dataview: string;
  version: number;
  restoredFromVersion: number | null;
  user: string | null;
  publishedAt: Date;
  /** The publisher's note (Specification.md §13.3). */
  note: string | null;
}

export interface DataViewPublishRow {
  id: string;
  dataview: string;
  version: number;
  restored_from_version: number | null;
  user: string | null;
  published_at: Date;
  note: string | null;
}

export function toAdminDataViewPublish(row: DataViewPublishRow): AdminDataViewPublish {
  return {
    id: row.id,
    dataview: row.dataview,
    version: row.version,
    restoredFromVersion: row.restored_from_version,
    user: row.user,
    publishedAt: row.published_at,
    note: row.note,
  };
}

/** `DataViewsAdminService.syncFields()`'s own return shape - see its doc comment for what each of the three lists means. */
export interface SyncFieldsResult {
  added: AdminDataViewField[];
  renamed: { fieldId: string; from: string; to: string }[];
  orphaned: AdminDataViewField[];
}

export function toAdminDataViewField(row: DataViewFieldRow | DataViewFieldSnapshotRow): AdminDataViewField {
  return {
    id: row.id,
    kind: row.kind,
    parent: row.parent ?? null,
    gridX: row.grid_x,
    gridY: row.grid_y,
    gridW: row.grid_w,
    gridH: row.grid_h,
    label: row.label,
    icon: row.icon,
    columnAttnum: row.column_attnum,
    columnName: row.column_name,
    relationAttnum: row.relation_attnum ?? null,
    targetAttnum: row.target_attnum ?? null,
    widget: row.widget,
    visible: row.visible,
    config: row.config,
    relatedDataview: row.related_dataview,
    relatedDashboard: row.related_dashboard ?? null,
  };
}

export interface CreateDataViewInput {
  name: string;
  /** Auto-proposed from `name` (slugify) when omitted, same convention as roles/templates. */
  slug?: string | undefined;
  description?: string | null | undefined;
  icon?: string | null | undefined;
  color?: string | null | undefined;
  /** Required for every layout except EXTERNALFRAME, which has no source (and ignores it). */
  sourceResourceId?: string | undefined;
  viewType: DataViewType;
  /** Wizard step 4 - column names to mark visible; omitted means every current column (the pre-wizard behavior). */
  selectedColumns?: string[] | undefined;
  /** The DataView's `view_config` - each key checked against its shape (view-config.ts, Specification_DataViews.md §2.7). */
  viewConfig?: Record<string, unknown> | undefined;
  /**
   * Wizard step 4's per-column overrides, keyed by column name - its
   * input and its form help; never a title: a column's is its table's
   * (Specification_DataViews.md §15). `help` lands in the field's own `config`
   * (the generic per-field jsonb slot an FK's `display_field` will also
   * use later), rendered as the Edit form widget's `help` text.
   */
  fieldOverrides?: Record<string, { widget?: string; help?: string }> | undefined;
  /** MASTER_DETAIL only - the detail table and its FK column pointing at the master (one of `listDetailCandidates`). */
  detail?:
    | {
        resourceId: string;
        fkColumn: string;
        /** The detail rows' columns - its grid and each row's form; every column when omitted. */
        selectedColumns?: string[] | undefined;
        fieldOverrides?: CreateDataViewInput["fieldOverrides"];
      }
    | undefined;
}

/** A table whose FK points at a master table - a MASTER_DETAIL DataView's possible detail. */
export interface DetailCandidate {
  resourceId: string;
  schema: string;
  table: string;
  /** The detail table's column that references the master. */
  fkColumn: string;
}

/**
 * The Design form's per-field edits (Specification_DataViews.md §12) - position/size on the
 * grid, visibility, label, widget, and the widget's own `config`
 * (an FK's `display_field`, a plain field's `help`), and for a `WIDGET`
 * row its parent.
 */
export interface UpdateFieldInput {
  label?: string | null | undefined;
  widget?: string | undefined;
  visible?: boolean | undefined;
  config?: Record<string, unknown> | undefined;
  gridX?: number | undefined;
  gridY?: number | undefined;
  gridW?: number | undefined;
  gridH?: number | undefined;
  /** `WIDGET` rows only: the parent widget (null for the canvas) - `config.slot` names its slot. */
  parent?: string | null | undefined;
}

/** One widget of the widget catalog to place (`addWidget`): on the canvas, or in `parent`'s slot (`config.slot`). */
export interface AddWidgetInput {
  widget: string;
  config?: WidgetFieldConfig | undefined;
  parent?: string | null | undefined;
  label?: string | null | undefined;
  /** Its width in columns of 12 (default 12) and height in rows (default 1) - the Design form's size handles. */
  gridW?: number | undefined;
  gridH?: number | undefined;
}

/** A widget with what it holds (`addWidgets`): each child's `config.slot` names the slot of the widget it goes in. */
export interface AddWidgetTreeInput extends AddWidgetInput {
  children?: AddWidgetTreeInput[] | undefined;
}

export interface UpdateDataViewInput {
  name?: string | undefined;
  slug?: string | undefined;
  description?: string | null | undefined;
  /** The App menu's label - empty or null: its name. */
  menuLabel?: string | null | undefined;
  icon?: string | null | undefined;
  color?: string | null | undefined;
  /**
   * Shallow-merged into the existing `view_config` (top-level keys only -
   * `{ edit_presentation: 'MODAL' }` overwrites just that key, leaving
   * `features` and anything else already stored untouched). The Design
   * form's "View settings" section and the wizard's step 5 both write
   * here - a full replace would risk one clobbering what the other set.
   * Each key is checked against its shape (view-config.ts) first.
   */
  viewConfig?: Record<string, unknown> | undefined;
  /** LISTED shows in the App's menu and list; EMBEDDED_ONLY is only mounted inside another form (the "Show in the App menu" switch). */
  scope?: DataViewScope | undefined;
  /**
   * A CUSTOM page's record table, named after it was created - only while it
   * has none: once its widgets are bound to the columns, another table would
   * leave them pointing nowhere. Every other type's source is set on create.
   */
  sourceResourceId?: string | undefined;
  /**
   * A list DataView's main view (Specification_DataViews.md §5.13) - another list type it offers (`layouts`), the one it
   * opens with. Never a change of kind: a list stays a list.
   */
  viewType?: DataViewType | undefined;
}
