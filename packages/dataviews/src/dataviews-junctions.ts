import { getChildForeignKeys, getRelationDetail, junctionLink } from "@totalbase/pg-catalog";
import type { DataViewsContext, JunctionCandidate } from "./dataviews-types.js";

interface TableResource {
  id: string;
  postgres_oid: number;
  schema: string;
  name: string;
}

async function activeTables(ctx: DataViewsContext, where: string, params: unknown[]): Promise<TableResource[]> {
  const { rows } = await ctx.database.query<TableResource>(
    `SELECT id, postgres_oid, "schema", name FROM totalbase.resources WHERE type = 'TABLE' AND status = 'ACTIVE' AND ${where}`,
    params,
  );
  return rows.map((row) => ({ ...row, postgres_oid: Number(row.postgres_oid) }));
}

/** `junction` as a junction of `record`, its other table's resource looked up - null when it isn't one. */
async function candidate(ctx: DataViewsContext, record: TableResource, junction: TableResource): Promise<JunctionCandidate | null> {
  const link = junctionLink(await getRelationDetail(ctx.database, junction.postgres_oid), { schema: record.schema, table: record.name });
  if (!link) return null;
  const [target] = await activeTables(ctx, `"schema" = $1 AND name = $2`, [link.target.schema, link.target.table]);
  return {
    resourceId: junction.id,
    schema: junction.schema,
    table: junction.name,
    primaryKey: link.primaryKey,
    column: link.column,
    otherColumn: link.otherColumn,
    target: { resourceId: target?.id ?? null, ...link.target },
  };
}

/**
 * The junction tables of `recordResourceId` (DataViews.md §8.5): TABLE
 * resources that link it to another table and hold nothing else
 * (`junctionLink`, @totalbase/pg-catalog) - what a form field's Junction
 * table offers. Read live from PostgreSQL's catalog, never stored.
 */
export async function listJunctions(ctx: DataViewsContext, recordResourceId: string): Promise<JunctionCandidate[]> {
  const [record] = await activeTables(ctx, `id = $1`, [recordResourceId]);
  if (!record) return [];
  const children = [...new Set((await getChildForeignKeys(ctx.database, record.postgres_oid)).map((c) => c.childOid))].filter((oid) => oid !== record.postgres_oid);
  if (children.length === 0) return [];
  const junctions = await activeTables(ctx, `postgres_oid = ANY($1)`, [children]);
  const found = await Promise.all(junctions.map((junction) => candidate(ctx, record, junction)));
  return found.filter((c): c is JunctionCandidate => c !== null).sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
}

/** One junction of `recordResourceId`, by its resource id - null when it isn't one (any more). */
export async function getJunction(ctx: DataViewsContext, recordResourceId: string, junctionResourceId: string): Promise<JunctionCandidate | null> {
  const [record] = await activeTables(ctx, `id = $1`, [recordResourceId]);
  const [junction] = await activeTables(ctx, `id = $1`, [junctionResourceId]);
  return record && junction ? candidate(ctx, record, junction) : null;
}
