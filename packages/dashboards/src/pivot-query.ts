import { quoteIdentifier } from "@totalbase/database";

/**
 * A PIVOT widget's aggregation (Specification_Dashboards.md §5.15, D17): its query returns the detail rows and
 * PostgreSQL aggregates them - the query wrapped once more, `GROUP BY GROUPING SETS`, every subtotal and total in
 * the same pass, `GROUPING()` marking which dimensions a row totals. The screen only places the cells; it adds
 * nothing up, so an average is the real one, never an average of averages.
 */

export type PivotAggregate = "sum" | "avg" | "min" | "max" | "count";

export interface PivotSpec {
  /** The Rows role's columns, outermost first. */
  rows: string[];
  /** The Columns role's columns - none: a single column of values. */
  columns: string[];
  values: { column: string; aggregate: PivotAggregate }[];
  /** A subtotal per level of the rows. */
  subtotals: boolean;
  /** A total column at the right (each row over every column). */
  rowTotals: boolean;
  /** A total row at the bottom (each column over every row). */
  columnTotals: boolean;
  /** Siblings ordered by a value's total (its row-total cell) - in the SQL, so a row cap keeps the right ones (DB36). */
  sortBy?: { value: string; direction: "ASC" | "DESC" } | null;
}

/** The grouping flag's column: `GROUPING(rows..., columns...)` - a bit per dimension, set where a row totals it. */
export const PIVOT_GROUPING_COLUMN = "__grouping";
/** At most this many distinct values across the Columns role (D17). */
export const PIVOT_MAX_COLUMNS = 60;

/** The grouping sets: each level of the rows (subtotals, the grand total) by each level of the columns. */
export function pivotGroupingSets(spec: PivotSpec): string[][] {
  const rowSets: string[][] = [spec.rows];
  if (spec.subtotals) for (let k = spec.rows.length - 1; k >= 1; k--) rowSets.push(spec.rows.slice(0, k));
  if (spec.columnTotals) rowSets.push([]);
  const columnSets: string[][] = [spec.columns];
  if (spec.columns.length > 0 && spec.rowTotals) columnSets.push([]);
  return rowSets.flatMap((rows) => columnSets.map((columns) => [...rows, ...columns]));
}

/**
 * The query wrapped as the pivot's aggregation, ordered so a row cap cuts the right rows (DB36):
 * - the totals and subtotals of the rows first (the bits of the Rows dimensions), never cut;
 * - then each group with its cells and its row total together, in the screen's order: with `sortBy`, each level's
 *   groups by their own total of that value - a group's key is its row-total cell (its prefix's grouping set with
 *   every Columns dimension totaled), read across the grouped rows with a window; a level without that set
 *   (subtotals off) falls back to its values, as the screen does.
 */
export function pivotSql(innerSql: string, spec: PivotSpec, limit: number): string {
  const names = [...spec.rows, ...spec.columns];
  const dimensions = names.map(quoteIdentifier);
  const aggregates = spec.values.map(({ column, aggregate }) => `${aggregate}(${quoteIdentifier(column)}) AS ${quoteIdentifier(column)}`);
  const sets = pivotGroupingSets(spec).map((set) => `(${set.map(quoteIdentifier).join(", ")})`);
  const grouping = dimensions.length ? `GROUPING(${dimensions.join(", ")})` : "0";
  const groupingColumn = quoteIdentifier(PIVOT_GROUPING_COLUMN);
  const grouped = [
    `SELECT ${[...dimensions, ...aggregates, `${grouping} AS ${groupingColumn}`].join(", ")}`,
    `FROM (\n${innerSql}\n) AS dashboard_widget_query`,
    `GROUP BY GROUPING SETS (${sets.join(", ")})`,
  ].join("\n");
  const sortBy = spec.sortBy && spec.values.some((v) => v.column === spec.sortBy!.value) ? spec.sortBy : null;
  // GROUPING()'s bit for dimension i: the leftmost the highest.
  const bit = (i: number) => 2 ** (names.length - 1 - i);
  const order = [`(${groupingColumn} >> ${spec.columns.length}) DESC`];
  spec.rows.forEach((_, k) => {
    if (sortBy) {
      let mask = 0;
      for (let i = k + 1; i < names.length; i++) mask += bit(i);
      const value = quoteIdentifier(sortBy.value);
      order.push(`max(CASE WHEN ${groupingColumn} = ${mask} THEN ${value} END) OVER (PARTITION BY ${dimensions.slice(0, k + 1).join(", ")}) ${sortBy.direction === "DESC" ? "DESC" : "ASC"} NULLS LAST`);
    }
    order.push(`${dimensions[k]} NULLS LAST`);
  });
  order.push(`${groupingColumn} DESC`, ...dimensions.slice(spec.rows.length).map((d) => `${d} NULLS LAST`));
  return [`SELECT * FROM (\n${grouped}\n) AS pivot`, `ORDER BY ${order.join(", ")}`, `LIMIT ${Math.max(1, Math.floor(limit))}`].join("\n");
}

/** How many distinct value combinations the Columns role has - the cap's check, before aggregating. */
export function pivotDistinctColumnsSql(innerSql: string, columns: string[]): string {
  return `SELECT count(*)::int AS n FROM (SELECT DISTINCT ${columns.map(quoteIdentifier).join(", ")} FROM (\n${innerSql}\n) AS dashboard_widget_query) AS distinct_columns`;
}
