import type { RelationDetail } from "./relation-detail.js";

/** How a junction table links a record's table to another (Administration.md §3.4, DataViews.md §8.5). */
export interface JunctionLink {
  /** The junction's single-column primary key - what a removed link is deleted by. */
  primaryKey: string;
  /** Its column pointing at the record's table. */
  column: string;
  /** Its column pointing at the other table - what a multi-select picks. */
  otherColumn: string;
  /** The other table and the column its foreign key targets. */
  target: { schema: string; table: string; column: string };
}

/**
 * `detail` as a junction between `record` and another table, or null:
 * a single-column primary key and exactly two more columns, each `NOT NULL`
 * with a single-column foreign key - one to `record`, one to a different
 * table -, and a UNIQUE over that pair (PostgreSQL keeps a link once).
 * Nothing else: a junction with columns of its own (a role, a quantity)
 * is edited as rows, and one whose both keys point at the same table
 * (`users_friends`) has no direction to pick.
 */
export function junctionLink(detail: RelationDetail, record: { schema: string; table: string }): JunctionLink | null {
  if (detail.primaryKey.length !== 1) return null;
  const primaryKey = detail.primaryKey[0]!;
  const keys = detail.columns.filter((column) => column.name !== primaryKey);
  if (keys.length !== 2 || detail.columns.length !== 3) return null;
  const relations = keys.map((column) => detail.relations.find((relation) => relation.sourceColumn === column.name));
  if (keys.some((column) => column.nullable) || relations.some((relation) => !relation)) return null;
  const pointsAtRecord = (relation: (typeof detail.relations)[number]) => relation.targetSchema === record.schema && relation.targetTable === record.table;
  const own = relations.filter((relation) => pointsAtRecord(relation!));
  if (own.length !== 1) return null;
  const other = relations.find((relation) => !pointsAtRecord(relation!))!;
  const pair = new Set(keys.map((column) => column.name));
  if (!detail.uniqueConstraints.some((set) => set.length === 2 && set.every((name) => pair.has(name)))) return null;
  return {
    primaryKey,
    column: own[0]!.sourceColumn,
    otherColumn: other.sourceColumn,
    target: { schema: other.targetSchema, table: other.targetTable, column: other.targetColumn },
  };
}
