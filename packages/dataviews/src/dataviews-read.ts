import { getRelationDetail } from "@totalbase/pg-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { templateColumns, type VariableDefinition } from "@totalbase/tb-catalog";
import { isPageViewType, toAdminDataView, type AdminDataView, type DataViewRow, type DataViewsContext, type ForeignKeyDisplay, type PublishedSnapshot, type RowPresentationMap, type VariableResource } from "./dataviews-types.js";
import { defaultDisplayColumn, livePresentation } from "./dataviews-presentation.js";
import { HAS_UNPUBLISHED_CHANGES_SQL, hasUnpublishedChanges } from "./dataviews-versions.js";

export const DATAVIEW_SELECT = `
  SELECT d.*, r."schema" AS source_resource_schema, r.name AS source_resource_name,
         r.type AS source_resource_type, r.postgres_oid AS source_resource_oid,
         (SELECT MAX(v.version) FROM totalbase.dataviews_versions v WHERE v.dataview = d.id) AS live_version
  FROM totalbase.dataviews d
  LEFT JOIN totalbase.resources r ON r.id = d.source_resource
`;

/** Every DataView, LISTED or EMBEDDED_ONLY, with its versioning status - the admin's DataViews list (the App's own list is `listPublished`). */
export async function listDataViews(ctx: DataViewsContext): Promise<(AdminDataView & { hasUnpublishedChanges: boolean })[]> {
  const { rows } = await ctx.database.query<DataViewRow & { has_unpublished_changes: boolean }>(
    `SELECT d.*, ${HAS_UNPUBLISHED_CHANGES_SQL} AS has_unpublished_changes
     FROM (${DATAVIEW_SELECT}) d
     ORDER BY d.name`,
  );
  return rows.map((row) => ({ ...toAdminDataView(row), hasUnpublishedChanges: row.has_unpublished_changes }));
}

/** Application-facing list: drafts have no route until first published. */
export async function listPublished(ctx: DataViewsContext): Promise<AdminDataView[]> {
  const { rows } = await ctx.database.query<DataViewRow>(
    `${DATAVIEW_SELECT}
     WHERE d.scope = 'LISTED'
       AND EXISTS (SELECT 1 FROM totalbase.dataviews_versions p WHERE p.dataview = d.id)
     ORDER BY d.name`,
  );
  return rows.map(toAdminDataView);
}

/**
 * Published DataViews kept out of the App menu (`EMBEDDED_ONLY`) that
 * could be shown in it - the App menu editor's Hidden section. A DataView
 * another one owns (a Detail's, `owner`) is never offered: it only exists
 * inside its owner.
 */
export async function listHiddenFromMenu(ctx: DataViewsContext): Promise<AdminDataView[]> {
  const { rows } = await ctx.database.query<DataViewRow>(
    `${DATAVIEW_SELECT}
     WHERE d.scope = 'EMBEDDED_ONLY' AND d.owner IS NULL
       AND EXISTS (SELECT 1 FROM totalbase.dataviews_versions p WHERE p.dataview = d.id)
     ORDER BY d.name`,
  );
  return rows.map(toAdminDataView);
}

export async function getDataView(ctx: DataViewsContext, id: string): Promise<AdminDataView> {
  return hydrate(ctx, await dataviewRow(ctx, "id", id));
}

/** Slug lookup for the admin SPA's own `/dataviews/:slug` route (not exposed by id there). */
export async function getDataViewBySlug(ctx: DataViewsContext, slug: string): Promise<AdminDataView> {
  return hydrate(ctx, await dataviewRow(ctx, "slug", slug));
}

/** The DataView's row, by id or slug - DATAVIEW_NOT_FOUND when there is none. */
export async function dataviewRow(ctx: DataViewsContext, by: "id" | "slug", value: string): Promise<DataViewRow> {
  const { rows } = await ctx.database.query<DataViewRow>(`${DATAVIEW_SELECT} WHERE d.${by} = $1`, [value]);
  const row = rows[0];
  if (!row) throw new TotalBaseError("DATAVIEW_NOT_FOUND", `DataView not found: ${value}`);
  return row;
}

/**
 * The 404 check alone, for a method that acts on the DataView without
 * reading it - `get()` would also compute what it inherits, its page's
 * variable resources and its source's key, all thrown away.
 */
export async function assertExists(ctx: DataViewsContext, id: string): Promise<void> {
  const { rows } = await ctx.database.query(`SELECT 1 FROM totalbase.dataviews WHERE id = $1`, [id]);
  if (rows.length === 0) throw new TotalBaseError("DATAVIEW_NOT_FOUND", `DataView not found: ${id}`);
}

/**
 * A row as the API returns it: with what it inherits (`columnPresentation` - read live for the draft, the version's
 * for a published read), its page's variable resources (named by schema and name, as the runtime addresses them)
 * and its source's key. `published` replaces the draft's `viewConfig`, `code` and presentation with a version's,
 * so none of the draft's is computed on the published path.
 */
export async function hydrate(ctx: DataViewsContext, row: DataViewRow, published?: PublishedSnapshot): Promise<AdminDataView> {
  const draft = toAdminDataView(row);
  const presentation = published ? published.presentation_snapshot : await livePresentation(ctx, row.id);
  const view = published
    ? { ...draft, viewConfig: published.view_config_snapshot, code: published.code_snapshot, columnPresentation: presentation.columns }
    : { ...draft, columnPresentation: presentation.columns };
  const withResources = isPageViewType(view.viewType) ? { ...view, variableResources: await variableResources(ctx, view.viewConfig, presentation.rows) } : view;
  if (row.source_resource_oid === null) return withResources;
  const detail = await getRelationDetail(ctx.database, row.source_resource_oid);
  return { ...withResources, sourceResourcePrimaryKey: detail.primaryKey };
}

/**
 * Same as `getBySlug`, but `viewConfig`/`code` come from the latest
 * `dataviews_publishes` row instead of the live draft - the read path
 * for actual consumers (`useDataViewBySlug.ts`'s view/new/edit-record
 * pages), never for the Studio Design screen, which keeps reading the
 * live draft via the untouched `getBySlug`/`listFields`. A DataView that
 * was never published has no consumer view: DATAVIEW_NOT_FOUND.
 */
export async function getPublishedBySlug(ctx: DataViewsContext, slug: string): Promise<AdminDataView> {
  const row = await dataviewRow(ctx, "slug", slug);
  return hydrate(ctx, row, await latestVersion(ctx, row.id, slug));
}

/** Published counterpart for embedded DataViews, whose config stores an id. */
export async function getPublished(ctx: DataViewsContext, id: string): Promise<AdminDataView> {
  const row = await dataviewRow(ctx, "id", id);
  return hydrate(ctx, row, await latestVersion(ctx, row.id, id));
}

/** The live (latest) version's content - DATAVIEW_NOT_FOUND, naming what the caller asked for, when never published. */
export async function latestVersion(ctx: DataViewsContext, dataviewId: string, identifier: string): Promise<PublishedSnapshot> {
  const { rows } = await ctx.database.query<PublishedSnapshot>(
    `SELECT view_config_snapshot, code_snapshot, presentation_snapshot FROM totalbase.dataviews_versions
     WHERE dataview = $1 ORDER BY version DESC LIMIT 1`,
    [dataviewId],
  );
  const published = rows[0];
  if (!published) throw new TotalBaseError("DATAVIEW_NOT_FOUND", `Published DataView not found: ${identifier}`);
  return published;
}

/** See `AdminDataView.variableResources`. */
export async function variableResources(ctx: DataViewsContext, viewConfig: Record<string, unknown>, rowPresentation: RowPresentationMap = {}): Promise<Record<string, VariableResource>> {
  const ids = new Set<string>();
  for (const variable of Array.isArray(viewConfig.variables) ? (viewConfig.variables as VariableDefinition[]) : []) {
    if (variable.kind === "RESOURCE" && typeof variable.resource === "string") ids.add(variable.resource);
    if (variable.kind === "CALL" && (variable.target?.type === "FUNCTION" || variable.target?.type === "TABLE") && typeof variable.target.resource === "string") {
      ids.add(variable.target.resource);
    }
  }
  if (ids.size === 0) return {};
  const { rows } = await ctx.database.query<{ id: string; schema: string; name: string; type: string; postgres_oid: number }>(
    `SELECT id, "schema", name, type, postgres_oid FROM totalbase.resources WHERE id = ANY($1::uuid[])`,
    [[...ids]],
  );
  const entries = await Promise.all(rows.map(async (r): Promise<[string, VariableResource]> => {
    const base = { schema: r.schema, name: r.name, type: r.type };
    if (r.type !== "TABLE" && r.type !== "VIEW") return [r.id, base];
    const detail = await getRelationDetail(ctx.database, r.postgres_oid);
    const targets = detail.relations.length === 0 ? [] : (await ctx.database.query<{ id: string; schema: string; name: string; postgres_oid: number }>(
      `SELECT id, "schema", name, postgres_oid FROM totalbase.resources WHERE status = 'ACTIVE' AND type IN ('TABLE', 'VIEW') AND ("schema", name) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [detail.relations.map((rel) => rel.targetSchema), detail.relations.map((rel) => rel.targetTable)],
    )).rows;
    const relations = Object.fromEntries(detail.relations.flatMap((rel) => {
      const target = targets.find((t) => t.schema === rel.targetSchema && t.name === rel.targetTable);
      return target ? [[rel.sourceColumn, target.id]] : [];
    }));
    // How each foreign key shows (§15.5): its table's row presentation, else the default column - none when that's the key itself.
    const displays: Record<string, ForeignKeyDisplay> = {};
    for (const rel of detail.relations) {
      const target = targets.find((t) => t.schema === rel.targetSchema && t.name === rel.targetTable);
      if (!target) continue;
      const presentation = rowPresentation[target.id] ?? {};
      const template = presentation.displayTemplate?.trim();
      const shown = template ? templateColumns(template)[0] : presentation.displayField ?? defaultDisplayColumn(await getRelationDetail(ctx.database, target.postgres_oid), rel.targetColumn);
      if (!shown || shown === rel.targetColumn) continue;
      displays[rel.sourceColumn] = { schema: rel.targetSchema, table: rel.targetTable, column: rel.targetColumn, displayField: shown, ...(template && { displayTemplate: template }) };
    }
    return [r.id, {
      ...base,
      columns: Object.fromEntries(detail.columns.map((c) => [c.name, c.dataType])),
      ...(Object.keys(relations).length > 0 && { relations }),
      ...(Object.keys(displays).length > 0 && { displays }),
    }];
  }));
  return Object.fromEntries(entries);
}

/** `get()` plus the versioning status the editor header shows. */
export async function getWithStatus(ctx: DataViewsContext, id: string): Promise<AdminDataView & { hasUnpublishedChanges: boolean }> {
  const view = await getDataView(ctx, id);
  return { ...view, hasUnpublishedChanges: await hasUnpublishedChanges(ctx, id) };
}
