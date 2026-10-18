import { randomUUID } from "node:crypto";
import { remapUniqueViolation, TotalBaseError } from "@totalbase/errors";
import { getRelationDetail } from "@totalbase/pg-catalog";
import { validateRoleColor } from "@totalbase/permissions";
import { slugify, validateDescription, validateMenuLabel, validateName, validateSlug } from "@totalbase/shared";
import { isColumnWidgetName, LIST_VIEW_TYPES } from "@totalbase/tb-catalog";
import { parseFilter } from "@totalbase/query-engine";
import { getColumnInputs } from "@totalbase/resources";
import { generateRecordPage } from "./record-page.js";
import { assertRecordConfigValid, assertVariablesValid } from "./widget-fields.js";
import { validateFrameUrl } from "./frame-url.js";
import { assertViewConfigShape } from "./view-config.js";
import { isPageViewType, type AdminDataView, type CreateDataViewInput, type DataViewFieldSnapshotRow, type DataViewsContext, type DataViewType, type UpdateDataViewInput } from "./dataviews-types.js";
import { assertExists, getDataView } from "./dataviews-read.js";
import { assertVariablesInDatabase, VARIABLE_FILTER_LIMITS } from "./dataviews-widgets.js";
import { createMasterDetail } from "./dataviews-master-detail.js";
import { fillLaneColumns, fillTreeLayout, insertColumnFields, insertGeneratedPage, recordPageColumns } from "./dataviews-generated-page.js";
import { insertSnapshotFields, versionSnapshot } from "./dataviews-versions.js";

/** The types whose main view is a grid of rows (table, cards, board, calendar, map, timeline) - each opens a record form. */
export const GRID_VIEW_TYPES: readonly DataViewType[] = ["TABLE", "CARDS", "KANBAN", "CALENDAR", "MAP", "GANTT", "TREE"];

/** Every layout (Specification_DataViews.md §1.3) - an unknown `viewType` is a 422, not a CHECK violation from the row insert. */
export const DATAVIEW_TYPES: readonly DataViewType[] = ["TABLE", "FORM", "CARDS", "MAP", "KANBAN", "CALENDAR", "GANTT", "TREE", "EXTERNALFRAME", "MASTER_DETAIL", "CUSTOM", "SETTINGS"];

/** Source types a DataView may be built on (Specification_DataViews.md §1.2) - a FUNCTION is never a source. */
export const ALLOWED_SOURCE_TYPES = ["TABLE", "VIEW"] as const;

/** `view_config`'s keys and shapes (view-config.ts), plus `base_where` parsed by the Data API's own filter grammar. */
export function assertViewConfigValid(viewType: DataViewType, viewConfig: Record<string, unknown>): void {
  assertViewConfigShape(viewType, viewConfig);
  if (viewConfig.base_where !== undefined) {
    try {
      parseFilter(viewConfig.base_where, VARIABLE_FILTER_LIMITS, 0);
    } catch (error) {
      throw new TotalBaseError("DATAVIEW_VIEW_CONFIG_INVALID", `base_where: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * A SETTINGS DataView's columns (Specification_DataViews.md §5.12): key, value, title and description
 * required, group and order optional - each a column of its source.
 */
export function assertSettingsLayout(viewConfig: Record<string, unknown>, columns: string[]): void {
  const layout = (viewConfig["settings_layout"] ?? {}) as Record<string, unknown>;
  for (const key of ["keyColumn", "valueColumn", "titleColumn", "descriptionColumn", "groupColumn", "orderColumn"]) {
    const column = layout[key];
    const required = key !== "groupColumn" && key !== "orderColumn";
    if (column === undefined || column === null || column === "") {
      if (required) throw new TotalBaseError("DATAVIEW_VIEW_CONFIG_INVALID", `settings_layout.${key} is required: the column that holds each setting's ${key.replace("Column", "")}.`);
      continue;
    }
    if (typeof column !== "string" || !columns.includes(column)) throw new TotalBaseError("DATAVIEW_VIEW_CONFIG_INVALID", `settings_layout.${key}: no column "${String(column)}" in the source.`);
  }
}

export async function createDataView(ctx: DataViewsContext, input: CreateDataViewInput): Promise<AdminDataView> {
  const name = validateName(input.name);
  const slug = validateSlug(input.slug?.trim() ? input.slug : slugify(name));
  const description = validateDescription(input.description);
  const color = validateRoleColor(input.color, "INVALID_DATAVIEW_COLOR");

  if (!DATAVIEW_TYPES.includes(input.viewType)) {
    throw new TotalBaseError("DATAVIEW_VIEW_TYPE_NOT_SUPPORTED", `Unknown layout "${input.viewType}" - one of ${DATAVIEW_TYPES.join(", ")}.`);
  }

  assertViewConfigValid(input.viewType, input.viewConfig ?? {});

  if (input.viewType === "EXTERNALFRAME") return createExternalFrame(ctx, input, { name, slug, description, color });
  if (input.viewType === "CUSTOM") return createCustom(ctx, input, { name, slug, description, color });
  if (!input.sourceResourceId) {
    throw new TotalBaseError("DATAVIEW_SOURCE_TYPE_INVALID", "A DataView needs a source table or view.");
  }
  const source = await getSourceForCreate(ctx, input.sourceResourceId);
  if (input.viewType === "MASTER_DETAIL") return createMasterDetail(ctx, input, source, { name, slug, description, color });

  // getRelationDetail needs a plain Database (pool), not a
  // transaction-scoped client - read the source's current columns
  // before opening the transaction that persists the new DataView.
  const detail = await getRelationDetail(ctx.database, source.postgresOid);
  if (input.viewType === "SETTINGS") assertSettingsLayout(input.viewConfig ?? {}, detail.columns.map((c) => c.name));
  const inputs = await getColumnInputs(ctx.database, source.id);

  // Wizard step 4 - `undefined` (never opened the step, or an older
  // caller) keeps every column visible, same as before that step
  // existed. An explicit empty array is honored as "hide everything"
  // rather than silently falling back to "all".
  const selectedColumns = input.selectedColumns ? new Set(input.selectedColumns) : undefined;
  const viewConfig = input.viewConfig ?? {};
  seedDefaultSort(viewConfig, source.defaultSort);
  await fillLaneColumns(ctx, viewConfig, detail);
  const offersTree = input.viewType === "TREE" || (Array.isArray(viewConfig.layouts) && viewConfig.layouts.includes("TREE"));
  if (offersTree || (viewConfig.tree_layout !== undefined && viewConfig.tree_layout !== null)) await fillTreeLayout(ctx, viewConfig, detail, source.id, offersTree);
  const fieldOverrides = input.fieldOverrides ?? {};
  for (const override of Object.values(fieldOverrides)) {
    if (override.widget !== undefined && !isColumnWidgetName(override.widget)) {
      throw new TotalBaseError("DATAVIEW_FIELD_WIDGET_INVALID", `Unknown widget: ${override.widget}`);
    }
  }

  // Over a table, its record form is a generated page (Specification_DataViews.md §6.1):
  // a FORM's is the page itself; a grid type's opens from its grid.
  const recordPage = source.type === "TABLE" && (input.viewType === "FORM" || GRID_VIEW_TYPES.includes(input.viewType))
    ? generateRecordPage({
        type: input.viewType === "FORM" ? "FORM" : "GRID",
        columns: await recordPageColumns(ctx, detail, inputs, {
          include: (column) => (selectedColumns ? selectedColumns.has(column) : true),
          widget: (column) => fieldOverrides[column]?.widget,
    help: (column) => fieldOverrides[column]?.help,
        }),
      })
    : null;

  const createdId = await ctx.database.transaction(async (client) => {
    let dataviewId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO totalbase.dataviews (name, slug, description, icon, color, source_resource, view_type, view_config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [name, slug, description, input.icon ?? null, color, source.id, input.viewType, JSON.stringify(viewConfig)],
      );
      dataviewId = rows[0]!.id;
    } catch (error) {
      remapDataViewUniqueViolation(error);
    }

    // A grid's record form in a Sidebar or a Modal (the default, Specification_DataViews.md §6.3) is narrow: its
    // fields in one column, however many. A Drawer, a Page or a FORM's own page lay out by field count.
    const presentation = viewConfig.edit_presentation ?? "SIDEBAR";
    const narrowOverlay = GRID_VIEW_TYPES.includes(input.viewType) && (presentation === "SIDEBAR" || presentation === "MODAL");
    await insertColumnFields(ctx, client, dataviewId, detail, inputs, {
      presence: (column) => (!selectedColumns || selectedColumns.has(column.name) ? "shown" : detail.primaryKey.includes(column.name) ? "hidden" : null),
      fieldOverrides,
      ...(narrowOverlay && { columnsPerRow: 1 }),
    });
    if (recordPage) await insertGeneratedPage(ctx, client, dataviewId, recordPage);
    return dataviewId;
  });
  // Nothing is published implicitly (Specification.md §13.1):
  // the new DataView is a draft until its first explicit Publish. Returned as a read returns it.
  return getDataView(ctx, createdId);
}

export async function createExternalFrame(
  ctx: DataViewsContext,
  input: CreateDataViewInput,
  identity: { name: string; slug: string; description: string | null; color: string | null },
): Promise<AdminDataView> {
  const viewConfig = { ...(input.viewConfig ?? {}), frame_url: validateFrameUrl(input.viewConfig?.frame_url, await ctx.ownOrigin()) };
  let dataviewId: string;
  try {
    const { rows } = await ctx.database.query<{ id: string }>(
      `INSERT INTO totalbase.dataviews (name, slug, description, icon, color, source_resource, view_type, view_config)
       VALUES ($1, $2, $3, $4, $5, NULL, 'EXTERNALFRAME', $6)
       RETURNING id`,
      [identity.name, identity.slug, identity.description, input.icon ?? null, identity.color, JSON.stringify(viewConfig)],
    );
    dataviewId = rows[0]!.id;
  } catch (error) {
    remapDataViewUniqueViolation(error);
  }
  return getDataView(ctx, dataviewId);
}

/**
 * CUSTOM (Specification_DataViews.md): a blank canvas whose
 * widgets (`addWidget`) bind to the variables in `view_config.variables`.
 * Its source, when it names one, is its record's table (Specification_DataViews.md §8.5) - a
 * table, since a record is written; without one the page has no record.
 */
export async function createCustom(
  ctx: DataViewsContext,
  input: CreateDataViewInput,
  identity: { name: string; slug: string; description: string | null; color: string | null },
): Promise<AdminDataView> {
  const viewConfig = { ...(input.viewConfig ?? {}), variables: input.viewConfig?.variables ?? [] };
  assertVariablesValid(viewConfig.variables);
  assertRecordConfigValid(input.viewConfig?.record);
  await assertVariablesInDatabase(ctx, viewConfig.variables);
  const source = input.sourceResourceId ? await getSourceForCreate(ctx, input.sourceResourceId) : null;
  if (source && source.type !== "TABLE") {
    throw new TotalBaseError("DATAVIEW_SOURCE_TYPE_INVALID", "A page's record is written - its source must be a table.");
  }
  let dataviewId: string;
  try {
    const { rows } = await ctx.database.query<{ id: string }>(
      `INSERT INTO totalbase.dataviews (name, slug, description, icon, color, source_resource, view_type, view_config)
       VALUES ($1, $2, $3, $4, $5, $6, 'CUSTOM', $7)
       RETURNING id`,
      [identity.name, identity.slug, identity.description, input.icon ?? null, identity.color, source?.id ?? null, JSON.stringify(viewConfig)],
    );
    dataviewId = rows[0]!.id;
  } catch (error) {
    remapDataViewUniqueViolation(error);
  }
  return getDataView(ctx, dataviewId);
}

export async function updateDataView(ctx: DataViewsContext, id: string, patch: UpdateDataViewInput): Promise<AdminDataView> {
  const current = await getDataView(ctx, id); // 404s early if missing
  let viewConfigPatch = patch.viewConfig;
  if (viewConfigPatch) assertViewConfigValid(current.viewType, viewConfigPatch);
  if (current.viewType === "EXTERNALFRAME" && viewConfigPatch && "frame_url" in viewConfigPatch) {
    viewConfigPatch = { ...viewConfigPatch, frame_url: validateFrameUrl(viewConfigPatch.frame_url, await ctx.ownOrigin()) };
  }
  if (isPageViewType(current.viewType) && viewConfigPatch && "variables" in viewConfigPatch) {
    assertVariablesValid(viewConfigPatch.variables);
    await assertVariablesInDatabase(ctx, viewConfigPatch.variables);
  }
  if (isPageViewType(current.viewType) && viewConfigPatch && "record" in viewConfigPatch) assertRecordConfigValid(viewConfigPatch.record);
  if (viewConfigPatch && current.sourceResource && ("tree_layout" in viewConfigPatch || (Array.isArray(viewConfigPatch.layouts) && viewConfigPatch.layouts.includes("TREE")))) {
    const layouts = viewConfigPatch.layouts ?? current.viewConfig.layouts;
    const offersTree = current.viewType === "TREE" || (Array.isArray(layouts) && layouts.includes("TREE"));
    const treeConfig: Record<string, unknown> = { tree_layout: viewConfigPatch.tree_layout ?? current.viewConfig.tree_layout ?? {} };
    const source = await getSourceForCreate(ctx, current.sourceResource);
    await fillTreeLayout(ctx, treeConfig, await getRelationDetail(ctx.database, source.postgresOid), source.id, offersTree);
    viewConfigPatch = { ...viewConfigPatch, tree_layout: treeConfig.tree_layout };
  }
  let viewType: DataViewType | null = null;
  if (patch.viewType !== undefined && patch.viewType !== current.viewType) {
    const layouts = (viewConfigPatch?.layouts ?? current.viewConfig.layouts) as unknown;
    const isList = (type: string) => (LIST_VIEW_TYPES as readonly string[]).includes(type);
    if (!isList(current.viewType) || !isList(patch.viewType) || !Array.isArray(layouts) || !layouts.includes(patch.viewType)) {
      throw new TotalBaseError("DATAVIEW_VIEW_CONFIG_INVALID", "A list DataView's main view is one of the views it offers (layouts) - a DataView never changes kind.");
    }
    viewType = patch.viewType;
  }
  let sourceResource: string | null = null;
  if (patch.sourceResourceId !== undefined) {
    if (current.viewType !== "CUSTOM" || current.sourceResource !== null) {
      throw new TotalBaseError("DATAVIEW_SOURCE_TYPE_INVALID", "Only a page without a record table can be given one - a source is otherwise set when the DataView is created.");
    }
    const source = await getSourceForCreate(ctx, patch.sourceResourceId);
    if (source.type !== "TABLE") {
      throw new TotalBaseError("DATAVIEW_SOURCE_TYPE_INVALID", "A page's record is written - its source must be a table.");
    }
    sourceResource = source.id;
  }

  const name = patch.name !== undefined ? validateName(patch.name) : undefined;
  const slug = patch.slug !== undefined ? validateSlug(patch.slug) : undefined;
  const description = patch.description !== undefined ? validateDescription(patch.description) : undefined;
  const menuLabel = patch.menuLabel !== undefined ? validateMenuLabel(patch.menuLabel) : undefined;
  const color = patch.color !== undefined ? validateRoleColor(patch.color, "INVALID_DATAVIEW_COLOR") : undefined;

  try {
    await ctx.database.query(
      `UPDATE totalbase.dataviews
       SET name = coalesce($2, name),
           slug = coalesce($3, slug),
           description = CASE WHEN $4::boolean THEN $5 ELSE description END,
           icon = CASE WHEN $6::boolean THEN $7 ELSE icon END,
           color = CASE WHEN $8::boolean THEN $9 ELSE color END,
           view_config = CASE WHEN $10::boolean THEN coalesce(view_config, '{}'::jsonb) || $11::jsonb ELSE view_config END,
           scope = coalesce($12, scope),
           source_resource = coalesce($13, source_resource),
           menu_label = CASE WHEN $14::boolean THEN $15 ELSE menu_label END,
           view_type = coalesce($16, view_type),
           updated_at = now()
       WHERE id = $1`,
      [
        id,
        name ?? null,
        slug ?? null,
        patch.description !== undefined,
        description,
        patch.icon !== undefined,
        patch.icon ?? null,
        patch.color !== undefined,
        color ?? null,
        viewConfigPatch !== undefined,
        JSON.stringify(viewConfigPatch ?? {}),
        patch.scope ?? null,
        sourceResource,
        patch.menuLabel !== undefined,
        menuLabel ?? null,
        viewType,
      ],
    );
  } catch (error) {
    remapDataViewUniqueViolation(error);
  }

  return getDataView(ctx, id);
}

export async function deleteDataView(ctx: DataViewsContext, id: string): Promise<void> {
  await assertExists(ctx, id); // 404s early if missing
  // The DataViews it owns go with it - PostgreSQL's ON DELETE CASCADE on `owner`; one another page
  // still shows (related_dataview, ON DELETE RESTRICT) stops the delete instead.
  await ctx.database.query(`DELETE FROM totalbase.dataviews WHERE id = $1`, [id]);
}

/** Draft-only save of the DataView's client-side controller code - never visible to consumers (`getPublishedBySlug`) until `publish()` runs. */
export async function updateCode(ctx: DataViewsContext, dataviewId: string, code: string): Promise<void> {
  await assertExists(ctx, dataviewId); // 404s early if missing
  await ctx.database.query(`UPDATE totalbase.dataviews SET code = $2, updated_at = now() WHERE id = $1`, [dataviewId, code]);
}

/**
 * Save as (Specification.md §13.4): a NEW DataView (same source and layout; icon/color/
 * description and `owner` copied - a copy of a Detail's DataView belongs to the same
 * master) whose draft is version `version`'s content, with
 * no versions (unpublished). Field ids are regenerated, and every
 * reference to an old id inside the snapshot (a field's `parent`, ids kept
 * in `config`/`view_config`) is rewritten to the new one.
 */
export async function duplicateVersion(ctx: DataViewsContext, dataviewId: string, version: number, input: { name: string; slug?: string | undefined }): Promise<AdminDataView> {
  const source = await getDataView(ctx, dataviewId);
  const target = await versionSnapshot(ctx, dataviewId, version);
  const name = validateName(input.name);
  const slug = validateSlug(input.slug?.trim() ? input.slug : slugify(name));

  let viewConfigJson = JSON.stringify(target.view_config_snapshot);
  let fieldsJson = JSON.stringify(target.fields_snapshot);
  for (const field of target.fields_snapshot) {
    const newId = randomUUID();
    viewConfigJson = viewConfigJson.split(field.id).join(newId);
    fieldsJson = fieldsJson.split(field.id).join(newId);
  }

  const newId = await ctx.database.transaction(async (client) => {
    let id: string | undefined;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO totalbase.dataviews (name, slug, description, icon, color, source_resource, view_type, scope, view_config, code, owner)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, (SELECT owner FROM totalbase.dataviews WHERE id = $11))
         RETURNING id`,
        [name, slug, source.description, source.icon, source.color, source.sourceResource, source.viewType, source.scope, viewConfigJson, target.code_snapshot, dataviewId],
      );
      id = rows[0]!.id;
    } catch (error) {
      remapDataViewUniqueViolation(error);
    }
    await insertSnapshotFields(client, id!, JSON.parse(fieldsJson) as DataViewFieldSnapshotRow[]);
    return id!;
  });
  return getDataView(ctx, newId);
}

/** Resolves and validates a source resource for the TABLE/VIEW-only rule (Specification_DataViews.md §1.2), ACTIVE-only (a MISSING resource has no live columns to introspect). */
/**
 * A new DataView starts from its source's default order (Specification.md §11.7) when its `default_state` sets no
 * `sort` of its own - from then on the order is the DataView's, as the rest of its default state.
 */
function seedDefaultSort(viewConfig: Record<string, unknown>, defaultSort: readonly { column: string; direction: "asc" | "desc" }[]): void {
  if (!defaultSort.length) return;
  const state = (viewConfig.default_state && typeof viewConfig.default_state === "object" ? viewConfig.default_state : {}) as Record<string, unknown>;
  if (state.sort !== undefined) return;
  viewConfig.default_state = { ...state, sort: defaultSort.map((d) => (d.direction === "desc" ? `-${d.column}` : d.column)).join(",") };
}

export async function getSourceForCreate(
  ctx: DataViewsContext,
  resourceId: string,
): Promise<{ id: string; postgresOid: number; type: "TABLE" | "VIEW" | "FUNCTION"; status: "ACTIVE" | "MISSING"; defaultSort: { column: string; direction: "asc" | "desc" }[] }> {
  const { rows } = await ctx.database.query<{
    id: string;
    postgres_oid: number;
    type: "TABLE" | "VIEW" | "FUNCTION";
    status: "ACTIVE" | "MISSING";
    default_sort: { column: string; direction: "asc" | "desc" }[];
  }>(`SELECT id, postgres_oid, type, status, default_sort FROM totalbase.resources WHERE id = $1`, [resourceId]);
  const row = rows[0];
  if (!row) throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource not found: ${resourceId}`);
  if (!ALLOWED_SOURCE_TYPES.includes(row.type as (typeof ALLOWED_SOURCE_TYPES)[number])) {
    throw new TotalBaseError(
      "DATAVIEW_SOURCE_TYPE_INVALID",
      `A DataView's source must be a Table or a View, not ${row.type}.`,
    );
  }
  if (row.status !== "ACTIVE") {
    throw new TotalBaseError(
      "DATAVIEW_SOURCE_TYPE_INVALID",
      `Resource ${resourceId} is MISSING - it no longer exists in PostgreSQL.`,
    );
  }
  return { id: row.id, postgresOid: row.postgres_oid, type: row.type, status: row.status, defaultSort: row.default_sort ?? [] };
}

/**
 * A field's own title: what the author typed, unless it is the one it would
 * inherit anyway - the column's (`seed.config.label`), else its name
 * humanized. Null inherits (Specification_DataViews.md §15).
 */

export function remapDataViewUniqueViolation(error: unknown): never {
  return remapUniqueViolation(
    error,
    [{ constraint: "dataviews_slug_key", code: "DATAVIEW_SLUG_DUPLICATE", message: "A DataView with this slug already exists." }],
    { code: "DATAVIEW_NAME_DUPLICATE", message: "A DataView with this name already exists." },
  );
}
