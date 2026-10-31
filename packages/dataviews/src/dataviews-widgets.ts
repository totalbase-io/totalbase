import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { UUID_PATTERN } from "@totalbase/shared";
import { parseFilter } from "@totalbase/query-engine";
import { defaultWidgetWidth, isWidgetName, LIST_VIEW_TYPES, slotBase, widgetDefinition, type TableCallAction, type VariableDefinition, type WidgetName } from "@totalbase/tb-catalog";
import { assertWidgetConfigValid, assertWidgetName, assertWidgetPlacement, assertWidgetWidth, variableRefs, widgetRelatedDashboard, widgetRelatedDataview, type WidgetFieldConfig } from "./widget-fields.js";
import { isPageViewType, type AddWidgetInput, type AddWidgetTreeInput, type AdminDataView, type AdminDataViewField, type DataViewFieldRow, type DataViewsContext, type UpdateFieldInput } from "./dataviews-types.js";
import { getDataView } from "./dataviews-read.js";
import { getField, listFields, updateFieldOn } from "./dataviews-fields.js";

/** Limits a variable's `where` is parsed with at design time - the Data API applies the configured ones (api.max_filter_depth) when it runs. */
export const VARIABLE_FILTER_LIMITS = { maxFilterDepth: 10, maxRelationDepth: 3 };

/** The Data API method a table Call uses - the resource must be exposed for it. */
export const TABLE_CALL_METHODS: Record<TableCallAction, string> = { CREATE: "POST", UPDATE: "PATCH", DELETE: "DELETE" };

/**
 * Moves a placed widget, with what its slots hold, to another place on
 * the page in one transaction (the agent's move_page_widget, otherwise
 * one PATCH per sibling): `parent`/`slot` where given (omitted: where it
 * is; `parent` null: the page itself), checked like any widget patch
 * (`assertWidgetPatch`: the slot takes it, never inside itself), then its
 * area renumbered - every sibling's `grid_y` its position in order, the
 * widget at `position` (omitted: last) - in one UPDATE. Answers the
 * page's fields as they are after it.
 */
export async function moveWidget(ctx: DataViewsContext, dataviewId: string, fieldId: string, move: { parent?: string | null | undefined; slot?: string | undefined; position?: number | undefined }): Promise<AdminDataViewField[]> {
  await ctx.database.transaction(async (client) => {
    const { rows } = await client.query<{ parent: string | null; config: WidgetFieldConfig }>(
      `SELECT parent, config FROM totalbase.dataviews_fields WHERE id = $1 AND dataview = $2 AND kind = 'WIDGET' FOR UPDATE`,
      [fieldId, dataviewId],
    );
    const field = rows[0];
    if (!field) throw new TotalBaseError("DATAVIEW_FIELD_NOT_FOUND", `Field not found: ${fieldId}`);
    const parentId = move.parent === undefined ? field.parent : move.parent;
    // The slot named, else the one it is in when it stays in its parent - a new parent's slot is the caller's to name.
    const slot = move.slot ?? (move.parent === undefined || move.parent === field.parent ? field.config.slot : undefined);
    if (parentId !== field.parent || slot !== field.config.slot) {
      const { slot: _previous, ...rest } = field.config;
      await updateFieldOn(ctx, client, dataviewId, fieldId, { parent: parentId, config: { ...rest, ...(slot ? { slot } : {}) } });
    }
    const { rows: area } = await client.query<{ id: string }>(
      `SELECT id FROM totalbase.dataviews_fields
       WHERE dataview = $1 AND kind = 'WIDGET' AND id <> $2 AND parent IS NOT DISTINCT FROM $3::uuid AND coalesce(config->>'slot', '') = $4
       ORDER BY grid_y, grid_x, id`,
      [dataviewId, fieldId, parentId, slot ?? ""],
    );
    const order = area.map((row) => row.id);
    order.splice(Math.min(move.position ?? order.length, order.length), 0, fieldId);
    await client.query(
      `UPDATE totalbase.dataviews_fields f
       SET grid_y = o.position - 1, updated_at = now()
       FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, position)
       WHERE f.id = o.id AND f.dataview = $1 AND f.grid_y IS DISTINCT FROM o.position - 1`,
      [dataviewId, order],
    );
  });
  return listFields(ctx, dataviewId);
}

/**
 * Places one widget of the widget catalog (a `WIDGET` field) - on the
 * canvas, or in a slot of another widget (`parent` + `config.slot`).
 * Appended below its siblings; the Design form moves it from there.
 */
export async function addWidget(ctx: DataViewsContext, dataviewId: string, input: AddWidgetInput): Promise<AdminDataViewField> {
  return addWidgetOn(ctx, ctx.database, dataviewId, input);
}

/**
 * Places several widgets, each with what it holds (`children`, in its
 * slots), in one transaction: all placed, or none - a refused child (an
 * unknown prop, a slot that doesn't take it) leaves no half-built form
 * behind. Each is appended after its siblings, in the order given.
 * Answers every placed field, parents before their children.
 */
export async function addWidgets(ctx: DataViewsContext, dataviewId: string, inputs: AddWidgetTreeInput[]): Promise<AdminDataViewField[]> {
  const placed: AdminDataViewField[] = [];
  await ctx.database.transaction(async (client) => {
    const place = async (input: AddWidgetTreeInput, parent: string | null): Promise<void> => {
      const { children, ...own } = input;
      const field = await addWidgetOn(ctx, client, dataviewId, { ...own, parent });
      placed.push(field);
      for (const child of children ?? []) await place(child, field.id);
    };
    for (const input of inputs) await place(input, input.parent ?? null);
  });
  return placed;
}

/** `addWidget` on `on` - the pool, or the transaction `addWidgets` places a whole tree in. */
export async function addWidgetOn(ctx: DataViewsContext, on: Queryable, dataviewId: string, input: AddWidgetInput): Promise<AdminDataViewField> {
  const dataview = await getDataView(ctx, dataviewId);
  if (!isPageViewType(dataview.viewType)) {
    throw new TotalBaseError("DATAVIEW_WIDGET_NOT_ALLOWED", "An external frame has no page to place widgets on.");
  }
  assertWidgetName(input.widget);
  if (input.gridW !== undefined) assertWidgetWidth(input.widget, input.gridW);
  // A widget placed here starts as the Design form places it: the catalog's defaults (a Tabs' two tabs) under what was sent.
  const defaults = widgetDefinition(input.widget).defaults;
  const config: WidgetFieldConfig = defaults ? { ...input.config, props: { ...defaults, ...input.config?.props } } : input.config ?? {};
  assertWidgetConfigValid(input.widget, config, variableRefs(dataview.viewConfig), await ctx.ownOrigin());
  await assertEmbeddable(ctx, input.widget, config);
  const parentId = input.parent ?? null;
  const parent = parentId ? await widgetParent(ctx, dataviewId, parentId, on) : null;
  assertWidgetPlacement(parent, config.slot, input.widget, dataview.viewType);
  if (parentId && parent) await assertInputSlotFree(ctx, dataviewId, parentId, parent.widget, config.slot, null, on);

  const { rows: yRows } = await on.query<{ next: number }>(
    // Widgets lay out in flow (DataViews.md §12.2): grid_y is only an order.
    `SELECT coalesce(max(grid_y) + 1, 0) AS next FROM totalbase.dataviews_fields
     WHERE dataview = $1 AND kind = 'WIDGET' AND parent IS NOT DISTINCT FROM $2::uuid AND coalesce(config->>'slot', '') = $3`,
    [dataviewId, parentId, config.slot ?? ""],
  );
  const { rows } = await on.query<DataViewFieldRow>(
    `INSERT INTO totalbase.dataviews_fields (dataview, kind, widget, label, config, parent, grid_x, grid_y, grid_w, grid_h, related_dataview, related_dashboard)
     VALUES ($1, 'WIDGET', $2, $3, $4::jsonb, $5, 0, $6, $9, $10, $7, $8)
     RETURNING *`,
    [dataviewId, input.widget, input.label ?? null, JSON.stringify(config), parentId, yRows[0]?.next ?? 0, widgetRelatedDataview(input.widget, config), widgetRelatedDashboard(input.widget, config), input.gridW ?? defaultWidgetWidth(input.widget), input.gridH ?? 1],
  );
  return getField(ctx, dataviewId, rows[0]!.id, on);
}

/**
 * What the variable catalog can't know (it's plain data): a Resource's
 * resource is an active table or view exposed for GET and its `where`
 * parses; a Call's function is an active, exposed FUNCTION and its
 * workflow a MANUAL one. For the author - the Data API and the
 * function/workflow routes still check every permission when it runs.
 * Assumes `assertVariablesValid` passed (the shapes are right).
 */
export async function assertVariablesInDatabase(ctx: DataViewsContext, variables: unknown): Promise<void> {
  const errors: string[] = [];
  for (const variable of variables as VariableDefinition[]) {
    if (variable.kind === "RESOURCE") {
      const { rows } = await ctx.database.query<{ type: string; status: string; exposed_methods: string[] }>(
        `SELECT type, status, exposed_methods FROM totalbase.resources WHERE id = $1`,
        [variable.resource],
      );
      const resource = rows[0];
      if (!resource || !["TABLE", "VIEW"].includes(resource.type) || resource.status !== "ACTIVE") {
        errors.push(`${variable.name}: the resource isn't an active table or view.`);
      } else if (!resource.exposed_methods.includes("GET")) {
        errors.push(`${variable.name}: the resource isn't exposed for reading (GET).`);
      }
      if (variable.query.where !== undefined) {
        try {
          parseFilter(variable.query.where, VARIABLE_FILTER_LIMITS, 0);
        } catch (error) {
          errors.push(`${variable.name}: the filter isn't valid - ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else if (variable.kind === "CALL" && variable.target.type === "FUNCTION") {
      const { rows } = await ctx.database.query<{ type: string; status: string; exposed_methods: string[] }>(
        `SELECT type, status, exposed_methods FROM totalbase.resources WHERE id = $1`,
        [variable.target.resource],
      );
      const fn = rows[0];
      if (!fn || fn.type !== "FUNCTION" || fn.status !== "ACTIVE") errors.push(`${variable.name}: the function doesn't exist.`);
      else if (!fn.exposed_methods.includes("POST")) errors.push(`${variable.name}: the function isn't exposed.`);
    } else if (variable.kind === "CALL" && variable.target.type === "TABLE") {
      const method = TABLE_CALL_METHODS[variable.target.action];
      const { rows } = await ctx.database.query<{ type: string; status: string; exposed_methods: string[] }>(
        `SELECT type, status, exposed_methods FROM totalbase.resources WHERE id = $1`,
        [variable.target.resource],
      );
      const table = rows[0];
      if (!table || table.type !== "TABLE" || table.status !== "ACTIVE") errors.push(`${variable.name}: the table doesn't exist.`);
      else if (!table.exposed_methods.includes(method)) errors.push(`${variable.name}: the table isn't exposed for ${method}.`);
    } else if (variable.kind === "CALL" && variable.target.type === "WORKFLOW") {
      const { rows } = await ctx.database.query<{ trigger: string | null }>(
        `SELECT (SELECT op->'configuration'->>'trigger' FROM jsonb_array_elements(definition->'operations') op
                 WHERE op->>'type' = 'totalbase.start' LIMIT 1) AS trigger
         FROM totalbase.workflows WHERE id = $1`,
        [UUID_PATTERN.test(variable.target.workflow) ? variable.target.workflow : null],
      );
      if (!rows[0]) errors.push(`${variable.name}: the workflow doesn't exist.`);
      else if (rows[0].trigger !== "MANUAL") errors.push(`${variable.name}: only a MANUAL workflow runs from a page, as the viewer.`);
    }
  }
  if (errors.length > 0) throw new TotalBaseError("DATAVIEW_VARIABLES_INVALID", errors.join("\n"));
}

/** A candidate parent row for a widget, or DATAVIEW_WIDGET_SLOT_INVALID when it isn't in this DataView. */
export async function widgetParent(ctx: DataViewsContext, dataviewId: string, parentId: string, on: Queryable = ctx.database): Promise<{ kind: string; widget: string | null }> {
  const { rows } = await on.query<{ kind: string; widget: string | null }>(
    `SELECT kind, widget FROM totalbase.dataviews_fields WHERE id = $1 AND dataview = $2`,
    [parentId, dataviewId],
  );
  if (!rows[0]) throw new TotalBaseError("DATAVIEW_WIDGET_SLOT_INVALID", `No such parent widget in this DataView: ${parentId}`);
  return rows[0];
}

/**
 * A `WIDGET` field's patch: its config against the widget and the
 * DataView's variables, its placement (parent + slot) against the parent
 * widget's slots - and never inside itself or its own descendants.
 */
/**
 * An embedded DataView (TDataView) shows a list - a grid, cards, a map, a
 * board, a calendar or a timeline - never a page (a Custom page, a Form, a
 * Master-detail): a page could embed itself, or one embedding it back. Its
 * View is one that DataView offers (its view_type or its `layouts`).
 */
export async function assertEmbeddable(ctx: DataViewsContext, widget: WidgetName, config: WidgetFieldConfig): Promise<void> {
  if (widget !== "TDataView") return;
  const target = widgetRelatedDataview(widget, config);
  if (!target) return;
  const { rows } = await ctx.database.query<{ view_type: string; layouts: unknown }>(
    `SELECT view_type, view_config->'layouts' AS layouts FROM totalbase.dataviews WHERE id = $1`,
    [target],
  );
  const row = rows[0];
  if (!row) return;
  if (!(LIST_VIEW_TYPES as readonly string[]).includes(row.view_type)) {
    throw new TotalBaseError("DATAVIEW_WIDGET_INVALID", "An embedded DataView is a list - a table, cards, a map, a board, a calendar, a timeline or a tree, not a page.");
  }
  const view = config.props?.view;
  const offered = [row.view_type, ...(Array.isArray(row.layouts) ? row.layouts : [])];
  if (typeof view === "string" && !offered.includes(view)) {
    throw new TotalBaseError("DATAVIEW_WIDGET_INVALID", `That DataView doesn't offer the ${view} view - it offers ${[...new Set(offered)].join(", ")}.`);
  }
}

export async function assertWidgetPatch(ctx: DataViewsContext, dataview: AdminDataView, fieldId: string, patch: UpdateFieldInput, row: { widget: string | null; parent: string | null; config: WidgetFieldConfig }, on: Queryable = ctx.database): Promise<void> {
  assertWidgetName(row.widget);
  let widget: WidgetName = row.widget;
  // A form field's input is switched in place - one input per field, never two for a moment (§12.6).
  if (patch.widget !== undefined) {
    const holder = row.parent ? await widgetParent(ctx, dataview.id, row.parent, on) : null;
    const holdsInput = holder?.widget && isWidgetName(holder.widget) && widgetDefinition(holder.widget).slots[slotBase(row.config.slot ?? "")]?.holds === "input";
    if (!holdsInput) throw new TotalBaseError("DATAVIEW_WIDGET_INVALID", "A placed widget keeps its widget - delete it and place another (only a form field's input is switched).");
    if (!isWidgetName(patch.widget) || !widgetDefinition(patch.widget).formField) throw new TotalBaseError("DATAVIEW_WIDGET_INVALID", `A form field holds an input, not ${patch.widget}.`);
    widget = patch.widget;
  }
  if (patch.gridW !== undefined) assertWidgetWidth(widget, patch.gridW);
  const config = (patch.config ?? row.config) as WidgetFieldConfig;
  if (patch.config !== undefined || patch.widget !== undefined) {
    assertWidgetConfigValid(widget, config, variableRefs(dataview.viewConfig), await ctx.ownOrigin());
    await assertEmbeddable(ctx, widget, config);
  }
  if (patch.parent === undefined && patch.config === undefined) return;
  const parentId = patch.parent !== undefined ? patch.parent : row.parent;
  if (parentId !== null) {
    const { rows: loop } = await on.query<{ inside: boolean }>(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent FROM totalbase.dataviews_fields WHERE id = $1 AND dataview = $3
         UNION ALL
         SELECT f.id, f.parent FROM totalbase.dataviews_fields f JOIN ancestors a ON f.id = a.parent
       )
       SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = $2) AS inside`,
      [parentId, fieldId, dataview.id],
    );
    if (loop[0]?.inside) throw new TotalBaseError("DATAVIEW_WIDGET_SLOT_INVALID", "A widget can't be placed inside itself.");
  }
  const parent = parentId ? await widgetParent(ctx, dataview.id, parentId, on) : null;
  assertWidgetPlacement(parent, config.slot, widget, dataview.viewType);
  if (parentId && parent) await assertInputSlotFree(ctx, dataview.id, parentId, parent.widget, config.slot, fieldId, on);
}

/**
 * A form field holds one input (DataViews.md §12.2): a slot
 * whose catalog entry `holds: "input"` refuses a second widget - placed, or
 * moved in. `fieldId` is the widget being moved, which may already be there.
 */
export async function assertInputSlotFree(ctx: DataViewsContext, dataviewId: string, parentId: string, parentWidget: string | null, slot: string | undefined, fieldId: string | null, on: Queryable = ctx.database): Promise<void> {
  if (!parentWidget || !isWidgetName(parentWidget) || slot === undefined) return;
  const entry = widgetDefinition(parentWidget).slots[slotBase(slot)];
  if (entry?.holds !== "input") return;
  const { rows } = await on.query<{ taken: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM totalbase.dataviews_fields
       WHERE dataview = $1 AND parent = $2 AND coalesce(config->>'slot', '') = $3 AND id IS DISTINCT FROM $4::uuid
     ) AS taken`,
    [dataviewId, parentId, slot, fieldId],
  );
  if (rows[0]?.taken) {
    throw new TotalBaseError("DATAVIEW_WIDGET_SLOT_INVALID", `${widgetDefinition(parentWidget).label}'s ${entry.label} already holds its input - one input per field.`);
  }
}
