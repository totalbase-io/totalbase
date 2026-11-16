import type { Queryable } from "@totalbase/database";

/** A widget row as a draft writes it - its id given, so a batch knows each new row's id without a RETURNING per row. */
export interface WidgetRow {
  id: string;
  type: string;
  label: string | null;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  query: string | null;
  config: unknown;
  tab: string | null;
}

const RECORD = "w(id uuid, type text, label text, grid_x integer, grid_y integer, grid_w integer, grid_h integer, query text, config jsonb, tab text)";

function payload(rows: WidgetRow[]): string {
  return JSON.stringify(rows.map((row) => ({
    id: row.id,
    type: row.type,
    label: row.label,
    grid_x: row.gridX,
    grid_y: row.gridY,
    grid_w: row.gridW,
    grid_h: row.gridH,
    query: row.query,
    config: row.config ?? {},
    tab: row.tab,
  })));
}

/** A dashboard's widgets written in one statement - a restore, a copy, a spec's new widgets. */
export async function insertWidgets(client: Queryable, dashboardId: string, rows: WidgetRow[]): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO totalbase.dashboards_widgets (id, dashboard, type, label, grid_x, grid_y, grid_w, grid_h, query, config, tab)
     SELECT w.id, $1, w.type, w.label, w.grid_x, w.grid_y, w.grid_w, w.grid_h, w.query, w.config, w.tab
     FROM jsonb_to_recordset($2::jsonb) AS ${RECORD}`,
    [dashboardId, payload(rows)],
  );
}

/** Existing widgets rewritten in one statement - only the ones that differ, so an unchanged one keeps its updated_at. */
export async function updateWidgets(client: Queryable, dashboardId: string, rows: WidgetRow[]): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `UPDATE totalbase.dashboards_widgets d
     SET type = w.type, label = w.label, grid_x = w.grid_x, grid_y = w.grid_y, grid_w = w.grid_w, grid_h = w.grid_h,
         query = w.query, config = w.config, tab = w.tab, updated_at = now()
     FROM jsonb_to_recordset($2::jsonb) AS ${RECORD}
     WHERE d.id = w.id AND d.dashboard = $1
       AND (d.type, d.label, d.grid_x, d.grid_y, d.grid_w, d.grid_h, d.query, d.config, d.tab)
           IS DISTINCT FROM (w.type, w.label, w.grid_x, w.grid_y, w.grid_w, w.grid_h, w.query, w.config, w.tab)`,
    [dashboardId, payload(rows)],
  );
}
