import type { Queryable, ResultField } from "@totalbase/database";
import { resolveResultColumns } from "@totalbase/pg-catalog";
import type { ColumnPresentation } from "@totalbase/tb-catalog";

/** Where a result column comes from, when it is a table's (or a view's) column as is (Dashboards.md §2.3). */
export interface ResultColumnOrigin {
  schema: string;
  table: string;
  column: string;
  /** The TotalBase resource it is, when registered and active - its presentation's owner. */
  resourceId: string | null;
}

/**
 * A widget's result column, typed (Dashboards.md §2.3): its name and PostgreSQL type; its origin when
 * PostgreSQL reports one (a column referenced as is, even aliased - never an expression); that column's presentation
 * (its label, format, a CHECK list's values); and `lossy` when a `numeric`/`bigint` value didn't fit a number exactly
 * and stays the exact decimal text.
 */
export interface TypedResultColumn {
  name: string;
  dataType: string;
  origin?: ResultColumnOrigin;
  presentation?: ColumnPresentation;
  /** Its origin is a foreign key to files, or that table's id - a file's id (a Table shows its thumbnail). */
  fileReference?: true;
  lossy?: true;
}

const INT8_OID = 20;
const NUMERIC_OID = 1700;
/** A double holds any decimal of up to 15 significant digits exactly. */
const EXACT_DIGITS = 15;

/**
 * A `numeric`/`bigint` value's decimal text as a number, when the number is exactly it - else null, and it stays text
 * (NaN, ±Infinity, more than 15 significant digits).
 */
export function exactNumber(text: string): number | null {
  const match = /^-?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) return null;
  const digits = `${match[1] ?? ""}${match[2] ?? ""}`.replace(/^0+/, "").replace(/0+$/, "");
  if (digits.length > EXACT_DIGITS) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Types a widget's result (Dashboards.md §2.3): columns with their type, origin and presentation, and
 * `numeric`/`bigint` values as numbers wherever that is exact - so a query needs no `::float`. Never fails a query
 * that already ran: an origin or presentation it can't read is left out.
 */
export async function typeResult(
  database: Queryable,
  fields: ResultField[],
  rows: Record<string, unknown>[],
): Promise<{ columns: TypedResultColumn[]; rows: Record<string, unknown>[] }> {
  const columns: TypedResultColumn[] = await resolveResultColumns(database, fields);

  // numeric / bigint: a number where exact, the decimal text otherwise (the column marked lossy).
  const numberColumns = fields.flatMap((f, i) => (f.dataTypeId === INT8_OID || f.dataTypeId === NUMERIC_OID ? [i] : []));
  if (numberColumns.length > 0) {
    for (const row of rows) {
      for (const i of numberColumns) {
        const name = fields[i]!.name;
        const raw = row[name];
        if (typeof raw !== "string") continue;
        const value = exactNumber(raw);
        if (value === null) columns[i]!.lossy = true;
        else row[name] = value;
      }
    }
  }

  const sourced = fields.flatMap((f, i) => (f.tableId > 0 && f.columnId > 0 ? [{ i, table: f.tableId, column: f.columnId }] : []));
  if (sourced.length === 0) return { columns, rows };
  try {
    const { rows: origins } = await database.query<{ table_oid: number; attnum: number; schema: string; relname: string; attname: string; resource: string | null; file: boolean }>(
      `SELECT c.oid::int AS table_oid, a.attnum::int AS attnum, n.nspname AS schema, c.relname, a.attname, r.id AS resource,
              -- A file: a foreign key to files, or that table's own id (D14).
              (c.oid = to_regclass('totalbase.files') AND a.attname = 'id') OR EXISTS (
                SELECT 1 FROM pg_catalog.pg_constraint fk
                WHERE fk.conrelid = c.oid AND fk.contype = 'f' AND fk.conkey = ARRAY[a.attnum]
                  AND fk.confrelid = to_regclass('totalbase.files')
              ) AS file
       FROM unnest($1::oid[], $2::int2[]) AS x(table_oid, attnum)
       JOIN pg_catalog.pg_class c ON c.oid = x.table_oid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.attnum AND NOT a.attisdropped
       LEFT JOIN totalbase.resources r ON r.postgres_oid = c.oid AND r.status = 'ACTIVE'`,
      [sourced.map((s) => s.table), sourced.map((s) => s.column)],
    );
    const byKey = new Map(origins.map((o) => [`${o.table_oid}.${o.attnum}`, o]));
    const resources = [...new Set(origins.flatMap((o) => (o.resource ? [o.resource] : [])))];
    const presentations = new Map<string, Record<string, ColumnPresentation>>();
    for (const resource of resources) {
      const { rows: found } = await database.query<{ presentation: Record<string, ColumnPresentation> }>(
        `SELECT totalbase.resource_column_presentation($1) AS presentation`,
        [resource],
      );
      presentations.set(resource, found[0]?.presentation ?? {});
    }
    for (const { i, table, column } of sourced) {
      const origin = byKey.get(`${table}.${column}`);
      if (!origin) continue;
      columns[i]!.origin = { schema: origin.schema, table: origin.relname, column: origin.attname, resourceId: origin.resource };
      if (origin.file) columns[i]!.fileReference = true;
      const presentation = origin.resource ? presentations.get(origin.resource)?.[origin.attname] : undefined;
      if (presentation && Object.keys(presentation).length > 0) columns[i]!.presentation = presentation;
    }
  } catch {
    // Best-effort: the result stands without its origins.
  }
  return { columns, rows };
}
