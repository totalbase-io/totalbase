import type { Database } from "@totalbase/database";
import { getRelationDetail, type RelationDefinition } from "@totalbase/pg-catalog";
import { activeResourceByName } from "@totalbase/resources";

/** What a reference column points at and shows (DataViews.md §8.4): the target table and key, its display field or template. */
export interface ColumnReference {
  schema: string;
  table: string;
  column: string;
  displayField: string;
  displayTemplate?: string;
}

/**
 * The reference a DataView's column is: its foreign key among the source's `relations` - or, for a view's column,
 * the foreign key of the table column it is (`totalbase.view_column_origins`) - and what shows the target row: its
 * row presentation, else a name-like column, else its first text one, else the key. Null when it is none, or the
 * target is no active resource.
 */
export async function columnReference(
  database: Database,
  sourceOid: number | null,
  relations: RelationDefinition[],
  columnName: string,
): Promise<ColumnReference | null> {
  let relation = relations.find((r) => r.sourceColumn === columnName);
  if (!relation && sourceOid !== null) {
    const { rows } = await database.query<{ relid: number; attname: string }>(
      `SELECT o.origin_relid::int AS relid, a.attname
       FROM totalbase.view_column_origins($1) o
       JOIN pg_catalog.pg_attribute v ON v.attrelid = $1 AND v.attnum = o.attnum
       JOIN pg_catalog.pg_attribute a ON a.attrelid = o.origin_relid AND a.attnum = o.origin_attnum
       WHERE v.attname = $2`,
      [sourceOid, columnName],
    );
    const origin = rows[0];
    if (origin) {
      const table = await getRelationDetail(database, origin.relid).catch(() => null);
      relation = table?.relations.find((r) => r.sourceColumn === origin.attname);
    }
  }
  if (!relation) return null;
  const target = await activeResourceByName(database, relation.targetSchema, relation.targetTable);
  if (!target) return null;
  const detail = await getRelationDetail(database, target.postgresOid);
  const presentation = (target.rowPresentation ?? {}) as { displayField?: string; displayTemplate?: string };
  const named = detail.columns.find((c) => ["name", "label", "title", "display_name"].includes(c.name.toLowerCase()));
  const text = detail.columns.find((c) => c.name !== relation.targetColumn && /^(text|character varying|character|citext)/.test(c.dataType));
  return {
    schema: relation.targetSchema,
    table: relation.targetTable,
    column: relation.targetColumn,
    displayField: presentation.displayField ?? (named ?? text)?.name ?? relation.targetColumn,
    ...(presentation.displayTemplate ? { displayTemplate: presentation.displayTemplate } : {}),
  };
}
