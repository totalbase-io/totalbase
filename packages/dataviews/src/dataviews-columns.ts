import { TotalBaseError } from "@totalbase/errors";
import { getRelationDetail, type RelationDetail } from "@totalbase/pg-catalog";
import { columnFormInput, COLUMN_PRESENTATION_KEYS, type WidgetName } from "@totalbase/tb-catalog";
import { getColumnInputs } from "@totalbase/resources";
import { resolveColumnSync } from "./column-sync.js";
import { toAdminDataViewField, type AdminDataViewField, type DataViewFieldRow, type DataViewsContext, type SyncFieldsResult } from "./dataviews-types.js";
import { getDataView } from "./dataviews-read.js";
import { livePresentation } from "./dataviews-presentation.js";
import { getField, withLiveColumnFacts } from "./dataviews-fields.js";

/**
 * Reconciles a DataView's own `COLUMN` rows against the source
 * resource's REAL, current columns - `dataviews_fields` is only ever
 * auto-populated ONCE, at `create()` time (Specification_DataViews.md §3.2); nothing else keeps it
 * in sync as the table changes afterward (the chat's own "schema
 * drift" bug report: add a column to the table after the DataView
 * exists, and it never shows up anywhere in the Design form - not the
 * canvas, not even the hidden-fields palette - because no row was
 * ever created for it).
 *
 * Matches by `attnum` - Postgres's own stable per-column identity,
 * unaffected by a rename and never reused after a real drop
 * (ColumnDefinition's own doc comment) - not by name, so all three
 * drift cases resolve correctly:
 *
 * 1. A brand new column (created after `view_config.last_attnum`) -
 *    inserted as Column set says: shown (`auto_show`), hidden
 *    (`auto_hide`) or not at all (`locked`). A column the author
 *    removed from the DataView is not new, and stays out.
 * 2. A renamed column (same attnum, stale `column_name`) - corrected
 *    in place. More than cosmetic: the Data API queries by name, so
 *    a stale `column_name` silently breaks that field's own read/
 *    write until this runs.
 * 3. A dropped column (attnum gone entirely) - NOT deleted
 *    automatically, unlike the other two cases - that would destroy
 *    any label/widget/config the builder already set up on it with
 *    no way back. Returned as `orphaned` so the caller decides, same
 *    "never destroy something silently" rule every other mutation
 *    here already follows.
 */
export async function syncFields(ctx: DataViewsContext, dataviewId: string): Promise<SyncFieldsResult> {
  const dataview = await getDataView(ctx, dataviewId); // 404s early if the DataView itself doesn't exist
  if (dataview.sourceResourceOid === null) return { added: [], renamed: [], orphaned: [] };
  const columnSync = resolveColumnSync(dataview.viewConfig);

  const detail = await getRelationDetail(ctx.database, dataview.sourceResourceOid);
  const fkColumns = new Map(detail.relations.map((r) => [r.sourceColumn, r]));
  const columnsByAttnum = new Map(detail.columns.map((c) => [c.attnum, c]));
  const inputs = dataview.sourceResource ? await getColumnInputs(ctx.database, dataview.sourceResource) : new Map<string, string>();

  const { rows: existingRows } = await ctx.database.query<{ id: string; column_attnum: number; column_name: string }>(
    `SELECT id, column_attnum, column_name FROM totalbase.dataviews_fields WHERE dataview = $1 AND kind = 'COLUMN'`,
    [dataviewId],
  );
  const existingAttnums = new Set(existingRows.map((r) => r.column_attnum));

  const renamed: SyncFieldsResult["renamed"] = [];
  const orphanedRows: typeof existingRows = [];
  for (const row of existingRows) {
    const column = columnsByAttnum.get(row.column_attnum);
    if (!column) {
      orphanedRows.push(row);
      continue;
    }
    if (column.name !== row.column_name) {
      await ctx.database.query(`UPDATE totalbase.dataviews_fields SET column_name = $1, updated_at = now() WHERE id = $2`, [
        column.name,
        row.id,
      ]);
      renamed.push({ fieldId: row.id, from: row.column_name, to: column.name });
    }
  }

  // A related column (RELATED) follows its foreign key and its target column by attnum: a rename of
  // either refreshes its path; a dropped one (or a key that no longer points there) orphans it.
  const { rows: relatedRows } = await ctx.database.query<{ id: string; relation_attnum: number; target_attnum: number; column_name: string }>(
    `SELECT id, relation_attnum, target_attnum, column_name FROM totalbase.dataviews_fields WHERE dataview = $1 AND kind = 'RELATED'`,
    [dataviewId],
  );
  const targets = new Map<string, RelationDetail | null>();
  for (const row of relatedRows) {
    const fk = columnsByAttnum.get(row.relation_attnum);
    const relation = fk ? fkColumns.get(fk.name) : undefined;
    if (!fk || !relation) {
      orphanedRows.push({ id: row.id, column_attnum: row.relation_attnum, column_name: row.column_name });
      continue;
    }
    const key = `${relation.targetSchema}.${relation.targetTable}`;
    if (!targets.has(key)) targets.set(key, await relationTarget(ctx, relation));
    const column = targets.get(key)?.columns.find((c) => c.attnum === row.target_attnum);
    if (!column) {
      orphanedRows.push({ id: row.id, column_attnum: row.relation_attnum, column_name: row.column_name });
      continue;
    }
    const path = `${fk.name}.${column.name}`;
    if (path !== row.column_name) {
      await ctx.database.query(`UPDATE totalbase.dataviews_fields SET column_name = $1, updated_at = now() WHERE id = $2`, [path, row.id]);
      renamed.push({ fieldId: row.id, from: row.column_name, to: path });
    }
  }

  const added: AdminDataViewField[] = [];
  // `locked` (column-sync.ts's own doc comment) - the DataView's
  // column set stays exactly what it already has; a genuinely new
  // real column is never given a field row at all here (not even
  // hidden), until the builder switches this setting off.
  //
  // New means created after the DataView last looked: past
  // `view_config.last_attnum` - PostgreSQL never reuses an attnum, so a
  // column the author removed from the DataView stays out.
  const seenThrough = typeof dataview.viewConfig.last_attnum === "number" ? dataview.viewConfig.last_attnum : 0;
  if (columnSync !== "locked") {
    for (const column of detail.columns) {
      if (column.attnum <= seenThrough || existingAttnums.has(column.attnum)) continue;
      const fk = fkColumns.get(column.name) ?? null;
      const seeded = columnWidget(column, fk, detail.checkConstraints, inputs);
      const widget = seeded.widget;
      const config = newColumnConfig(column, seeded.config);
      const { rows } = await ctx.database.query<DataViewFieldRow>(
        `INSERT INTO totalbase.dataviews_fields
           (dataview, kind, column_attnum, column_name, widget, visible, config, grid_x, grid_y, grid_w, grid_h)
         VALUES ($1, 'COLUMN', $2, $3, $4, $5, $6, 0, (SELECT coalesce(max(grid_y), -1) + 1 FROM totalbase.dataviews_fields WHERE dataview = $1 AND kind IN ('COLUMN', 'RELATED')), 12, 1)
         RETURNING *`,
        [dataviewId, column.attnum, column.name, widget, columnSync === "auto_show", JSON.stringify(config)],
      );
      added.push(toAdminDataViewField(rows[0]!));
    }
    await ctx.database.query(
      `UPDATE totalbase.dataviews SET view_config = coalesce(view_config, '{}'::jsonb) || jsonb_build_object('last_attnum', $2::int) WHERE id = $1`,
      [dataviewId, lastAttnum(detail)],
    );
  }

  const orphaned = await Promise.all(orphanedRows.map((r) => getField(ctx, dataviewId, r.id)));
  // Every field as a field read returns it.
  return { added: await withLiveColumnFacts(ctx, dataviewId, added, await livePresentation(ctx, dataviewId)), renamed, orphaned };
}

/**
 * "Add columns…": the source's columns not in the DataView yet, added
 * shown after the last one, configured as Sync columns configures a new one - and columns of
 * a table a foreign key points at, as `fk.column` (a RELATED field, read
 * only: `brand.country`). One hop: the foreign key must be the source's
 * own, and its table one the Data API exposes. A column already in it, or
 * not in the table, is refused.
 */
export async function addColumns(ctx: DataViewsContext, dataviewId: string, columnNames: string[]): Promise<AdminDataViewField[]> {
  const dataview = await getDataView(ctx, dataviewId);
  if (dataview.sourceResourceOid === null) throw new TotalBaseError("DATAVIEW_COLUMN_INVALID", "This DataView has no source table.");
  const detail = await getRelationDetail(ctx.database, dataview.sourceResourceOid);
  const fkColumns = new Map(detail.relations.map((r) => [r.sourceColumn, r]));
  const inputs = dataview.sourceResource ? await getColumnInputs(ctx.database, dataview.sourceResource) : new Map<string, string>();
  const { rows: existingRows } = await ctx.database.query<{ column_attnum: number | null; relation_attnum: number | null; target_attnum: number | null }>(
    `SELECT column_attnum, relation_attnum, target_attnum FROM totalbase.dataviews_fields WHERE dataview = $1 AND kind IN ('COLUMN', 'RELATED')`,
    [dataviewId],
  );
  const existing = new Set(existingRows.map((r) => (r.column_attnum !== null ? `${r.column_attnum}` : `${r.relation_attnum}.${r.target_attnum}`)));

  type Addition =
    | { kind: "COLUMN"; column: RelationDetail["columns"][number] }
    | { kind: "RELATED"; path: string; fk: RelationDetail["columns"][number]; column: RelationDetail["columns"][number]; targetChecks: RelationDetail["checkConstraints"] };
  const additions: Addition[] = [];
  for (const name of columnNames) {
    const dot = name.indexOf(".");
    if (dot === -1) {
      const column = detail.columns.find((c) => c.name === name);
      if (!column) throw new TotalBaseError("DATAVIEW_COLUMN_INVALID", `Not a column of the source table: ${name}`);
      if (existing.has(`${column.attnum}`)) throw new TotalBaseError("DATAVIEW_FIELD_DUPLICATE", `Already in the DataView: ${name}`);
      additions.push({ kind: "COLUMN", column });
      continue;
    }
    const fkName = name.slice(0, dot);
    const targetName = name.slice(dot + 1);
    const relation = fkColumns.get(fkName);
    const fk = detail.columns.find((c) => c.name === fkName);
    if (!relation || !fk) throw new TotalBaseError("DATAVIEW_COLUMN_INVALID", `Not a foreign key of the source table: ${fkName}`);
    const target = await relationTarget(ctx, relation);
    const column = target?.columns.find((c) => c.name === targetName);
    if (!column) throw new TotalBaseError("DATAVIEW_COLUMN_INVALID", `Not a column of ${relation.targetSchema}.${relation.targetTable} the Data API exposes: ${targetName}`);
    if (existing.has(`${fk.attnum}.${column.attnum}`)) throw new TotalBaseError("DATAVIEW_FIELD_DUPLICATE", `Already in the DataView: ${name}`);
    additions.push({ kind: "RELATED", path: `${fkName}.${targetName}`, fk, column, targetChecks: target!.checkConstraints });
  }

  const added = await ctx.database.transaction(async (client) => {
    const added: AdminDataViewField[] = [];
    for (const addition of additions) {
      if (addition.kind === "RELATED") {
        // Shown, never written: what makes it editable (required, disabled, a default) is the form's, not a related column's.
        const { required: _required, disabled: _disabled, dbDefault: _dbDefault, ...config } = newColumnConfig(addition.column);
        const { rows } = await client.query<DataViewFieldRow>(
          `INSERT INTO totalbase.dataviews_fields
             (dataview, kind, relation_attnum, target_attnum, column_name, widget, visible, config, grid_x, grid_y, grid_w, grid_h)
           VALUES ($1, 'RELATED', $2, $3, $4, $5, true, $6, 0, (SELECT coalesce(max(grid_y), -1) + 1 FROM totalbase.dataviews_fields WHERE dataview = $1 AND kind IN ('COLUMN', 'RELATED')), 12, 1)
           RETURNING *`,
          [
            dataviewId,
            addition.fk.attnum,
            addition.column.attnum,
            addition.path,
            // A related column shows as its own table's rule would edit it - its CHECKs count, never a foreign key (one hop).
            columnWidget(addition.column, null, addition.targetChecks, new Map()).widget,
            JSON.stringify(config),
          ],
        );
        added.push(toAdminDataViewField(rows[0]!));
        continue;
      }
      const { column } = addition;
      const fk = fkColumns.get(column.name) ?? null;
      const seeded = columnWidget(column, fk, detail.checkConstraints, inputs);
      const widget = seeded.widget;
      const config = newColumnConfig(column, seeded.config);
      const { rows } = await client.query<DataViewFieldRow>(
        `INSERT INTO totalbase.dataviews_fields
           (dataview, kind, column_attnum, column_name, widget, visible, config, grid_x, grid_y, grid_w, grid_h)
         VALUES ($1, 'COLUMN', $2, $3, $4, true, $5, 0, (SELECT coalesce(max(grid_y), -1) + 1 FROM totalbase.dataviews_fields WHERE dataview = $1 AND kind IN ('COLUMN', 'RELATED')), 12, 1)
         RETURNING *`,
        [dataviewId, column.attnum, column.name, widget, JSON.stringify(config)],
      );
      added.push(toAdminDataViewField(rows[0]!));
    }
    return added;
  });
  // As a field read returns them - with their column's type and what they inherit.
  return withLiveColumnFacts(ctx, dataviewId, added, await livePresentation(ctx, dataviewId));
}

/**
 * Each related column's (RELATED) PostgreSQL type, by path (`producto.codigo`
 * → `text`) - read off the table its foreign key points at, as it is now.
 * One the key or the column no longer reaches is left out.
 */
export async function relatedColumnTypes(ctx: DataViewsContext, fields: AdminDataViewField[], sourceOid: number): Promise<Record<string, string>> {
  const related = fields.filter((f) => f.kind === "RELATED" && f.columnName && f.relationAttnum !== null && f.targetAttnum !== null);
  if (related.length === 0) return {};
  const detail = await getRelationDetail(ctx.database, sourceOid);
  const types: Record<string, string> = {};
  for (const field of related) {
    const fk = detail.columns.find((c) => c.attnum === field.relationAttnum);
    const relation = fk ? detail.relations.find((r) => r.sourceColumn === fk.name) : undefined;
    const column = relation ? (await relationTarget(ctx, relation))?.columns.find((c) => c.attnum === field.targetAttnum) : undefined;
    if (column) types[field.columnName!] = column.dataType;
  }
  return types;
}

/**
 * The table a foreign key points at, as the Data API reaches it - an
 * ACTIVE resource it exposes for reading - with its columns; null when it
 * can't (a hidden table: `brand.name` would be refused as INVALID_RELATION).
 */
export async function relationTarget(ctx: DataViewsContext, relation: RelationDetail["relations"][number]): Promise<RelationDetail | null> {
  const { rows } = await ctx.database.query<{ postgres_oid: number }>(
    `SELECT postgres_oid FROM totalbase.resources
     WHERE "schema" = $1 AND name = $2 AND type IN ('TABLE', 'VIEW') AND status = 'ACTIVE' AND 'GET' = ANY(exposed_methods)`,
    [relation.targetSchema, relation.targetTable],
  );
  return rows[0] ? getRelationDetail(ctx.database, rows[0].postgres_oid) : null;
}

/** "created_at" -> "Created At" - mirrors the admin's humanizeColumnName (the wizard's default column titles). */
/** The highest attnum the table has now - what a DataView has seen through (`view_config.last_attnum`). */
export function lastAttnum(detail: RelationDetail): number {
  return detail.columns.reduce((max, column) => Math.max(max, column.attnum), 0);
}

/**
 * A column added to a DataView after its creation (Sync columns, Add
 * columns…): its stored widget's config, plus what the database says -
 * required (NOT NULL), written by PostgreSQL (identity/generated), how its
 * value displays, JSON, a DEFAULT.
 */
export function newColumnConfig(column: RelationDetail["columns"][number], seededConfig?: Record<string, unknown>): Record<string, unknown> {
  // Its presentation and what its type says are read live, never copied (Specification_DataViews.md §15).
  const config: Record<string, unknown> = seededConfig ? withoutPresentation(seededConfig) : {};
  if (!column.nullable) config.required = true;
  if (column.isIdentity || column.isGenerated) config.disabled = true;
  if (column.defaultExpression !== null) config.dbDefault = true;
  return config;
}

/**
 * A column's chosen control as a grid column's widget (a new DataView's fields): its catalog entry's widget, and the
 * config that makes it that control (an editor's content type) - none when the column has no choice, or one that no
 * longer edits it: its type's default then.
 */
/**
 * A new field's widget: the column input catalog's (Specification_DataViews.md §16.1) - the
 * column's chosen input when it still edits the column, else the rule's by its type,
 * foreign key and CHECKs. The one rule a form field follows too (`columnFormInput`).
 */
export function columnWidget(
  column: RelationDetail["columns"][number],
  fk: { targetSchema: string; targetTable: string } | null,
  checks: RelationDetail["checkConstraints"],
  inputs: Map<string, string>,
): { widget: WidgetName; config: Record<string, unknown> } {
  const resolved = columnFormInput({ name: column.name, dataType: column.dataType, foreignKey: fk, checks, input: inputs.get(column.name) });
  // A grid's editor reads its content type as `editorContentType` (FieldConfig), a form's UEditor as its prop.
  const contentType = resolved.props.contentType;
  return { widget: resolved.widget, config: typeof contentType === "string" ? { editorContentType: contentType } : {} };
}

/** A stored widget's config without the column's presentation - a field inherits that live. */
export function withoutPresentation(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !(COLUMN_PRESENTATION_KEYS as readonly string[]).includes(key)));
}
