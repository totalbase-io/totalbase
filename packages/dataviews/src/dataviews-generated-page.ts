import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { getRelationDetail, type RelationDetail } from "@totalbase/pg-catalog";
import { checkConstraintValues, columnFormInput, isNumericDataType, isWidgetName, templateColumns, type RowPresentation, type VariableDefinition, type WidgetName } from "@totalbase/tb-catalog";
import { generateRecordPage, takesOptions, variableNameFor, type GeneratedPage, type GeneratedWidget, type RecordPageColumn } from "./record-page.js";
import { assertVariablesValid, assertWidgetConfigValid, widgetRelatedDashboard, widgetRelatedDataview, type WidgetFieldConfig } from "./widget-fields.js";
import type { CreateDataViewInput, DataViewsContext } from "./dataviews-types.js";
import { defaultDisplayColumn } from "./dataviews-presentation.js";
import { columnWidget, lastAttnum, withoutPresentation } from "./dataviews-columns.js";

/** A current instant - what PostgreSQL stamps a row with (`now()`, `CURRENT_TIMESTAMP`...). */
export const CURRENT_INSTANT_DEFAULT = /^\s*(now\(\)|current_timestamp|localtimestamp|clock_timestamp\(\)|statement_timestamp\(\)|transaction_timestamp\(\))/i;

/**
 * A column PostgreSQL fills on its own, which a generated record form hides on a new record (DataViews.md §6.2):
 * an identity or generated column, a primary key with a DEFAULT (`gen_random_uuid()`, a sequence), an instant
 * defaulting to the current one (a creation stamp). By its type and its DEFAULT, never by its name.
 */
export function writtenByPostgres(column: RelationDetail["columns"][number], primaryKey: readonly string[]): boolean {
  if (column.isIdentity || column.isGenerated) return true;
  if (!column.defaultExpression) return false;
  if (primaryKey.includes(column.name)) return true;
  return /^timestamp/.test(column.dataType) && CURRENT_INSTANT_DEFAULT.test(column.defaultExpression);
}

/**
 * One COLUMN field per column in the DataView, in catalog order
 * (DataViews.md §3.2) - `presence` decides which columns are in it, shown or
 * hidden; one left out gets no row.
 * Visible fields are laid out one per row (12-column grid).
 * Returns how many grid rows the visible fields took.
 */
export async function insertColumnFields(
  ctx: DataViewsContext,
  client: Queryable,
  dataviewId: string,
  detail: RelationDetail,
  inputs: Map<string, string>,
  options: {
    /**
     * Whether a column is in the DataView, shown or hidden - one left
     * out gets no field at all (DataViews.md §4.1:
     * a column not in the DataView is never read).
     */
    presence: (column: RelationDetail["columns"][number]) => "shown" | "hidden" | null;
    fieldOverrides?: CreateDataViewInput["fieldOverrides"];
  },
): Promise<number> {
  const fkColumns = new Map(detail.relations.map((r) => [r.sourceColumn, r]));
  // One COLUMN item per column in the DataView, in catalog order
  // (DataViews.md §3.2) - a fresh DataView is already usable before anyone
  // opens the Design form. Stacked one per row (grid_w 12), like its record form (§6.3).


  let visibleIndex = 0;
  for (const column of detail.columns) {
    const presence = options.presence(column);
    if (!presence) continue;
    const override = options.fieldOverrides?.[column.name];
    const fk = fkColumns.get(column.name) ?? null;
    const seeded = columnWidget(column, fk, detail.checkConstraints, inputs);
    const widget = override?.widget ?? seeded.widget;
    const visible = presence === "shown";
    // The stored widget's own config only belongs to THAT widget - an
    // override that picked a different one starts clean instead. Its
    // presentation is inherited live (DataViews.md §15), never copied.
    const seededConfig = seeded.widget === widget ? withoutPresentation(seeded.config) : {};
    // The wizard's help text is the form field's (recordPageColumns), not a grid column's.
    const config: Record<string, unknown> = { ...seededConfig };
    // Same DB-derived locks the Design form's own `columnConstraintsFor`
    // (field-config.ts) computes live and re-persists on every field
    // save - set here too so a fresh DataView reads correctly (required
    // asterisk, disabled state) from the moment it's created, not only
    // once someone happens to open the Design form and save that one
    // field (the real bug this fixed - see the chat).
    if (!column.nullable) config.required = true;
    if (column.isIdentity || column.isGenerated) config.disabled = true;
    // What the type says about its format is read live, never stored (withLiveColumnFacts).
    // A new record may leave it empty - PostgreSQL fills in the DEFAULT (the admin's `config.dbDefault`).
    if (column.defaultExpression !== null) config.dbDefault = true;
    // A foreign key's column shows the row it points at, not its key -
    // what its table says, inherited live (withLiveColumnFacts), until it sets its own.

    // A hidden field's grid position is never rendered (the Design
    // form's palette doesn't care about it, and DataViewRecordPanel
    // skips non-visible fields entirely) - only visible fields
    // consume a slot in the layout.
    const gridW = 12;
    const gridX = 0;
    const gridY = visibleIndex;
    if (visible) visibleIndex++;

    await client.query(
      `INSERT INTO totalbase.dataviews_fields
         (dataview, kind, column_attnum, column_name, widget, visible, config, grid_x, grid_y, grid_w, grid_h)
       VALUES ($1, 'COLUMN', $2, $3, $4, $5, $6, $7, $8, $9, 1)`,
      [dataviewId, column.attnum, column.name, widget, visible, JSON.stringify(config), gridX, gridY, gridW],
    );
  }
  // Every column the table has now is known: Sync columns adds only the ones created after (syncFields).
  await client.query(
    `UPDATE totalbase.dataviews SET view_config = coalesce(view_config, '{}'::jsonb) || jsonb_build_object('last_attnum', $2::int) WHERE id = $1`,
    [dataviewId, lastAttnum(detail)],
  );
  return visibleIndex;
}

/**
 * The columns a generated record form edits (DataViews.md §6.2) - the ones the
 * wizard kept, each with its label and input - one PostgreSQL fills on its own
 * (`writtenByPostgres`) shown only once the record exists, never to type on a new one; a
 * foreign key's select gets its options from a Resource of its target
 * table - its key and first text column - when the Data API can read it;
 * a text column whose CHECK is a list (`IN (...)`) gets a select of those
 * values.
 */
export async function recordPageColumns(
  ctx: DataViewsContext,
  detail: RelationDetail,
  inputs: Map<string, string>,
  // No title of their own: each field inherits its column's (DataViews.md §15).
  choose: { include: (column: string) => boolean; widget?: (column: string) => string | undefined; help?: (column: string) => string | undefined },
  /** Variable names the page already has - a foreign key's options variable takes another. */
  reserved: readonly string[] = [],
): Promise<RecordPageColumn[]> {
  const columns: RecordPageColumn[] = [];
  const taken: string[] = [...reserved];
  const checks = detail.checkConstraints.map((c) => c.expression);
  for (const column of detail.columns) {
    if (!choose.include(column.name)) continue;
    // Bytes have no input (DataViews.md §6.2): left out of the form - a file column is a foreign key to the files.
    if (column.dataType.toLowerCase() === "bytea") continue;
    const fk = detail.relations.find((r) => r.sourceColumn === column.name) ?? null;
    const override = choose.widget?.(column.name);
    const values = fk ? null : checkConstraintValues(column.name, checks);
    // Its column's input (DataViews.md §15.2) - followed, unless the author picked another.
    const own = columnFormInput({
      name: column.name,
      dataType: column.dataType,
      foreignKey: fk,
      checks: detail.checkConstraints,
      input: inputs.get(column.name),
    }).widget;
    const widget: WidgetName = override && isWidgetName(override) ? override : own;
    const entry: RecordPageColumn = { name: column.name, label: "", widget, ...(widget === own && { fromColumn: true }) };
    const help = choose.help?.(column.name)?.trim();
    if (help) entry.help = help;
    if (writtenByPostgres(column, detail.primaryKey)) entry.filledByPostgres = true;
    if (values && takesOptions(widget)) entry.values = values;
    if (fk && takesOptions(widget)) {
      const target = await relationLabel(ctx, fk);
      if (target) {
        const variable = variableNameFor(fk.targetTable, taken);
        taken.push(variable);
        entry.options = { resource: target.resource, valueKey: fk.targetColumn, labelKey: target.labelKey, variable, ...(target.template && { template: target.template }) };
      }
    }
    columns.push(entry);
  }
  return columns;
}

/**
 * What names a row a foreign key points at - its target's resource (when
 * the Data API can read it) and the column shown for it: its table's row
 * presentation (§15.5 - a template's first column), else the default
 * column (`defaultDisplayColumn`). A generated form's select lists it.
 */
export async function relationLabel(ctx: DataViewsContext, fk: RelationDetail["relations"][number]): Promise<{ resource: string; labelKey: string; template?: string } | null> {
  const related = await relatedTable(ctx, fk);
  if (!related) return null;
  const { rows } = await ctx.database.query<{ row_presentation: RowPresentation }>(
    `SELECT row_presentation FROM totalbase.resources WHERE id = $1`,
    [related.resource],
  );
  const row = rows[0]?.row_presentation ?? {};
  const template = row.displayTemplate?.trim() || undefined;
  const own = template ? templateColumns(template)[0] : row.displayField;
  return { resource: related.resource, labelKey: own ?? defaultDisplayColumn(related.detail, fk.targetColumn), ...(template && { template }) };
}

/** The table a foreign key points at - its resource and catalog - when the Data API can read it. */
export async function relatedTable(ctx: DataViewsContext, fk: RelationDetail["relations"][number]): Promise<{ resource: string; detail: RelationDetail } | null> {
  const { rows } = await ctx.database.query<{ id: string; postgres_oid: number }>(
    `SELECT id, postgres_oid FROM totalbase.resources
     WHERE "schema" = $1 AND name = $2 AND type IN ('TABLE', 'VIEW') AND status = 'ACTIVE' AND 'GET' = ANY(exposed_methods)`,
    [fk.targetSchema, fk.targetTable],
  );
  if (!rows[0]) return null;
  return { resource: rows[0].id, detail: await getRelationDetail(ctx.database, rows[0].postgres_oid) };
}

/**
 * A Kanban's or a Gantt's lanes are the rows of the table its Group by
 * points at: their order and color come from that table when it has a
 * number column named position/sort_order/display_order/order and a text
 * column named color - filled in at creation unless the layout names them.
 * A Gantt's progress column likewise: a number column named progress/
 * percent_complete/completion.
 */
export async function fillLaneColumns(ctx: DataViewsContext, viewConfig: Record<string, unknown>, detail: RelationDetail): Promise<void> {
  for (const key of ["kanban_layout", "gantt_layout"]) {
    const layout = viewConfig[key] as Record<string, unknown> | undefined;
    if (!layout || typeof layout !== "object") continue;
    // A Gantt's bars fill up to a numeric progress column, when the table has one.
    if (key === "gantt_layout" && typeof layout.progressColumn !== "string") {
      const progress = ["progress", "percent_complete", "completion", "progreso", "avance", "porcentaje"]
        .map((name) => detail.columns.find((c) => c.name.toLowerCase() === name && isNumericDataType(c.dataType)))
        .find(Boolean);
      if (progress) layout.progressColumn = progress.name;
    }
    const fk = detail.relations.find((r) => r.sourceColumn === layout.groupColumn);
    if (!fk || (typeof layout.laneOrderColumn === "string" && typeof layout.laneColorColumn === "string")) continue;
    const related = await relatedTable(ctx, fk);
    if (!related) continue;
    const columns = related.detail.columns;
    const order = ["position", "sort_order", "display_order", "order", "orden", "posicion"]
      .map((name) => columns.find((c) => c.name.toLowerCase() === name && isNumericDataType(c.dataType)))
      .find(Boolean);
    const color = columns.find((c) => c.name.toLowerCase() === "color" && /^(text|character varying|character|citext)/.test(c.dataType));
    if (typeof layout.laneOrderColumn !== "string" && order) layout.laneOrderColumn = order.name;
    if (typeof layout.laneColorColumn !== "string" && color) layout.laneColorColumn = color.name;
  }
}

/**
 * A TREE's layout (DataViews.md §5.14): its parent column is a foreign key of the table to itself -
 * filled in when not named (the first one), refused when it isn't one. Its order column is the author's choice -
 * never guessed from a name.
 */
export async function fillTreeLayout(ctx: DataViewsContext, viewConfig: Record<string, unknown>, detail: RelationDetail, sourceId: string, required: boolean): Promise<void> {
  const { rows } = await ctx.database.query<{ schema: string; name: string }>(`SELECT "schema", name FROM totalbase.resources WHERE id = $1`, [sourceId]);
  const source = rows[0];
  const selfReferences = detail.relations.filter((r) => source && r.targetSchema === source.schema && r.targetTable === source.name);
  const layout = (viewConfig.tree_layout && typeof viewConfig.tree_layout === "object" ? viewConfig.tree_layout : {}) as Record<string, unknown>;
  if (typeof layout.parentColumn !== "string" && selfReferences[0]) layout.parentColumn = selfReferences[0].sourceColumn;
  if (!selfReferences.some((r) => r.sourceColumn === layout.parentColumn)) {
    if (!required && layout.parentColumn === undefined) return;
    throw new TotalBaseError("DATAVIEW_VIEW_CONFIG_INVALID", "A tree needs a foreign key of its table to itself (its parent) - tree_layout.parentColumn.");
  }
  if (typeof layout.orderColumn === "string") {
    const order = detail.columns.find((c) => c.name === layout.orderColumn);
    if (!order || !isNumericDataType(order.dataType)) throw new TotalBaseError("DATAVIEW_VIEW_CONFIG_INVALID", "A tree's order column is a number column of its table - tree_layout.orderColumn.");
  }
  viewConfig.tree_layout = layout;
}

/** Writes a generated page: its widgets (each through the widget catalog's checks), its variables and its Code. */
/** Generated widgets placed under `parent` (null: the page's top level) from row `firstRow` on, their own children below them. */
async function insertWidgets(
  client: Queryable,
  dataviewId: string,
  widgets: readonly GeneratedWidget[],
  place: { parent: string | null; slot: string | undefined; firstRow: number },
  refs: Parameters<typeof assertWidgetConfigValid>[2],
): Promise<void> {
  for (const [order, widget] of widgets.entries()) {
    const config: WidgetFieldConfig = { props: widget.props, bindings: widget.bindings ?? {}, emits: widget.emits ?? {}, ...(place.slot ? { slot: place.slot } : {}), ...(widget.fromColumn && { fromColumn: true }) };
    assertWidgetConfigValid(widget.widget, config, refs);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO totalbase.dataviews_fields (dataview, kind, widget, label, config, parent, grid_x, grid_y, grid_w, grid_h, related_dataview, related_dashboard)
       VALUES ($1, 'WIDGET', $2, $3, $4::jsonb, $5, 0, $6, $7, $8, $9, $10)
       RETURNING id`,
      [dataviewId, widget.widget, widget.name ?? null, JSON.stringify(config), place.parent, place.firstRow + order, widget.width, widget.height ?? 1, widgetRelatedDataview(widget.widget, config), widgetRelatedDashboard(widget.widget, config)],
    );
    for (const [slotName, children] of Object.entries(widget.slots ?? {})) await insertWidgets(client, dataviewId, children, { parent: rows[0]!.id, slot: slotName, firstRow: 0 }, refs);
  }
}

export async function insertGeneratedPage(ctx: DataViewsContext, client: Queryable, dataviewId: string, page: GeneratedPage): Promise<void> {
  assertVariablesValid(page.variables);
  const refs = page.variables.map((v) => ({ name: v.name, kind: v.kind }));
  await insertWidgets(client, dataviewId, page.widgets, { parent: null, slot: undefined, firstRow: 0 }, refs);
  await client.query(
    `UPDATE totalbase.dataviews
     SET view_config = view_config || jsonb_build_object('variables', $2::jsonb), code = $3
     WHERE id = $1`,
    [dataviewId, JSON.stringify(page.variables), page.code],
  );
}

/**
 * A column added to the table later, into a generated record form (DataViews.md §4.2, "Add them shown"): its form
 * field after the form's last one - before a Master-detail's Detail - with the input its column takes, as the
 * form was generated (`fromColumn`), and a foreign key's options variable beside the page's. A page with no
 * generated form (a CUSTOM page, a form someone rebuilt without one named `form`), or a column already in it,
 * gets nothing. Returns the columns placed.
 */
export async function appendFormFields(ctx: DataViewsContext, dataviewId: string, detail: RelationDetail, inputs: Map<string, string>, columnNames: readonly string[]): Promise<string[]> {
  const { rows: forms } = await ctx.database.query<{ id: string }>(
    `SELECT id FROM totalbase.dataviews_fields WHERE dataview = $1 AND kind = 'WIDGET' AND widget = 'UForm' AND parent IS NULL AND label = 'form'`,
    [dataviewId],
  );
  const form = forms[0];
  if (!form) return [];
  const { rows: children } = await ctx.database.query<{ id: string; widget: string; grid_y: number; column: string | null }>(
    `SELECT id, widget, grid_y, config->'props'->>'column' AS column FROM totalbase.dataviews_fields WHERE dataview = $1 AND parent = $2`,
    [dataviewId, form.id],
  );
  const bound = new Set(children.map((c) => c.column).filter((c): c is string => c !== null));
  const wanted = columnNames.filter((name) => !bound.has(name));
  if (wanted.length === 0) return [];

  const { rows: dataviews } = await ctx.database.query<{ variables: VariableDefinition[] | null }>(
    `SELECT view_config->'variables' AS variables FROM totalbase.dataviews WHERE id = $1`,
    [dataviewId],
  );
  const variables = Array.isArray(dataviews[0]?.variables) ? dataviews[0]!.variables : [];
  const columns = await recordPageColumns(ctx, detail, inputs, { include: (column) => wanted.includes(column) }, variables.map((v) => v.name));
  if (columns.length === 0) return [];
  const page = generateRecordPage({ type: "GRID", columns });
  const fields = page.widgets[0]!.slots!["default"]!;
  const allVariables = [...variables, ...page.variables];
  assertVariablesValid(allVariables);

  // After the last form field: whatever follows them (a Master-detail's Detail) moves down.
  const firstRow = Math.max(-1, ...children.filter((c) => c.widget === "UFormField").map((c) => c.grid_y)) + 1;
  await ctx.database.transaction(async (client) => {
    await client.query(
      `UPDATE totalbase.dataviews_fields SET grid_y = grid_y + $3 WHERE dataview = $1 AND parent = $2 AND grid_y >= $4`,
      [dataviewId, form.id, fields.length, firstRow],
    );
    await insertWidgets(client, dataviewId, fields, { parent: form.id, slot: "default", firstRow }, allVariables.map((v) => ({ name: v.name, kind: v.kind })));
    if (page.variables.length > 0) {
      await client.query(`UPDATE totalbase.dataviews SET view_config = view_config || jsonb_build_object('variables', $2::jsonb) WHERE id = $1`, [dataviewId, JSON.stringify(allVariables)]);
    }
  });
  return columns.map((c) => c.name);
}
