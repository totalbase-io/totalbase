import type { Queryable } from "@totalbase/database";
import { VIEW_LAYOUTS } from "./view-layouts.js";

/**
 * A DataView that names a column its source no longer has (DataViews.md §4.8): a view's
 * layout (a formula's `{{column}}`, a picked column) or its Filter (`base_where`) - or its source itself
 * gone. Read against PostgreSQL's catalog (pg_attribute), the draft's `view_config` and the live
 * version's. `version`: null for the draft, else the live version.
 */
export interface BrokenDataViewReference {
  dataview: { id: string; name: string; slug: string };
  /** The resource it reads - what Database › Columns lists it under. */
  resource: string | null;
  version: number | null;
  /** Where: `card_layout.titleFormula`, `base_where`, `source`. */
  part: string;
  /** The column it names, null when the source itself is gone. */
  column: string | null;
}

/** The columns a formula names - `{{name}}`, a related one's first step (`{{brand.name}}` is `brand`); never `{{vars.*}}`. */
export function formulaColumns(formula: string): string[] {
  const names: string[] = [];
  for (const match of formula.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const path = match[1]!;
    if (/^(vars|controls|slot)\./.test(path)) continue;
    names.push(path.split(".")[0]!);
  }
  return names;
}

/** The fields a filter object names - every key but its operators and `_and` / `_or` / `_not`, a related one's first step. */
export function filterColumns(where: unknown): string[] {
  if (!where || typeof where !== "object") return [];
  if (Array.isArray(where)) return where.flatMap(filterColumns);
  const names: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === "_and" || key === "_or" || key === "_not") names.push(...filterColumns(value));
    else if (!key.startsWith("_")) names.push(key.split(".")[0]!);
  }
  return names;
}

/** What a `view_config` names, part by part - only the views it shows (`view_type` and its `layouts`). */
function namedColumns(viewType: string, viewConfig: Record<string, unknown>): { part: string; column: string }[] {
  const shown = new Set([viewType, ...(Array.isArray(viewConfig.layouts) ? (viewConfig.layouts as string[]) : [])]);
  const named: { part: string; column: string }[] = [];
  for (const layout of VIEW_LAYOUTS) {
    const config = viewConfig[layout.key];
    if (!shown.has(layout.view) || !config || typeof config !== "object") continue;
    const values = config as Record<string, unknown>;
    for (const key of layout.columns) {
      if (typeof values[key] === "string" && values[key]) named.push({ part: `${layout.key}.${key}`, column: values[key] as string });
    }
    for (const key of layout.formulas) {
      if (typeof values[key] === "string") for (const column of formulaColumns(values[key] as string)) named.push({ part: `${layout.key}.${key}`, column });
    }
  }
  for (const column of filterColumns(viewConfig.base_where)) named.push({ part: "base_where", column });
  return named;
}

/** `dataviewId`: only that DataView's. */
export async function brokenDataViewReferences(database: Queryable, dataviewId?: string): Promise<BrokenDataViewReference[]> {
  const { rows } = await database.query<{
    id: string; name: string; slug: string; view_type: string; view_config: Record<string, unknown>;
    resource: string | null; oid: number | null; status: string | null; source: string | null;
    live_version: number | null; live_config: Record<string, unknown> | null;
  }>(
    `SELECT d.id, d.name, d.slug, d.view_type, d.view_config, d.source_resource AS resource,
            r.postgres_oid AS oid, r.status, r."schema" || '.' || r.name AS source,
            v.version AS live_version, v.view_config_snapshot AS live_config
     FROM totalbase.dataviews d
     JOIN totalbase.resources r ON r.id = d.source_resource
     LEFT JOIN LATERAL (
       SELECT version, view_config_snapshot FROM totalbase.dataviews_versions
       WHERE dataview = d.id ORDER BY version DESC LIMIT 1
     ) v ON true
     WHERE $1::uuid IS NULL OR d.id = $1
     ORDER BY d.name`,
    [dataviewId ?? null],
  );
  const oids = [...new Set(rows.flatMap((row) => (row.status === "ACTIVE" && row.oid !== null ? [row.oid] : [])))];
  const { rows: attributes } = await database.query<{ oid: number; columns: string[] }>(
    `SELECT attrelid::oid::int AS oid, array_agg(attname::text) AS columns
     FROM pg_attribute WHERE attrelid = ANY($1::oid[]) AND attnum > 0 AND NOT attisdropped
     GROUP BY attrelid`,
    [oids],
  );
  const columnsOf = new Map(attributes.map((a) => [a.oid, new Set(a.columns)]));

  const broken: BrokenDataViewReference[] = [];
  for (const row of rows) {
    const dataview = { id: row.id, name: row.name, slug: row.slug };
    const columns = row.oid !== null ? columnsOf.get(row.oid) : undefined;
    if (row.status !== "ACTIVE" || !columns) {
      broken.push({ dataview, resource: row.resource, version: null, part: "source", column: null });
      continue;
    }
    const seen = new Set<string>();
    const versions: [number | null, Record<string, unknown> | null][] = [[null, row.view_config], [row.live_version, row.live_config]];
    for (const [version, config] of versions) {
      if (!config) continue;
      for (const { part, column } of namedColumns(row.view_type, config)) {
        // The same name in the draft and the live version is one problem, reported once (the draft's).
        if (columns.has(column) || seen.has(`${part}\n${column}`)) continue;
        seen.add(`${part}\n${column}`);
        broken.push({ dataview, resource: row.resource, version, part, column });
      }
    }
  }
  return broken;
}
