import type { RelationDetail } from "@totalbase/pg-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { FIELD_SNAPSHOT_COLUMNS, FIELDS_ORDER, type AffectedDataView, type DataViewsContext, type InheritedPresentation } from "./dataviews-types.js";

/**
 * The column a foreign key shows when neither its DataView column nor its
 * table says (DataViews.md §4.4): one called
 * name/label/title/display_name, else the first text column, else the key.
 */
export function defaultDisplayColumn(detail: RelationDetail, targetColumn: string): string {
  const named = detail.columns.find((c) => ["name", "label", "title", "display_name"].includes(c.name.toLowerCase()));
  const text = detail.columns.find((c) => c.name !== targetColumn && /^(text|character varying|character|citext)/.test(c.dataType));
  return (named ?? text)?.name ?? targetColumn;
}

/** What the draft inherits, read live - see `AdminDataView.columnPresentation` and `InheritedPresentation`. */
export async function livePresentation(ctx: DataViewsContext, dataviewId: string): Promise<InheritedPresentation> {
  const { rows } = await ctx.database.query<{ presentation: InheritedPresentation }>(
    `SELECT totalbase.dataview_presentation($1) AS presentation`,
    [dataviewId],
  );
  return rows[0]?.presentation ?? { columns: {}, rows: {} };
}

/**
 * The DataViews that show one column of a resource (DataViews.md §15) - what a change to its
 * presentation reaches: a grid column or a form field on it, a related column pointing at it, or either over a
 * view's column that is it (`view_column_origins`). Drafts too: each shows it once published.
 */
export async function dataviewsShowingColumn(ctx: DataViewsContext, resourceId: string, column: string): Promise<{ id: string; name: string }[]> {
  const { rows: exists } = await ctx.database.query(
    `SELECT 1 FROM totalbase.resources r
     JOIN pg_catalog.pg_attribute a ON a.attrelid = r.postgres_oid AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped
     WHERE r.id = $1`,
    [resourceId, column],
  );
  if (exists.length === 0) throw new TotalBaseError("UNDEFINED_COLUMN", `Column not found: ${column}`);
  const { rows } = await ctx.database.query<{ id: string; name: string }>(
    `WITH target AS (
       SELECT r.id, r.postgres_oid, a.attnum
       FROM totalbase.resources r
       JOIN pg_catalog.pg_attribute a ON a.attrelid = r.postgres_oid AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       WHERE r.id = $1
     ),
     -- The column itself, and every view column that is it.
     shown AS (
       SELECT target.id AS resource, target.postgres_oid AS oid, target.attnum, $2::text AS name FROM target
       UNION
       SELECT v.id, v.postgres_oid, o.attnum, va.attname::text
       FROM target
       JOIN totalbase.resources v ON v.type = 'VIEW' AND v.status = 'ACTIVE'
       CROSS JOIN LATERAL totalbase.view_column_origins(v.postgres_oid) o
       JOIN pg_catalog.pg_attribute va ON va.attrelid = v.postgres_oid AND va.attnum = o.attnum
       WHERE o.origin_relid = target.postgres_oid AND o.origin_attnum = target.attnum
     )
     SELECT DISTINCT d.id, d.name
     FROM totalbase.dataviews d
     JOIN totalbase.dataviews_fields f ON f.dataview = d.id
     LEFT JOIN totalbase.resources source ON source.id = d.source_resource
     JOIN shown ON
       (d.source_resource = shown.resource AND f.kind = 'COLUMN' AND f.column_attnum = shown.attnum)
       OR (d.source_resource = shown.resource AND f.kind = 'WIDGET' AND f.config -> 'props' ->> 'column' = shown.name)
       OR (f.kind = 'RELATED' AND f.target_attnum = shown.attnum AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_constraint c
         WHERE c.conrelid = source.postgres_oid AND c.contype = 'f' AND c.conkey = ARRAY[f.relation_attnum]::int2[] AND c.confrelid = shown.oid
       ))
     ORDER BY d.name`,
    [resourceId, column],
  );
  return rows;
}

/**
 * The published DataViews a change to `resourceId`'s columns' presentation
 * reaches (DataViews.md §15): those whose
 * draft now inherits differently from that resource than their live
 * version froze. `otherChanges` - their draft differs in something else
 * too, so publishing them now would publish that as well. Never-published
 * ones aren't listed: no viewer sees them yet.
 */
export async function affectedByColumnPresentation(ctx: DataViewsContext, resourceId: string): Promise<AffectedDataView[]> {
  const { rows } = await ctx.database.query<{ id: string; name: string; slug: string; version: number; other_changes: boolean }>(
    `SELECT d.id, d.name, d.slug, v.version,
            NOT (v.view_config_snapshot = d.view_config AND v.code_snapshot = d.code AND v.fields_snapshot = (
              SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY ${FIELDS_ORDER}), '[]'::jsonb)
              FROM (SELECT ${FIELD_SNAPSHOT_COLUMNS} FROM totalbase.dataviews_fields WHERE dataview = d.id) f
            )) AS other_changes
     FROM totalbase.dataviews d
     JOIN LATERAL (
       SELECT * FROM totalbase.dataviews_versions WHERE dataview = d.id ORDER BY version DESC LIMIT 1
     ) v ON true
     CROSS JOIN LATERAL (SELECT totalbase.dataview_presentation(d.id) AS live) p
     WHERE (p.live -> 'columns' -> $1::text) IS DISTINCT FROM (v.presentation_snapshot -> 'columns' -> $1::text)
        OR (p.live -> 'rows' -> $1::text) IS DISTINCT FROM (v.presentation_snapshot -> 'rows' -> $1::text)
     ORDER BY d.name`,
    [resourceId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, liveVersion: r.version, otherChanges: r.other_changes }));
}
