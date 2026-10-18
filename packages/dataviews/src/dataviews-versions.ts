import { deleteVersionsBefore, publishVersion, quoteIdentifier, type Queryable, type VersionsTable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { assertVariablesValid, assertWidgetConfigValid, assertWidgetName, variableRefs, type WidgetFieldConfig } from "./widget-fields.js";
import { isPageViewType, toAdminDataViewPublish, type AdminDataView, type AdminDataViewField, type AdminDataViewPublish, type DataViewFieldSnapshotRow, type DataViewPublishRow, type DataViewsContext, type InheritedPresentation, FIELD_SNAPSHOT_COLUMNS, FIELDS_ORDER } from "./dataviews-types.js";
import { assertExists, dataviewRow, getDataView, hydrate } from "./dataviews-read.js";
import { hydrateFieldSnapshotRows } from "./dataviews-fields.js";
import { assertVariablesInDatabase } from "./dataviews-widgets.js";

export const VERSION_COLUMNS = `id, dataview, version, restored_from_version, "user", published_at, note`;
/** The versions table as `@totalbase/database`'s shared versioning helpers see it. */
export const DATAVIEW_VERSIONS: VersionsTable = { table: "totalbase.dataviews_versions", owner: "dataview", ownerTable: "totalbase.dataviews", columns: VERSION_COLUMNS };

/**
 * Specification.md §13.5 as one SQL expression over a
 * `dataviews` row aliased `d`: the draft differs from the latest
 * version, or there is none. The draft's field rows are aggregated in the
 * same order and columns `draftSnapshot()` stores, and compared with jsonb's
 * structural `=` (key order never matters) - so the list (every row at
 * once, no query per DataView) and the editor header can't disagree.
 */
/** Whether the DataView aliased `alias` differs from its latest published version (true when it was never published) - its inherited column presentation included. */
export function ownUnpublishedChangesSql(alias: string): string {
  return `
  COALESCE((
    SELECT v.view_config_snapshot = ${alias}.view_config
       AND v.code_snapshot = ${alias}.code
       AND v.presentation_snapshot = totalbase.dataview_presentation(${alias}.id)
       AND v.fields_snapshot = (
         SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY ${FIELDS_ORDER}), '[]'::jsonb)
         FROM (SELECT ${FIELD_SNAPSHOT_COLUMNS} FROM totalbase.dataviews_fields WHERE dataview = ${alias}.id) f
       )
    FROM totalbase.dataviews_versions v
    WHERE v.dataview = ${alias}.id
    ORDER BY v.version DESC
    LIMIT 1
  ), false) = false`;
}

/**
 * The DataViews a DataView owns (`owner`): the detail
 * DataView its Master-detail wizard created for its Detail - published with
 * it, deleted with it (ON DELETE CASCADE). Never read off the scope: a
 * DataView hidden from the App menu is still its author's own.
 */
export function ownedDetailSql(owner: string): string {
  return `SELECT id FROM totalbase.dataviews WHERE owner = ${owner}`;
}

/** A DataView has unpublished changes when it, or a detail DataView it owns (Detail), differs from its published version. */
export const HAS_UNPUBLISHED_CHANGES_SQL = `(${ownUnpublishedChangesSql("d")}
  OR EXISTS (SELECT 1 FROM totalbase.dataviews c WHERE c.id IN (${ownedDetailSql("d.id")}) AND ${ownUnpublishedChangesSql("c")}))`;

/** Inserts a snapshot's field rows into `dataviewId` - `parent` in a second pass, since it references another row of the same batch. */
export async function insertSnapshotFields(client: Queryable, dataviewId: string, fields: DataViewFieldSnapshotRow[]): Promise<void> {
  for (const f of fields) {
    await client.query(
      `INSERT INTO totalbase.dataviews_fields
         (id, dataview, kind, grid_x, grid_y, grid_w, grid_h, label, icon, column_attnum, column_name, relation_attnum, target_attnum, widget, visible, config, related_dataview, related_dashboard)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [f.id, dataviewId, f.kind, f.grid_x, f.grid_y, f.grid_w, f.grid_h, f.label, f.icon, f.column_attnum, f.column_name, f.relation_attnum ?? null, f.target_attnum ?? null, f.widget, f.visible, JSON.stringify(f.config), f.related_dataview, f.related_dashboard ?? null],
    );
  }
  for (const f of fields) {
    if (f.parent) await client.query(`UPDATE totalbase.dataviews_fields SET parent = $2 WHERE id = $1`, [f.id, f.parent]);
  }
}

/** The draft as it would be snapshotted - `view_config`, raw field rows (fixed order), `code`. */
export async function draftSnapshot(ctx: DataViewsContext, dataviewId: string, on: Queryable = ctx.database): Promise<{ viewConfigJson: string; fieldsJson: string; code: string }> {
  const { rows } = await on.query<{ view_config: Record<string, unknown>; code: string }>(
    `SELECT view_config, code FROM totalbase.dataviews WHERE id = $1`,
    [dataviewId],
  );
  const row = rows[0];
  if (!row) throw new TotalBaseError("DATAVIEW_NOT_FOUND", `DataView not found: ${dataviewId}`);
  const { rows: fieldRows } = await on.query<DataViewFieldSnapshotRow>(
    `SELECT ${FIELD_SNAPSHOT_COLUMNS} FROM totalbase.dataviews_fields f WHERE dataview = $1 ORDER BY ${FIELDS_ORDER}`,
    [dataviewId],
  );
  return { viewConfigJson: JSON.stringify(row.view_config), fieldsJson: JSON.stringify(fieldRows), code: row.code };
}

/** Specification.md §13.5 - see `HAS_UNPUBLISHED_CHANGES_SQL`. */
export async function hasUnpublishedChanges(ctx: DataViewsContext, dataviewId: string): Promise<boolean> {
  const { rows } = await ctx.database.query<{ changed: boolean }>(
    `SELECT ${HAS_UNPUBLISHED_CHANGES_SQL} AS changed FROM totalbase.dataviews d WHERE d.id = $1`,
    [dataviewId],
  );
  if (!rows[0]) throw new TotalBaseError("DATAVIEW_NOT_FOUND", `DataView not found: ${dataviewId}`);
  return rows[0].changed;
}

/**
 * What publishing should warn about, never refuse (Specification_DataViews.md §6.5): a FORM in SINGLE mode over
 * a table with more than one row opens only the first by key.
 */
export async function publishWarnings(ctx: DataViewsContext, dataviewId: string): Promise<string[]> {
  const view = await getDataView(ctx, dataviewId);
  if (view.viewType !== "FORM" || view.viewConfig["form_view_mode"] !== "SINGLE" || !view.sourceResourceSchema || !view.sourceResourceName) return [];
  const { rows } = await ctx.database.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM (SELECT 1 FROM ${quoteIdentifier(view.sourceResourceSchema)}.${quoteIdentifier(view.sourceResourceName)} LIMIT 2) s`,
  );
  return (rows[0]?.count ?? 0) > 1
    ? [`${view.sourceResourceSchema}.${view.sourceResourceName} has more than one row: a single-record form opens the first by key. A unique index on a constant (CREATE UNIQUE INDEX ... ON ((true))) keeps it to one.`]
    : [];
}

/**
 * Snapshots the draft (`view_config`, `dataviews_fields`, `code`) as the
 * next version - a no-op (returns the latest version) when the draft
 * equals it. A draft equal to an OLDER version (Restore, Specification.md §13.4) records it
 * as `restored_from_version` - the newest such version.
 */
export async function publish(ctx: DataViewsContext, dataviewId: string, userId: string | null, note: string | null = null): Promise<AdminDataViewPublish> {
  // Validated first - a master that can't go out takes none of its details with it - then one transaction:
  // the DataView's row locked (two publishes at once queue up, the second finds the first's version and
  // returns it), its details published inside it, so either everything is out or nothing is.
  await assertCustomPublishable(ctx, dataviewId);
  return ctx.database.transaction((client) => publishOn(ctx, client, dataviewId, userId, note));
}

export async function publishOn(ctx: DataViewsContext, client: Queryable, dataviewId: string, userId: string | null, note: string | null = null): Promise<AdminDataViewPublish> {
  // The shared helper locks the DataView's row, then takes the snapshot under that lock (`@totalbase/database`'s
  // `publishVersion`: the no-op on an unchanged draft, MAX + 1, `restored_from_version`).
  const row = await publishVersion<DataViewPublishRow>(client, DATAVIEW_VERSIONS, dataviewId, userId, async () => {
    // Its detail DataViews go out with it - the App's Detail control opens their published version.
    const { rows: owned } = await client.query<{ id: string }>(ownedDetailSql("$1"), [dataviewId]);
    for (const detail of owned) await publishOn(ctx, client, detail.id, userId);
    const { viewConfigJson, fieldsJson, code } = await draftSnapshot(ctx, dataviewId, client);
    return [
      { column: "view_config_snapshot", value: viewConfigJson, cast: "jsonb" },
      { column: "fields_snapshot", value: fieldsJson, cast: "jsonb" },
      { column: "code_snapshot", value: code },
      // What it inherits is frozen with it - computed by PostgreSQL in the same statement it's compared or stored in.
      { column: "presentation_snapshot", expression: "totalbase.dataview_presentation($1)" },
    ];
  }, note);
  return toAdminDataViewPublish(row);
}

/**
 * A CUSTOM DataView publishes only whole: its variables valid, and every
 * widget's config still fitting them - deleting or renaming a variable
 * after binding it is caught here, not by the viewer.
 */
export async function assertCustomPublishable(ctx: DataViewsContext, dataviewId: string): Promise<void> {
  const dataview = await getDataView(ctx, dataviewId);
  if (!isPageViewType(dataview.viewType)) return;
  assertVariablesValid(dataview.viewConfig?.variables ?? []);
  await assertVariablesInDatabase(ctx, dataview.viewConfig?.variables ?? []);
  const variables = variableRefs(dataview.viewConfig);
  const { rows } = await ctx.database.query<{ widget: string; config: WidgetFieldConfig; label: string | null }>(
    `SELECT widget, config, label FROM totalbase.dataviews_fields WHERE dataview = $1 AND kind = 'WIDGET' ORDER BY grid_y, grid_x`,
    [dataviewId],
  );
  for (const row of rows) {
    assertWidgetName(row.widget);
    assertWidgetConfigValid(row.widget, row.config, variables, await ctx.ownOrigin());
  }
}

/** Newest first, summary only (no snapshot payloads, which can be large). */
export async function listVersions(ctx: DataViewsContext, dataviewId: string): Promise<AdminDataViewPublish[]> {
  await assertExists(ctx, dataviewId);
  const { rows } = await ctx.database.query<DataViewPublishRow>(
    `SELECT ${VERSION_COLUMNS} FROM totalbase.dataviews_versions WHERE dataview = $1 ORDER BY version DESC`,
    [dataviewId],
  );
  return rows.map(toAdminDataViewPublish);
}

/**
 * Deletes every version before `before` (Specification.md §13.4) - never the live (latest) one, so the next Publish stays latest + 1
 * and a number is never reused. A version deleted can't be restored.
 */
export async function deleteDataViewVersionsBefore(ctx: DataViewsContext, dataviewId: string, before: number): Promise<{ deleted: number[] }> {
  await assertExists(ctx, dataviewId);
  return { deleted: await deleteVersionsBefore(ctx.database, DATAVIEW_VERSIONS, dataviewId, before) };
}

export async function versionSnapshot(ctx: DataViewsContext, dataviewId: string, version: number) {
  const { rows } = await ctx.database.query<
    DataViewPublishRow & {
      view_config_snapshot: Record<string, unknown>;
      fields_snapshot: DataViewFieldSnapshotRow[];
      code_snapshot: string;
      presentation_snapshot: InheritedPresentation;
    }
  >(
    `SELECT ${VERSION_COLUMNS}, view_config_snapshot, fields_snapshot, code_snapshot, presentation_snapshot
     FROM totalbase.dataviews_versions WHERE dataview = $1 AND version = $2`,
    [dataviewId, version],
  );
  const row = rows[0];
  if (!row) throw new TotalBaseError("DATAVIEW_VERSION_NOT_FOUND", `Version ${version} not found for DataView ${dataviewId}.`);
  return row;
}

/**
 * One version's full content, shaped exactly like the published read
 * path (`getPublished` + `listPublishedFields`) so the admin can render
 * the DataView as users saw it at that version - the read-only preview.
 */
export async function getVersion(
  ctx: DataViewsContext,
  dataviewId: string,
  version: number,
): Promise<Omit<AdminDataViewPublish, "dataview"> & { dataview: AdminDataView; fields: AdminDataViewField[] }> {
  const view = await dataviewRow(ctx, "id", dataviewId);
  const row = await versionSnapshot(ctx, dataviewId, version);
  return {
    ...toAdminDataViewPublish(row),
    // That version's content in place of the draft's - its page's variable resources are that version's too.
    dataview: await hydrate(ctx, view, row),
    fields: await hydrateFieldSnapshotRows(ctx, dataviewId, row.fields_snapshot, row.presentation_snapshot),
  };
}

/**
 * Restore (Specification.md §13.4): version `version`'s
 * content replaces the draft (`view_config`, `code`, and the field rows
 * wholesale). Publishes nothing - the next `publish()` does, recording
 * `restored_from_version` if the draft is still that version's content.
 * Field rows keep their original ids (they were just deleted from this
 * same DataView, so no collision) with `parent` patched in a second pass,
 * since a row can reference another row of the same snapshot.
 */
export async function restore(ctx: DataViewsContext, dataviewId: string, version: number): Promise<AdminDataView> {
  await assertExists(ctx, dataviewId);
  const target = await versionSnapshot(ctx, dataviewId, version);
  await ctx.database.transaction(async (client) => {
    await client.query(`UPDATE totalbase.dataviews SET view_config = $2::jsonb, code = $3, updated_at = now() WHERE id = $1`, [
      dataviewId,
      JSON.stringify(target.view_config_snapshot),
      target.code_snapshot,
    ]);
    await client.query(`DELETE FROM totalbase.dataviews_fields WHERE dataview = $1`, [dataviewId]);
    await insertSnapshotFields(client, dataviewId, target.fields_snapshot);
  });
  return getDataView(ctx, dataviewId);
}
